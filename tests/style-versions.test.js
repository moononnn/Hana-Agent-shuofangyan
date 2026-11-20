import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sfy-style-versions-'));
process.env.SFY_DATA_DIR = path.join(root, 'app-data', 'shuo-fangyan');
process.env.HANA_HOME = root;
fs.mkdirSync(process.env.SFY_DATA_DIR, { recursive: true });

const { default: registerApi } = await import('../server/api.js');
const {
  readStyleTemplate,
  writeStyleTemplate,
  saveStyleDraft,
  styleVersionId,
  revertStyleTemplate,
} = await import('../lib/style-template.js');
const { writeDialectConfig } = await import('../lib/dialect-config.js');
const { setPersonaResources } = await import('../lib/persona-io.js');
const { cacheHostAgents, resetAgentCache } = await import('../lib/agents.js');
const { setHostModelCatalog } = await import('../lib/model-host.js');

test.after(() => {
  setPersonaResources(null);
  fs.rmSync(root, { recursive: true, force: true });
});

function makeCall(sdk = { logger: { info() {}, warn() {}, error() {} } }) {
  const handlers = new Map();
  registerApi({
    get: (route, fn) => handlers.set(`GET ${route}`, fn),
    post: (route, fn) => handlers.set(`POST ${route}`, fn),
  }, sdk);
  return async (method, route, body) => {
    const handler = handlers.get(`${method} ${route}`);
    const response = await handler({ req: { json: async () => body } });
    return { status: response.status, body: await response.json() };
  };
}

const base = {
  version: 1,
  current: '当前版本',
  current_at: '2026-01-03T00:00:00.000Z',
  draft: '保留的草稿',
  draft_at: '2026-01-04T00:00:00.000Z',
  versions: [
    { text: '旧版本 A', at: '2026-01-02T00:00:00.000Z' },
    { text: '旧版本 B', at: '2026-01-01T00:00:00.000Z' },
  ],
};

function resetTemplate(value = base) {
  writeStyleTemplate(structuredClone(value));
}

test('模板 GET 保留原字段并追加稳定的版本 ID；指定历史恢复且保留草稿', async () => {
  resetTemplate();
  const call = makeCall();
  const response = await call('GET', '/api/style-template');
  assert.equal(response.body.ok, true);
  const data = response.body.data;
  assert.equal(data.current, base.current);
  assert.equal(data.current_at, base.current_at);
  assert.equal(data.draft, base.draft);
  assert.equal(data.draft_at, base.draft_at);
  assert.equal(data.versionCount, 2);
  assert.deepEqual(data.versions, base.versions.map((version) => ({
    id: styleVersionId(version), text: version.text, at: version.at, kind: 'adopted',
  })));
  assert.equal(data.versions[0].id, (await call('GET', '/api/style-template')).body.data.versions[0].id);

  const restored = await call('POST', '/api/style-template/revert', { versionId: data.versions[1].id });
  assert.equal(restored.body.ok, true);
  assert.equal(readStyleTemplate().current, '旧版本 B');
  assert.equal(readStyleTemplate().current_at, base.versions[1].at);
  assert.equal(readStyleTemplate().draft, base.draft);
  assert.deepEqual(readStyleTemplate().versions, [
    { text: '当前版本', at: base.current_at, kind: 'adopted' },
    base.versions[0],
  ]);
});

test('无 body 仍回上一版；无效或过期 ID 不写盘、不误恢复', async () => {
  resetTemplate();
  const call = makeCall();
  const before = fs.readFileSync(path.join(process.env.SFY_DATA_DIR, 'style-template.json'), 'utf8');
  const invalid = await call('POST', '/api/style-template/revert', { versionId: 'not-a-version' });
  assert.equal(invalid.body.ok, false);
  assert.match(invalid.body.error, /已不存在/);
  assert.equal(fs.readFileSync(path.join(process.env.SFY_DATA_DIR, 'style-template.json'), 'utf8'), before);

  const noBody = await call('POST', '/api/style-template/revert');
  assert.equal(noBody.body.ok, true);
  assert.equal(readStyleTemplate().current, '旧版本 A');
  assert.equal(readStyleTemplate().draft, base.draft);
});

