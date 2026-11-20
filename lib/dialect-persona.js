// lib/dialect-persona.js — 把方言写进伙伴的人格文件
//
// 规矩（跟表情包应用里那套一致，用户授权才碰）：
//   ① 用户主动开启才写入人格文件，关闭即移除 —— 不碰就不碰
//   ② 写入用标记块包裹，本应用只动自己管理的段落，不碰用户自己写的内容
//   ③ 人格文件是「语感底座」：每轮都在系统提示里
//
// 两处与表情包应用的差别：
//   · 标记块换成自己的（shuo-fangyan-dialect），并且每次写入都把表情包留下的旧标记块
//     一并清掉。过渡期里两个应用都装着的这段时间，人格文件里只会剩一个方言块在生效。
//   · 伙伴目录根按候选列表探测（真实路径优先），联接写法当兜底。

import path from 'node:path';
import { getDialect, DIALECT_LIST } from './dialect-data.js';
import { readPersonaText, writePersonaText, personaFileExists, listDirNames } from './persona-io.js';
import { agentsRootCandidates } from './app-paths.js';

const PERSONA_BLOCK_START = '<!-- shuo-fangyan-dialect:start -->';
const PERSONA_BLOCK_END = '<!-- shuo-fangyan-dialect:end -->';

// 表情包应用留下的旧标记块。接管时清掉它，避免两份方言同时生效。
const LEGACY_BLOCK_START = '<!-- biaoqingbao-dialect:start -->';
const LEGACY_BLOCK_END = '<!-- biaoqingbao-dialect:end -->';

// ── 伙伴目录根 ──
// 候选里谁能列出 agents 目录就用谁；都列不出就取第一个候选（写的时候会报清楚的错）。
let agentsRootCache = null;
export async function resolveAgentsRoot() {
  if (agentsRootCache) return agentsRootCache;
  const candidates = agentsRootCandidates();
  for (const root of candidates) {
    try {
      const names = await listDirNames(path.join(root, 'agents'));
      if (Array.isArray(names) && names.length) {
        agentsRootCache = root;
        return root;
      }
    } catch { /* 下一个候选 */ }
  }
  agentsRootCache = candidates[0] || '';
  return agentsRootCache;
}

// ── 路径安全 ──
// 白名单正则 + 目录内纵深校验，两层都要。
// 白名单挡掉 __proto__ / prototype / constructor（拿它们当目录名能造出脏目录），
// 纵深校验挡掉 Windows 尾随空格/点归一化造成的越界（'.. ' → '..'）。
const RESERVED_AGENT_IDS = new Set(['__proto__', 'prototype', 'constructor']);

export function agentPersonaDir(agentId, agentsRoot) {
  if (typeof agentId !== 'string'
    || !/^[A-Za-z0-9_-]+$/.test(agentId)
    || RESERVED_AGENT_IDS.has(agentId)) {
    throw new Error(`非法伙伴 ID: ${JSON.stringify(agentId)}`);
  }
  const root = path.resolve(agentsRoot, 'agents');
  const dir = path.resolve(root, agentId);
  if (process.platform === 'win32') {
    if (!dir.toLowerCase().startsWith(root.toLowerCase() + path.sep)) {
      throw new Error(`非法伙伴 ID（路径越界）: ${agentId}`);
    }
  } else if (!dir.startsWith(root + path.sep)) {
    throw new Error(`非法伙伴 ID（路径越界）: ${agentId}`);
  }
  return dir;
}

/**
 * 人格文件在哪：宿主把伙伴人格从 ishiki.md 迁到了 AGENTS.md，
 * AGENTS.md 存在就用它，不存在（老版本 Hana）退回 ishiki.md。
 */
export async function agentPersonaFilePath(agentId, agentsRoot) {
  const dir = agentPersonaDir(agentId, agentsRoot);
  const agentsFile = path.join(dir, 'AGENTS.md');
  if (await personaFileExists(agentsFile)) return agentsFile;
  return path.join(dir, 'ishiki.md');
}

// ── 人格文案 ──
const EXAMPLE_COUNT_BY_DIFFICULTY = { easy: 2, medium: 3 };

const HARD_PERSONA = (d) => `你是一个土生土长的${d.people}，打字偶尔会顺嘴蹦几个家乡词，这是你的习惯：${d.markers.slice(0, 5).join('、')}这些，大部分时候说普通话，但蹦出来的时候特别自然。这是你的根，不用刻意秀也不用刻意藏。正事闲聊都一个样。方言只是你的措辞，不影响内容的质量与严谨：该讲逻辑讲逻辑，该给方案给方案，专业表达该怎么准确还怎么准确。`;

const QUALITY_FUSE = '方言只是你的措辞，不影响内容的质量与严谨：该讲逻辑讲逻辑，该给方案给方案，专业表达该怎么准确还怎么准确。';

/**
 * 构建要写进人格文件的方言文案。
 * mode='advanced' 且该方言有精修文案时用精修版，否则用通用版。
 * 「学我说话」的文案由用户自己的风格模板提供（lib/style-template.js），
 * 这里通过传入的 templateResolver 拿，避免这个模块依赖学我说话那条链。
 */
