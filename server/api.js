// server/api.js — 「说方言」的后端接口
//
// 页面是静态的，所以数据靠这几个接口拿。四件事：
//   GET  /api/state        一次拿全：配置 + 方言清单 + 伙伴名单 + 当前写入状态
//   POST /api/dialect      保存方言配置（整表替换）并同步写入人格文件
//   GET  /api/consent      是否已经确认过「会改人格文件」
//   POST /api/consent      记下确认
//   GET  /api/dialect-log  变更日志（排查用）
//   GET  /api/bias         某个伙伴的表情气质权重（给别的应用联动用）
//
// 写人格文件失败时不能吞掉：配置写成功、人格写失败，要把失败原因报回去，
// 否则界面上只显示「已保存」，用户却发现 ta 说话没变味。

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DIALECT_LIST } from '../lib/dialect-data.js';
import { readDialectConfig, writeDialectConfig, appendDialectLog, readDialectLog } from '../lib/dialect-config.js';
import { syncDialectToPersona, resolveAgentsRoot, readDialectFromPersona, applyDialectToPersona, agentPersonaFilePath } from '../lib/dialect-persona.js';
import { listAgents, refreshAgentsFromHostDetailed, adoptAgentIds } from '../lib/agents.js';
import { applyVisibility, setAgentHidden } from '../lib/roster-visibility.js';
import { listDirNames, personaFileExists } from '../lib/persona-io.js';
import { readStyleTemplate, confirmStyleDraft, revertStyleTemplate, clearStyleTemplate, currentTemplateText, styleVersionId, keepCurrentStyleDraft } from '../lib/style-template.js';
import { readConsent, acceptConsent } from '../lib/consent.js';
import { runStyleSummary } from '../lib/style-distill.js';
import { ensureHostModelCatalog } from '../lib/model-host.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function dialectMeta() {
  return DIALECT_LIST.map((d) => ({
    id: d.id,
    name: d.name,
    people: d.people,
    tagline: d.tagline,
    // 给界面做例句预览用：一句就够，多了反而显乱。
    example: Array.isArray(d.examples) && d.examples.length ? String(d.examples[0]) : '',
  }));
}

/**
 * 伙伴名册：缓存 → 宿主 → （宿主明确不可用且手上没缓存时）列目录兜底。
 *
 * 三档都空的时候把 source 报给页面，页面上就能说清「卡在哪一档」，
 * 而不是一句含糊的「宿主那边没给出伙伴名单」。
 *
 * refresh=true 是「明确重取」：
 *   · 一定去宿主重拉一次，不看缓存
 *   · 拉成功但名单为空 → 缓存清空，名单就是空。绝不回落列目录 ——
 *     目录里还留着退休的、探针用的人格文件，落下去就把僵尸伙伴带回来了
 *   · 宿主失败 → 保留最近一次名单，并把失败原因显式报出去（refreshError），
 *     同样不回落目录（回落了就等于刷新冒充成功）
 */
async function resolveAgentList({ refresh = false } = {}) {
  const cached = listAgents();
  if (!refresh && cached.length) {
    return { agents: cached, source: 'cache', refreshError: null };
  }

  const res = await refreshAgentsFromHostDetailed();
  if (res.ok) {
    // 成功就是权威答案：空名单也是答案，缓存已经清空了。
    return { agents: listAgents(), source: 'host', refreshError: null };
  }

  // 宿主不可用。
  if (refresh || cached.length) {
    // 刷新失败：留最近一次名单 + 显式错误，不拿目录冒充刷新成功。
    // （cached.length 那条分支只可能发生在 refresh=true 时：没刷新时缓存非空早就返回了。）
    return {
      agents: cached,
      source: cached.length ? 'cache' : 'none',
      refreshError: res.error,
    };
  }

  // 初次状态：宿主明确不可用且手上没缓存，才允许列目录兜底。
  // 这条路上不报 refreshError：普通请求不该因为宿主拉不到就整体失败。
  try {
    const root = await resolveAgentsRoot();
    const names = await listDirNames(path.join(root, 'agents'));
    const valid = [];
    for (const name of names) {
      if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
      try {
        if (await personaFileExists(await agentPersonaFilePath(name, root))) valid.push(name);
      } catch { /* 单个伙伴算不出来就跳过 */ }
    }
    adoptAgentIds(valid);
    const fromDir = listAgents();
    if (fromDir.length) return { agents: fromDir, source: 'dir', refreshError: null };
  } catch { /* 目录也列不出来，往下报空 */ }

  return { agents: [], source: 'none', refreshError: null };
}

