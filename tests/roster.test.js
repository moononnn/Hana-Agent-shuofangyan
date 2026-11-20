// tests/roster.test.js — 可见名单（藏起来/放回来）+ 刷新名单的三条硬规矩
//
// 这条链上有几个坑，每一个都钉一个测试：
//   ① 刷新必须明确重取 host 名单；拉回来是空的就把缓存清掉。
//      回落列目录会把退休的、探针用的人格文件重新带回来 —— 刷新完名单反而多出僵尸。
//   ② 主机失败要保留最近一次名单，并把失败显式报出去；不能悄悄回落目录冒充刷新成功。
//   ③ 藏起来只写一份独立存档：不碰方言配置、不碰人格文件、不碰宿主名册，
//      方言同步/状态/bias 照旧按名册走。

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sfy-roster-'));
process.env.SFY_DATA_DIR = path.join(TMP, 'app-data', 'shuo-fangyan');
process.env.HANA_HOME = TMP;
fs.mkdirSync(process.env.SFY_DATA_DIR, { recursive: true });

const DATA_DIR = process.env.SFY_DATA_DIR;
const VISIBILITY_FILE = path.join(DATA_DIR, 'roster-visibility.json');
const CONFIG_FILE = path.join(DATA_DIR, 'dialect-config.json');

const { default: registerApi } = await import('../server/api.js');
const { setHostAgentSource, resetAgentCache } = await import('../lib/agents.js');
const { setPersonaResources } = await import('../lib/persona-io.js');
const roster = await import('../lib/roster-visibility.js');
const { resolveDialectBias } = await import('../lib/dialect-bias.js');
const { writeDialectConfig } = await import('../lib/dialect-config.js');

const quiet = { info() {}, warn() {}, error() {} };

