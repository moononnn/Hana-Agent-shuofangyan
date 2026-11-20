import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sfy-summary-'));
process.env.SFY_DATA_DIR = path.join(root, 'app-data', 'shuo-fangyan');
process.env.HANA_HOME = root;
const sessions = path.join(root, 'agents', 'sample', 'sessions');
fs.mkdirSync(sessions, { recursive: true });
fs.writeFileSync(path.join(sessions, 'example.jsonl'), JSON.stringify({ type: 'message', message: { role: 'user', content: '今天先把这些东西收拾一下嘛。' } }));
const { default: registerApi } = await import('../server/api.js');
const { cacheHostAgents } = await import('../lib/agents.js');
const { readStyleTemplate, confirmStyleDraft, saveStyleDraft, clearStyleTemplate } = await import('../lib/style-template.js');
const { setHostModelCatalog } = await import('../lib/model-host.js');
cacheHostAgents([{ id: 'sample', name: '测试伙伴' }]);
setHostModelCatalog([{ provider: 'mock', id: 'mock' }]);
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function setup(stream) {
  const handlers = new Map();
  registerApi({
    get: (route, fn) => handlers.set(`GET ${route}`, fn),
    post: (route, fn) => handlers.set(`POST ${route}`, fn),
  }, { models: { stream } });
  return async (route, body) => {
    const response = await handlers.get(route)({ req: { json: async () => body } });
    return { status: response.status, body: await response.json() };
  };
}

const post = 'POST /api/style/summary';
const get = 'GET /api/style/summary';
async function waitTask(call, predicate) {
  for (let i = 0; i < 100; i++) {
    const task = (await call(get)).body.data.task;
    if (predicate(task)) return task;
    await delay(10);
  }
  assert.fail('未看到预期的任务状态');
}

test('立即返回任务，重复提交复用；后台完成后只存草稿', async () => {
  let finish;
  let calls = 0;
  const call = setup(() => { calls++; return new Promise((resolve) => { finish = resolve; }); });
  const first = await call(post, { agentId: 'sample' });
  assert.equal(first.status, 202);
  assert.equal(first.body.data.task.phase, 'sampling');
  const same = await call(post, { agentId: 'sample' });
  assert.equal(same.body.data.task.id, first.body.data.task.id);
  assert.equal((await call('POST /api/style-template/clear')).status, 409);
  await waitTask(call, (task) => task?.phase === 'distilling' && calls === 1);
  const draft = '你常用简短又亲切的句子起头，喜欢把语气词留在句末，碰到轻松的话题就多用口语。';
  finish(new Response(JSON.stringify({ type: 'text-delta', delta: draft })));
  const done = await waitTask(call, (task) => task?.status === 'done');
  assert.equal(done.phase, 'saving');
  assert.equal(done.sampleCount, 1);
  assert.equal(calls, 1);
  assert.equal(readStyleTemplate().draft, draft);
  assert.equal(readStyleTemplate().current, '');
});

test('拒绝名单外的 ID；生成失败保留当前草稿、历史与已采用模板', async () => {
  clearStyleTemplate();
  const old = '这份是先前已采用的说话风格，会保留到你手动选另一份。';
  saveStyleDraft(old);
  confirmStyleDraft();
  saveStyleDraft('此前草稿 A');
  saveStyleDraft('当前草稿 B');
  const historyBefore = structuredClone(readStyleTemplate().versions);
  let calls = 0;
  const call = setup(async () => { calls++; throw new Error('模拟模型失败'); });
  assert.equal((await call(post, { agentId: 'unknown' })).status, 400);
  assert.equal((await call(get)).body.data.task, null);
  assert.equal(calls, 0);
  assert.equal((await call(post, { agentId: 'sample' })).status, 202);
  const failed = await waitTask(call, (task) => task?.status === 'failed');
  assert.match(failed.error, /^总结失败/);
  assert.equal(readStyleTemplate().current, old);
  assert.equal(readStyleTemplate().draft, '当前草稿 B');
  assert.deepEqual(readStyleTemplate().versions, historyBefore);
});