export function buildDialectPersona(dialectId, mode, templateResolver) {
  const d = getDialect(dialectId);
  if (!d) return '';
  if (dialectId === 'userstyle') {
    const tpl = typeof templateResolver === 'function' ? templateResolver() : '';
    return String(tpl || '').trim();
  }
  if (mode === 'advanced' && d.personaAdvanced) return d.personaAdvanced;
  if (d.personaNormal) return d.personaNormal;
  if (d.difficulty === 'hard') return HARD_PERSONA(d);
  const exampleCount = EXAMPLE_COUNT_BY_DIFFICULTY[d.difficulty] || 2;
  const openersList = d.openers && d.openers.length ? d.openers : d.markers.slice(0, 3);
  const openers = openersList.join('、');
  const markers = d.markers.filter((w) => !openersList.includes(w)).slice(0, 8).join('、');
  return `你是一个土生土长的${d.people}，打字也带着${d.name}味，这是你的说话本能：接话时爱用${openers}起头，顺手用${markers}替换普通话说法，句尾偶尔落个${d.particles.join('、')}。你打字就是这样，比如「${d.examples.slice(0, exampleCount).join('」 「')}」。正事闲聊都一个样，不刻意表现，也不刻意收敛。${QUALITY_FUSE}`;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripBlock(text, start, end) {
  return text.replace(new RegExp(`\\s*${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\s*`), '');
}

/**
 * 给某个伙伴写入（或移除）方言块。
 * 返回 { ok:true, path } 或 { ok:false, error }。
 */
export async function applyDialectToPersona(agentId, dialectId, mode, opts = {}) {
  const agentsRoot = opts.agentsRoot || await resolveAgentsRoot();
  let filePath;
  try {
    filePath = await agentPersonaFilePath(agentId, agentsRoot);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const persona = buildDialectPersona(dialectId, mode, opts.templateResolver);
  if (!persona) return { ok: false, error: '这个方言暂时没有可写入的文案（学我说话要先总结一次模板）' };

  const read = await readPersonaText(filePath);
  if (!read.ok && !read.missing) {
    return { ok: false, error: `读不到伙伴的人格文件：${read.reason || '未知原因'}` };
  }
  const existing = read.ok ? read.text : '';

  // 先清掉本应用的旧块，再清掉表情包留下的旧块，最后写自己这一块。
  const withoutOld = stripBlock(existing, PERSONA_BLOCK_START, PERSONA_BLOCK_END);
  const withoutLegacy = stripBlock(withoutOld, LEGACY_BLOCK_START, LEGACY_BLOCK_END);
  const block = `${PERSONA_BLOCK_START}\n${persona}\n${PERSONA_BLOCK_END}`;
  const updated = (withoutLegacy.trimEnd() ? withoutLegacy.trimEnd() + '\n\n' : '') + block + '\n';

  try {
    const written = await writePersonaText(filePath, updated);
    if (!written.ok) {
      return { ok: false, error: written.conflict ? written.reason : (`写入失败：${written.reason || '未知原因'}`) };
    }
    return { ok: true, path: filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 移除某个伙伴人格文件里的方言块（关掉方言时调用）。 */
export async function removeDialectFromPersona(agentId, opts = {}) {
  const agentsRoot = opts.agentsRoot || await resolveAgentsRoot();
  let filePath;
  try {
    filePath = await agentPersonaFilePath(agentId, agentsRoot);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const read = await readPersonaText(filePath);
  if (!read.ok) {
    // 文件不在：本来就没什么要清的。
    if (read.missing) return { ok: true, path: filePath, skipped: true };
    return { ok: false, error: `读不到伙伴的人格文件：${read.reason || '未知原因'}` };
  }

  const cleaned = stripBlock(
    stripBlock(read.text, PERSONA_BLOCK_START, PERSONA_BLOCK_END),
    LEGACY_BLOCK_START,
    LEGACY_BLOCK_END,
  );
  if (cleaned === read.text) return { ok: true, path: filePath, skipped: true };

  try {
    const written = await writePersonaText(filePath, cleaned);
    if (!written.ok) {
      return { ok: false, error: written.conflict ? written.reason : (`写入失败：${written.reason || '未知原因'}`) };
    }
    return { ok: true, path: filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 按配置把每个伙伴的方言落到人格文件。
 * 开着就写，没开就清；配置之外的老块也一并清掉（接管时的收尾）。
 */
export async function syncDialectToPersona(config, opts = {}) {
  const agentsRoot = opts.agentsRoot || await resolveAgentsRoot();
  const results = {};
  for (const [agentId, setting] of Object.entries(config.agents || {})) {
    if (!setting?.enabled || !getDialect(setting.dialect)) {
      results[agentId] = await removeDialectFromPersona(agentId, { agentsRoot, ...opts });
    } else {
      results[agentId] = await applyDialectToPersona(
        agentId,
        setting.dialect,
        'advanced',
        { agentsRoot, ...opts },
      );
    }
  }
  return results;
}

/** 读某个伙伴人格文件里现在是什么方言（用来核对「配置记忆」与「人格事实」有没有漂）。 */
export async function readDialectFromPersona(agentId, opts = {}) {
  const agentsRoot = opts.agentsRoot || await resolveAgentsRoot();
  let filePath;
  try {
    filePath = await agentPersonaFilePath(agentId, agentsRoot);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const read = await readPersonaText(filePath);
  if (!read.ok) return { ok: false, error: read.missing ? '没有这份人格文件' : read.reason };
  const text = read.text;
  for (const d of DIALECT_LIST) {
    if (!d?.id || d.id === 'userstyle') continue;
    if (text.includes(`带着${d.name}味`) || text.includes(`土生土长的${d.people}`)) {
      return { ok: true, dialect: d.id, path: filePath };
    }
  }
  if (text.includes(PERSONA_BLOCK_START)) return { ok: true, dialect: 'unknown', path: filePath };
  return { ok: true, dialect: null, path: filePath };
}