// 假的宿主资源通道：只读为主，顺便统计有没有被写过
function fakeResources(files) {
  const writes = [];
  return {
    writes,
    async read({ path: p }) {
      if (!(p in files)) throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      return { content: files[p] };
    },
    async list({ path: p }) {
      const children = new Set();
      for (const key of Object.keys(files)) {
        const rel = path.relative(p, key);
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) children.add(rel.split(path.sep)[0]);
      }
      if (!children.size && !(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { entries: [...children] };
    },
    async stat({ path: p }) {
      if (!(p in files)) return { exists: false };
      return { exists: true, version: 'v1' };
    },
    async write({ path: p }, text) {
      writes.push(p);
      files[p] = text;
      return { ok: true };
    },
  };
}

function makeApp() {
  const routes = {};
  return {
    routes,
    get(p, fn) { routes['GET ' + p] = fn; },
    post(p, fn) { routes['POST ' + p] = fn; },
  };
}

function newApp(sdk = { logger: quiet }) {
  const app = makeApp();
  registerApi(app, sdk);
  return app;
}

async function getState(sdk = { logger: quiet }, url = 'http://localhost/api/state') {
  const app = newApp(sdk);
  const res = await app.routes['GET /api/state']({ req: { url } });
  return res.json();
}

async function postVisibility(body, sdk = { logger: quiet }) {
  const app = newApp(sdk);
  const res = await app.routes['POST /api/roster-visibility']({
    req: { json: async () => body },
  });
  return res.json();
}

function resetAll() {
  resetAgentCache();
  roster.resetRosterVisibilityCache();
  setHostAgentSource(null);
  try { fs.rmSync(VISIBILITY_FILE, { force: true }); } catch { /* 本来就没有 */ }
}

// ── 可见名单本身 ────────────────────────────────────────────

test('藏起来：只写独立存档，方言配置与人格文件都不碰', async () => {
  resetAll();
  const resources = fakeResources({});
  setPersonaResources(resources);
  setHostAgentSource(async () => ({
    agents: [
      { id: 'hanako', name: '汉娜', state: 'active' },
      { id: 'xiaohua', name: '小花', state: 'active' },
    ],
  }));

  const before = await getState();
  assert.deepEqual(before.data.agents.map((a) => a.id), ['hanako', 'xiaohua']);

  const res = await postVisibility({ agentId: 'hanako', hidden: true });
  assert.equal(res.ok, true);
  assert.deepEqual(res.data.agents.map((a) => a.id), ['xiaohua']);
  assert.deepEqual(res.data.hiddenAgents, [{ id: 'hanako', name: '汉娜' }]);

  // 只新增了这一个文件
  const files = fs.readdirSync(DATA_DIR).sort();
  assert.deepEqual(files, ['roster-visibility.json']);
  assert.equal(fs.existsSync(CONFIG_FILE), false);
  assert.equal(resources.writes.length, 0);

  // 存档内容：稳定 id + 显示备份名
  const saved = JSON.parse(fs.readFileSync(VISIBILITY_FILE, 'utf8'));
  assert.deepEqual(saved.hidden, [{ id: 'hanako', name: '汉娜' }]);
});

test('重启回读：藏起来的状态还在，放回来也就没了', async () => {
  resetAll();
  setHostAgentSource(async () => ({
    agents: [{ id: 'hanako', name: '汉娜', state: 'active' }],
  }));
  await getState();   // 先把名册拉起来（页面上也是先有名单才能藏）

  await postVisibility({ agentId: 'hanako', hidden: true });

  // 模拟重启：换一份模块实例重新读盘
  const reloaded = await import('../lib/roster-visibility.js?restart=1');
  assert.deepEqual(reloaded.readRosterVisibility().hidden, [{ id: 'hanako', name: '汉娜' }]);
  const view = reloaded.applyVisibility([{ id: 'hanako', name: '汉娜' }]);
  assert.deepEqual(view.agents, []);
  assert.deepEqual(view.hiddenAgents, [{ id: 'hanako', name: '汉娜' }]);

  // 放回来：id 稳定，名字也跟着
  const res = await postVisibility({ agentId: 'hanako', hidden: false });
  assert.equal(res.ok, true);
  assert.deepEqual(res.data.agents.map((a) => a.id), ['hanako']);
  assert.deepEqual(res.data.hiddenAgents, []);
  const saved = JSON.parse(fs.readFileSync(VISIBILITY_FILE, 'utf8'));
  assert.deepEqual(saved.hidden, [], '放回来就把这条偏好删掉');
});

test('不在名单里的伙伴也能放回来（暂时被宿主摘掉的那种）', async () => {
  resetAll();
  setHostAgentSource(async () => ({ agents: [{ id: 'hanako', name: '汉娜', state: 'active' }] }));
  await getState();
  await postVisibility({ agentId: 'hanako', hidden: true });

  // 宿主那边暂时没有这位伙伴了，缓存也跟着清掉
  resetAgentCache();
  setHostAgentSource(async () => ({ agents: [] }));

  // 放回来：即使名册里没有他，也要能把藏着的偏好清掉
  const unhide = await postVisibility({ agentId: 'hanako', hidden: false });
  assert.equal(unhide.ok, true);
  assert.deepEqual(unhide.data.hiddenAgents, []);

  // 反过来：名册里没有他时，不许凭空藏人
  const hide = await postVisibility({ agentId: 'hanako', hidden: true });
  assert.equal(hide.ok, false);
  assert.match(hide.error, /当前名单里没有/);
});

test('原型键与乱造 id 一律拒绝', async () => {
  resetAll();
  setHostAgentSource(async () => ({ agents: [{ id: 'hanako', name: '汉娜', state: 'active' }] }));
  await getState();   // 名册在手上，才能挡住乱造的 id

  for (const bad of ['__proto__', 'constructor', 'prototype', '坏 id', 'a\tb', '']) {
    const res = await postVisibility({ agentId: bad, hidden: true });
    assert.equal(res.ok, false, `应该拒绝：${JSON.stringify(bad)}`);
    assert.ok(res.error, '要说明为什么拒绝');
  }
  // hidden 必须是布尔
  assert.equal((await postVisibility({ agentId: 'hanako', hidden: 'yes' })).ok, false);
  // 名单里没有的人，藏起来要挡回去（防止前端乱造）
  const ghost = await postVisibility({ agentId: 'nobody-here', hidden: true });
  assert.equal(ghost.ok, false);

  // 拒绝之后存档还是空的
  assert.deepEqual(roster.readRosterVisibility().hidden, []);
});

test('名册空着的时候不许凭空藏人', async () => {
  resetAll();
  resetAgentCache();
  setHostAgentSource(async () => ({ agents: [] }));
  await getState();
  const res = await postVisibility({ agentId: 'hanako', hidden: true });
  assert.equal(res.ok, false);
  assert.match(res.error, /当前名单里没有/);
  assert.deepEqual(roster.readRosterVisibility().hidden, []);
});

test('旧版存档：格式不认识就当空名单，不报错', async () => {
  resetAll();
  fs.writeFileSync(VISIBILITY_FILE, JSON.stringify({ hanako: true }), 'utf8');
  roster.resetRosterVisibilityCache();
  assert.deepEqual(roster.readRosterVisibility().hidden, []);

  fs.writeFileSync(VISIBILITY_FILE, '{ 这不是 JSON', 'utf8');
  roster.resetRosterVisibilityCache();
  assert.deepEqual(roster.readRosterVisibility().hidden, []);
});

test('藏起来不影响方言那套：配置、状态、bias 照旧按名册走', async () => {
  resetAll();
  const resources = fakeResources({});
  setPersonaResources(resources);
  setHostAgentSource(async () => ({
    agents: [{ id: 'hanako', name: '汉娜', state: 'active' }],
  }));

  await getState();   // 名册先拉起来，才能藏
  await postVisibility({ agentId: 'hanako', hidden: true });

  // 状态接口里 visible 名单少了他，但「实际方言」那张表照旧有他
  const state = await getState();
  assert.deepEqual(state.data.agents, []);
  assert.deepEqual(state.data.hiddenAgents, [{ id: 'hanako', name: '汉娜' }]);
  assert.ok('hanako' in state.data.actual);

  // bias 照旧能按名册里的配置查（HTTP 接口换成了宿主 bus 服务，逻辑在 lib 层）
  writeDialectConfig({ agents: { hanako: { dialect: 'sichuan', enabled: true } } });
  const bias = resolveDialectBias('hanako');
  assert.equal(bias.agentId, 'hanako');
  assert.equal(bias.dialect, 'sichuan');
});

// ── 刷新名单的三条硬规矩 ────────────────────────────────────

test('刷新：拉回来是空的就清缓存，绝不回落目录带出退休/探针', async () => {
  resetAll();
  // 目录里躺着带人格文件的目录（退休的、探针用的都长这样）
  const root = TMP;
  const files = {
    [path.join(root, 'agents', 'retired-one', 'AGENTS.md')]: '# 退休的\n',
    [path.join(root, 'agents', 'probe-agent', 'AGENTS.md')]: '# 探针\n',
  };
  setPersonaResources(fakeResources(files));
  setHostAgentSource(async () => ({ agents: [] }));

  const res = await getState({ logger: quiet }, 'http://localhost/api/state?refresh=1');
  assert.equal(res.ok, true);
  assert.deepEqual(res.data.agents, []);
  assert.equal(res.data.agentSource, 'host');
  assert.deepEqual(res.data.hiddenAgents, []);
  // 缓存确实被清掉了：再来一次普通请求也是空
  const plain = await getState({ logger: quiet });
  assert.deepEqual(plain.data.agents, []);
  assert.equal(plain.data.agentSource, 'host');
});

test('刷新：主机失败保留最近名单并显式报错，不回落目录', async () => {
  resetAll();
  const root = TMP;
  const files = {
    [path.join(root, 'agents', 'hanako', 'AGENTS.md')]: '# 汉娜\n',
  };
  setPersonaResources(fakeResources(files));
  setHostAgentSource(async () => ({ agents: [{ id: 'hanako', name: '汉娜', state: 'active' }] }));

  const first = await getState({ logger: quiet }, 'http://localhost/api/state?refresh=1');
  assert.deepEqual(first.data.agents.map((a) => a.id), ['hanako']);

  // 宿主开始报错
  setHostAgentSource(async () => { throw new Error('宿主名单挂了'); });
  const failed = await getState({ logger: quiet }, 'http://localhost/api/state?refresh=1');
  assert.equal(failed.ok, false, '刷新失败要显式说出来');
  assert.match(failed.error, /宿主名单挂了/);
  assert.deepEqual(failed.data.agents.map((a) => a.id), ['hanako'], '失败时保留最近一次名单');
  assert.equal(failed.data.agentSource, 'cache');
});

test('刷新：拿到的有效名单替掉旧名单，退休/探针按状态剔掉', async () => {
  resetAll();
  setPersonaResources(fakeResources({}));
  setHostAgentSource(async () => ({
    agents: [
      { id: 'hanako', name: '汉娜', state: 'active' },
      { id: 'retired-one', name: '退了', state: 'retired' },
      { id: 'probe-agent', name: '探针', state: 'probe' },
    ],
  }));
  const res = await getState({ logger: quiet }, 'http://localhost/api/state?refresh=1');
  assert.deepEqual(res.data.agents.map((a) => a.id), ['hanako']);

  // 宿主换了一份名单：刷新要跟上
  setHostAgentSource(async () => ({ agents: [{ id: 'xiaohua', name: '小花', state: 'active' }] }));
  const again = await getState({ logger: quiet }, 'http://localhost/api/state?refresh=1');
  assert.deepEqual(again.data.agents.map((a) => a.id), ['xiaohua']);
});

test('初始状态：宿主不可用时走目录兜底，仍然 ok:true', async () => {
  resetAll();
  const root = TMP;
  const files = {
    [path.join(root, 'agents', 'hanako', 'AGENTS.md')]: '# 汉娜\n',
  };
  setPersonaResources(fakeResources(files));
  setHostAgentSource(async () => { throw new Error('宿主名单挂了'); });

  const res = await getState();
  assert.equal(res.ok, true, '普通请求不该因为宿主拉不到就整体失败');
  assert.equal(res.data.agentSource, 'dir');
  assert.deepEqual(res.data.agents.map((a) => a.id), ['hanako']);
  assert.equal(res.error, undefined);
});

test('旧刷新调用者：不带 refresh 参数时行为不变（有缓存就不去打扰宿主）', async () => {
  resetAll();
  setPersonaResources(fakeResources({}));
  let calls = 0;
  setHostAgentSource(async () => {
    calls += 1;
    return { agents: [{ id: 'hanako', name: '汉娜', state: 'active' }] };
  });

  const first = await getState();
  assert.equal(first.data.agentSource, 'host');
  assert.equal(calls, 1);

  const second = await getState();
  assert.equal(second.data.agentSource, 'cache');
  assert.equal(calls, 1, '有缓存时不该再打扰宿主');
});

test('藏起来的名单不影响刷新：刷新后照样按名册重算可见性', async () => {
  resetAll();
  setPersonaResources(fakeResources({}));
  setHostAgentSource(async () => ({
    agents: [
      { id: 'hanako', name: '汉娜', state: 'active' },
      { id: 'xiaohua', name: '小花', state: 'active' },
    ],
  }));
  await getState();   // 名册先拉起来，才能藏
  await postVisibility({ agentId: 'hanako', hidden: true });

  const res = await getState({ logger: quiet }, 'http://localhost/api/state?refresh=1');
  assert.deepEqual(res.data.agents.map((a) => a.id), ['xiaohua']);
  assert.deepEqual(res.data.hiddenAgents, [{ id: 'hanako', name: '汉娜' }]);
});

test('显示备份：伙伴不在名册里了，用隐藏时存下的名字，且不写盘', async () => {
  resetAll();
  setPersonaResources(fakeResources({}));
  setHostAgentSource(async () => ({ agents: [{ id: 'hanako', name: '汉娜', state: 'active' }] }));
  await getState();
  await postVisibility({ agentId: 'hanako', hidden: true });

  const savedBefore = fs.readFileSync(VISIBILITY_FILE, 'utf8');

  // 宿主那边把这位伙伴摘掉了，名册里没人了
  setHostAgentSource(async () => ({ agents: [] }));
  const state = await getState({ logger: quiet }, 'http://localhost/api/state?refresh=1');
  assert.deepEqual(state.data.agents, []);
  assert.deepEqual(state.data.hiddenAgents, [{ id: 'hanako', name: '汉娜' }], '不在名册里就用隐藏时的名字');

  // 读状态不改存档
  assert.equal(fs.readFileSync(VISIBILITY_FILE, 'utf8'), savedBefore);
  assert.deepEqual(JSON.parse(savedBefore).hidden, [{ id: 'hanako', name: '汉娜' }]);
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