test('A→B→C 草稿历史分型；指定采用 A 不覆盖最新草稿 C', async () => {
  resetTemplate({ ...base, current: '', current_at: '', draft: '', draft_at: '', versions: [] });
  assert.equal(saveStyleDraft('草稿 A').ok, true);
  assert.equal(saveStyleDraft('草稿 B').ok, true);
  assert.equal(saveStyleDraft('草稿 C').ok, true);

  let tpl = readStyleTemplate();
  assert.equal(tpl.draft, '草稿 C');
  assert.deepEqual(tpl.versions.map((v) => [v.text, v.kind]), [
    ['草稿 B', 'draft'], ['草稿 A', 'draft'],
  ]);

  const call = makeCall();
  const listed = (await call('GET', '/api/style-template')).body.data.versions;
  assert.deepEqual(listed.map((v) => v.kind), ['draft', 'draft']);
  const adopted = await call('POST', '/api/style-template/revert', { versionId: listed[1].id });
  assert.equal(adopted.body.ok, true);
  tpl = readStyleTemplate();
  assert.equal(tpl.current, '草稿 A');
  assert.equal(tpl.draft, '草稿 C', '采用历史草稿不能覆盖最新草稿');
  assert.deepEqual(tpl.versions.map((v) => [v.text, v.kind]), [['草稿 B', 'draft']]);

  // 空请求不能把剩余草稿隐式转正。
  const before = fs.readFileSync(path.join(process.env.SFY_DATA_DIR, 'style-template.json'), 'utf8');
  const fallback = revertStyleTemplate();
  assert.equal(fallback.ok, false);
  assert.equal(fs.readFileSync(path.join(process.env.SFY_DATA_DIR, 'style-template.json'), 'utf8'), before);
});

test('采用历史草稿时保留当前草稿并归档原采用版本', () => {
  resetTemplate({ ...base, current: '已采用 X', draft: '最新草稿 C', versions: [
    { text: '历史草稿 A', at: 'draft-a', kind: 'draft' },
  ] });
  const target = styleVersionId(readStyleTemplate().versions[0]);
  const result = revertStyleTemplate(target);
  assert.equal(result.ok, true);
  const tpl = readStyleTemplate();
  assert.equal(tpl.current, '历史草稿 A');
  assert.equal(tpl.draft, '最新草稿 C');
  assert.deepEqual(tpl.versions, [{ text: '已采用 X', at: base.current_at, kind: 'adopted' }]);
});

test('空请求回退跳过草稿，只选择最近的已采用版本', () => {
  resetTemplate({ ...base, versions: [
    { text: '未采用草稿', at: 'draft-at', kind: 'draft' },
    { text: '采用版本', at: 'adopted-at' },
  ] });
  const result = revertStyleTemplate();
  assert.equal(result.ok, true);
  assert.equal(readStyleTemplate().current, '采用版本');
  assert.deepEqual(readStyleTemplate().versions, [
    { text: base.current, at: base.current_at, kind: 'adopted' },
    { text: '未采用草稿', at: 'draft-at', kind: 'draft' },
  ]);
});

test('恢复后仍保留最多 10 份历史，换下的当前版本排在最前', () => {
  const versions = Array.from({ length: 10 }, (_, i) => ({ text: `历史 ${i}`, at: `at-${i}` }));
  resetTemplate({ ...base, versions });
  const targetId = styleVersionId(versions[9]);
  const result = revertStyleTemplate(targetId);
  assert.equal(result.ok, true);
  const saved = readStyleTemplate();
  assert.equal(saved.current, '历史 9');
  assert.equal(saved.versions.length, 10);
  assert.deepEqual(saved.versions[0], { text: base.current, at: base.current_at, kind: 'adopted' });
  assert.equal(saved.versions.some((v) => v.text === '历史 9'), false);
});