export default function registerApi(app, sdk) {
  const log = (level, ...args) => {
    try {
      sdk?.logger?.[level]?.(...args);
    } catch { /* 日志打不出去也不能影响主流程 */ }
  };

  app.get('/api/state', async (c) => {
    try {
      const config = readDialectConfig();
      // refresh=1：明确重取一次有效 host 名单（不认缓存）。
      const url = c?.req?.url ? new URL(c.req.url, 'http://localhost') : null;
      const refresh = url?.searchParams?.get('refresh') === '1';
      const { agents, source, refreshError } = await resolveAgentList({ refresh });
      if (!agents.length) log('warn', '[说方言] 伙伴名单三档全空（缓存/宿主/目录）');
      if (refreshError) log('warn', `[说方言] 刷新伙伴名单失败：${refreshError}`);
      // 每个伙伴人格文件里现在实际是什么方言 —— 用来核对配置和人格有没有漂。
      const agentsRoot = await resolveAgentsRoot();
      const actual = {};
      for (const agent of agents) {
        const read = await readDialectFromPersona(agent.id, { agentsRoot });
        actual[agent.id] = read.ok ? read.dialect : null;
      }
      // 模型通道：「学我说话」要调模型。这里是只读探测，不花钱，
      // 只告诉页面「现在到底能不能总结」，免得点了才报“没模型”。
      const models = await ensureHostModelCatalog(sdk);
      // 界面上只显示没被藏起来的；藏起来的那几位另外给一份（含显示备份名）。
      const view = applyVisibility(agents);
      const payload = {
        ok: true,
        data: {
          config,
          dialects: dialectMeta(),
          agents: view.agents,
          agentSource: source,
          actual,
          modelReady: models.length > 0,
          modelCount: models.length,
          hiddenAgents: view.hiddenAgents,
          consent: readConsent(),
        },
      };
      if (refreshError) {
        // 刷新没成功：把原因摆到明面上，同时把最近一次名单原样带回去。
        // 前端拿到 ok:false 就不动现有名单，只提示一句「刷新失败」。
        return json({ ...payload, ok: false, error: refreshError });
      }
      return json(payload);
    } catch (e) {
      log('error', '[说方言] 读取状态失败:', e?.message || e);
      return json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── 知情确认 ────────────────────────────────────────
  // 写人格文件这件事，用户第一次进来就摆明白，点过才让保存生效。
  // 后端也拦一道：前端那一层是体验，这一层才是保证。
  app.get('/api/consent', () => json({ ok: true, data: readConsent() }));

  app.post('/api/consent', async (c) => {
    try {
      const body = await c.req.json().catch(() => null);
      if (!body || body.accepted !== true) {
        return json({ ok: false, error: '没确认就不记' }, 400);
      }
      const record = acceptConsent();
      log('info', '[说方言] 用户已确认会改人格文件');
      return json({ ok: true, data: record });
    } catch (e) {
      return json({ ok: false, error: e?.message || String(e) }, 500);
    }
  });

  // 变成可撤销操作之前先留痕：保存请求到底有没有到后端，靠这两条日志判断。
  app.post('/api/dialect', async (c) => {
    if (!readConsent().accepted) {
      return json({ ok: false, error: '还没确认过会改人格文件，先在页面上点一下确认。', needConsent: true }, 403);
    }
    log('info', '[说方言] 收到保存请求');
    try {
      const body = await c.req.json();
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json({ ok: false, error: '配置格式不正确' }, 400);
      }
      if (body.agents != null && (typeof body.agents !== 'object' || Array.isArray(body.agents))) {
        return json({ ok: false, error: '伙伴方言配置格式不正确' }, 400);
      }

      const before = readDialectConfig();
      const saved = writeDialectConfig(body);

      // 记变更：新配 / 换方言 / 关闭
      const changed = [];
      const ids = new Set([...Object.keys(before.agents || {}), ...Object.keys(saved.agents || {})]);
      for (const agentId of ids) {
        const from = before.agents?.[agentId]?.dialect || null;
        const to = saved.agents?.[agentId]?.dialect || null;
        if (from !== to) changed.push({ agentId, from: from || '未配置', to: to || '关闭' });
      }

      // 配置与人格必须一起动：配置说开了、人格里没有，就是漂移。
      const results = await syncDialectToPersona(saved);
      const failures = Object.entries(results)
        .filter(([, r]) => !r?.ok)
        .map(([agentId, r]) => ({ agentId, error: r?.error || '写入失败' }));

      if (changed.length) appendDialectLog({ changed, config: saved });

      log('info', `[说方言] 保存完成：配置 ${Object.keys(saved.agents).length} 位，人格写入失败 ${failures.length} 位`
        + (failures.length ? `（${failures.map((f) => `${f.agentId}:${f.error}`).join('；')}）` : ''));

      return json({
        ok: failures.length === 0,
        changed,
        failures,
        results,
        config: saved,
        message: failures.length
          ? '配置已保存，但有几位伙伴的人格文件没写进去'
          : '已写进 ta 的人格文件，下一条消息就带这个味儿，不用重启；想更干净就开个新对话。',
      });
    } catch (e) {
      log('error', '[说方言] 保存方言失败:', e?.message || e);
      return json({ ok: false, error: e?.message || String(e) }, 500);
    }
  });

  // ── 「谁显示谁不显示」─────────────────────────────────────
  // 只动一份独立存档（lib/roster-visibility.js）：
  // 不探测模型、不写人格文件、不写方言配置，方言那套逻辑照旧按宿主名册走。
  app.post('/api/roster-visibility', async (c) => {
    try {
      const body = await c.req.json().catch(() => null);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json({ ok: false, error: '请求格式不正确' }, 400);
      }
      const agentId = String(body.agentId ?? '').trim();
      if (!agentId) return json({ ok: false, error: '得有个伙伴 id' }, 400);
      if (typeof body.hidden !== 'boolean') {
        return json({ ok: false, error: 'hidden 得是 true 或 false' }, 400);
      }
      // 立即按当前缓存名册重算：不去宿主重拉，也不等下一次刷新。
      const roster = listAgents();
      const result = setAgentHidden(agentId, body.hidden, { roster });
      if (!result.ok) return json({ ok: false, error: result.error }, 400);
      const view = applyVisibility(roster);
      log('info', `[说方言] ${body.hidden ? '藏起' : '放回'}伙伴 ${agentId}`);
      return json({ ok: true, data: { agents: view.agents, hiddenAgents: view.hiddenAgents } });
    } catch (e) {
      log('error', '[说方言] 改可见名单失败:', e?.message || e);
      return json({ ok: false, error: e?.message || String(e) }, 500);
    }
  });

  app.get('/api/dialect-log', () => json({ ok: true, data: readDialectLog(20) }));

  // ── 「学我说话」───────────────────────────────────────────
  // 模板是全局的（用户的说话习惯），不属于某一个伙伴；
  // 选了「学我说话」的伙伴共享这一份。

  app.get('/api/style-template', () => {
    try {
      const tpl = readStyleTemplate();
      return json({
        ok: true,
        data: {
          current: tpl.current || '',
          current_at: tpl.current_at || '',
          draft: tpl.draft || '',
          draft_at: tpl.draft_at || '',
          versionCount: (tpl.versions || []).length,
          versions: (tpl.versions || []).map((version) => ({
            id: styleVersionId(version),
            text: String(version?.text || ''),
            at: String(version?.at || ''),
            kind: version?.kind === 'draft' ? 'draft' : 'adopted',
          })),
        },
      });
    } catch (e) {
      return json({ ok: false, error: e?.message || String(e) });
    }
  });

  // App 实例只跑一个任务。页面关闭不影响任务，完成的草稿仍走原有持久化。
  let styleTask = null;
  const taskResponse = (status = 200) => json({ ok: true, data: { task: styleTask } }, status);
  const styleBusy = () => styleTask?.status === 'running';
  const busyResponse = () => json({ ok: false, error: '正在总结，等这次任务结束再编辑模板。' }, 409);
  const phaseNames = { sampling: '取样', distilling: '总结', saving: '保存草稿' };
  app.get('/api/style/summary', () => taskResponse());
  app.post('/api/style/summary', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const agentId = typeof body?.agentId === 'string' ? body.agentId.trim() : '';
    if (!applyVisibility(listAgents()).agents.some((agent) => agent.id === agentId)) {
      return json({ ok: false, error: '请从当前名单选择一位伙伴作为语料来源。' }, 400);
    }
    if (styleBusy()) return taskResponse(202);
    styleTask = { id: randomUUID(), status: 'running', phase: 'sampling' };
    const task = styleTask;
    setImmediate(async () => {
      try {
        const result = await runStyleSummary({ sdk, agentId, userName: '用户', onPhase: (phase) => { task.phase = phase; } });
        if (!result.ok) {
          task.error = `${phaseNames[task.phase]}失败：${result.error}`;
          task.status = 'failed';
          return;
        }
        task.sampleCount = result.sampleCount;
        task.status = 'done';
      } catch {
        log('error', `[说方言] ${phaseNames[task.phase]}阶段异常`);
        task.error = `${phaseNames[task.phase]}失败，请稍后重试。`;
        task.status = 'failed';
      }
    });
    return taskResponse(202);
  });

  // 采用草稿 / 回退 / 清空：改完都要同步到选了「学我说话」的伙伴的人格文件
  const syncUserstyleToPersona = async () => {
    const config = readDialectConfig();
    const results = {};
    for (const [agentId, setting] of Object.entries(config.agents || {})) {
      if (setting?.dialect !== 'userstyle' || setting?.enabled === false) continue;
      results[agentId] = await applyDialectToPersona(agentId, 'userstyle', 'normal', {
        templateResolver: currentTemplateText,
      });
    }
    return results;
  };

  app.post('/api/style-template/keep-current', async () => {
    if (styleBusy()) return busyResponse();
    try {
      const result = keepCurrentStyleDraft();
      if (!result.ok) return json({ ok: false, error: result.error }, 400);
      return json({ ok: true, message: '已保留原版，新稿已存入历史。' });
    } catch (e) {
      return json({ ok: false, error: e?.message || String(e) }, 500);
    }
  });

  app.post('/api/style-template/confirm', async () => {
    if (styleBusy()) return busyResponse();
    try {
      const result = confirmStyleDraft();
      if (!result.ok) return json({ ok: false, error: result.error }, 400);
      const results = await syncUserstyleToPersona();
      const failures = Object.entries(results).filter(([, r]) => !r?.ok);
      return json({
        ok: failures.length === 0,
        template: result.template,
        failures: failures.map(([agentId, r]) => ({ agentId, error: r?.error || '写入失败' })),
        message: failures.length
          ? '模板已采用，但有几位伙伴的人格文件没写进去'
          : '已采用，下一条消息就生效，不用重启。',
      });
    } catch (e) {
      return json({ ok: false, error: e?.message || String(e) }, 500);
    }
  });

  app.post('/api/style-template/revert', async (c) => {
    if (styleBusy()) return busyResponse();
    try {
      const body = await c.req.json().catch(() => ({}));
      const versionId = body && typeof body === 'object' && Object.hasOwn(body, 'versionId')
        ? body.versionId
        : undefined;
      const result = revertStyleTemplate(versionId);
      if (!result.ok) return json({ ok: false, error: result.error }, 400);
      const results = await syncUserstyleToPersona();
      const failures = Object.entries(results).filter(([, r]) => !r?.ok)
        .map(([agentId, r]) => ({ agentId, error: r?.error || '写入失败' }));
      return json({
        ok: failures.length === 0,
        template: result.template,
        failures,
        message: failures.length
          ? '模板已恢复，但有几位伙伴的人格文件没写进去'
          : (versionId === undefined ? '已回退到上一版' : '已恢复所选版本'),
      });
    } catch (e) {
      return json({ ok: false, error: e?.message || String(e) }, 500);
    }
  });

  app.post('/api/style-template/clear', async () => {
    if (styleBusy()) return busyResponse();
    try {
      clearStyleTemplate();
      const results = await syncUserstyleToPersona();
      return json({ ok: true, message: '已清空' });
    } catch (e) {
      return json({ ok: false, error: e?.message || String(e) }, 500);
    }
  });
}