test('保留原版：草稿归档并清空待决定项，不改当前/profile 或触碰资源', async () => {
  const oldVersions = Array.from({ length: 10 }, (_, i) => ({ text: `历史${i}`, at: `at-${i}`, kind: 'adopted' }));
  resetTemplate({ ...base, current: '已采用原版', current_at: 'current-at', draft: '待决定草稿', draft_at: 'draft-at', versions: oldVersions });
  writeDialectConfig({ agents: { sample: { dialect: 'userstyle', enabled: true } } });
  const resourceCalls = [];
  setPersonaResources({
    async read(...args) { resourceCalls.push(['read', ...args]); throw new Error('unexpected resource read'); },
    async list(...args) { resourceCalls.push(['list', ...args]); throw new Error('unexpected resource list'); },
    async stat(...args) { resourceCalls.push(['stat', ...args]); throw new Error('unexpected resource stat'); },
    async write(...args) { resourceCalls.push(['write', ...args]); throw new Error('unexpected resource write'); },
  });
  const call = makeCall();
  const response = await call('POST', '/api/style-template/keep-current');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, message: '已保留原版，新稿已存入历史。' });
  const saved = readStyleTemplate();
  assert.equal(saved.current, '已采用原版');
  assert.equal(saved.current_at, 'current-at');
  assert.equal(saved.draft, '');
  assert.equal(saved.draft_at, '');
  assert.equal(saved.versions.length, 10);
  assert.deepEqual(saved.versions[0], { text: '待决定草稿', at: 'draft-at', kind: 'draft' });
  assert.equal(saved.versions.some((v) => v.text === '历史9'), false, '超过 10 份时淘汰最旧项');
  assert.deepEqual(resourceCalls, [], '不得触碰人格资源或触发同步');
  setPersonaResources(null);
});

test('保留原版：无已采用版本或无待决定草稿返回 4xx 且不改盘', async () => {
  const call = makeCall();
  resetTemplate({ ...base, current: '', current_at: '', draft: '待决定草稿', draft_at: 'draft-at', versions: [] });
  let before = fs.readFileSync(path.join(process.env.SFY_DATA_DIR, 'style-template.json'), 'utf8');
  let response = await call('POST', '/api/style-template/keep-current');
  assert.equal(response.status, 400);
  assert.equal(response.body.ok, false);
  assert.match(response.body.error, /已采用/);
  assert.equal(fs.readFileSync(path.join(process.env.SFY_DATA_DIR, 'style-template.json'), 'utf8'), before);

  resetTemplate({ ...base, draft: '', draft_at: '' });
  before = fs.readFileSync(path.join(process.env.SFY_DATA_DIR, 'style-template.json'), 'utf8');
  response = await call('POST', '/api/style-template/keep-current');
  assert.equal(response.status, 400);
  assert.equal(response.body.ok, false);
  assert.match(response.body.error, /草稿/);
  assert.equal(fs.readFileSync(path.join(process.env.SFY_DATA_DIR, 'style-template.json'), 'utf8'), before);
});

test('总结任务运行时保留原版返回 409', async () => {
  resetTemplate({ ...base, current: '已采用原版', draft: '待决定草稿' });
  setPersonaResources(null);
  cacheHostAgents([{ id: 'sample', name: '伙伴' }]);
  setHostModelCatalog([{ provider: 'mock', id: 'mock' }]);
  const sessions = path.join(root, 'agents', 'sample', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, 'sample.jsonl'), JSON.stringify({ type: 'message', message: { role: 'user', content: '今天先把房间收拾一下。' } }));
  let release;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const call = makeCall({
    logger: { info() {}, warn() {}, error() {} },
    models: { stream: () => { markStarted(); return new Promise((resolve) => { release = resolve; }); } },
  });
  const task = await call('POST', '/api/style/summary', { agentId: 'sample' });
  assert.equal(task.status, 202);
  await started;
  const kept = await call('POST', '/api/style-template/keep-current');
  assert.equal(kept.status, 409);
  assert.equal(kept.body.ok, false);
  release(new Response(''));
  for (let i = 0; i < 50; i++) {
    const state = await call('GET', '/api/style/summary');
    if (state.body.data.task.status !== 'running') break;
    await delay(10);
  }
  resetAgentCache();
});

test('同步人格失败时如实报告，模板恢复结果仍可见', async () => {
  resetTemplate();
  writeDialectConfig({ agents: { sample: { dialect: 'userstyle', enabled: true } } });
  setPersonaResources({
    async read() { throw Object.assign(new Error('no such file'), { code: 'ENOENT' }); },
    async list() { return { entries: ['sample'] }; },
    async stat() { return { exists: false }; },
    async write() { throw new Error('permission denied'); },
  });
  const call = makeCall();
  const result = await call('POST', '/api/style-template/revert');
  assert.equal(result.body.ok, false);
  assert.equal(readStyleTemplate().current, '旧版本 A');
  assert.equal(result.body.template, '旧版本 A');
  assert.equal(result.body.failures.length, 1);
  assert.match(result.body.message, /模板已恢复，但/);
});
