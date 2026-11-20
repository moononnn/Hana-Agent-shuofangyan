// tests/agents.test.js — 伙伴名单三档：宿主名单 → 列目录兜底 → 空
//
// 这条链断过一次：agent:list 不给 scope:'all' 时只回本 App 自己的伙伴分区，
// 页面上就成了一片「宿主那边没给出伙伴名单」。测试把「必须带 scope:'all'」和
// 「宿主不给时退回列目录」两件事钉住。

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sfy-agents-'));
process.env.SFY_DATA_DIR = path.join(TMP, 'app-data', 'shuo-fangyan');
process.env.HANA_HOME = TMP;
fs.mkdirSync(process.env.SFY_DATA_DIR, { recursive: true });

const { default: registerApi } = await import('../server/api.js');
const { setHostAgentSource, resetAgentCache, normalizeRoster } = await import('../lib/agents.js');
const { setPersonaResources } = await import('../lib/persona-io.js');

// 假的宿主资源通道：内存里的一堆文件，够 list / read / stat / write 用
function fakeResources(files) {
  const keys = Object.keys(files);
  return {
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
      if (!children.size && !keys.includes(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { entries: [...children] };
    },
    async stat({ path: p }) {
      if (!(p in files)) return { exists: false };
      return { exists: true, version: 'v1' };
    },
    async write({ path: p }, text) {
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

const quiet = { info() {}, warn() {}, error() {} };

async function readState(sdk) {
  const app = makeApp();
  registerApi(app, sdk);
  const res = await app.routes['GET /api/state']();
  return res.json();
}

test('isPrimary 只按显式 true 稳定置顶，其他伙伴顺序不变', () => {
  const rows = normalizeRoster([
    { id: 'a', name: 'A' },
    { id: 'p1', name: 'P1', isPrimary: true },
    { id: 'b', name: 'B', isPrimary: 'true' },
    { id: 'p2', name: 'P2', isPrimary: true },
    { id: 'retired', name: '退休', state: 'retired', isPrimary: true },
  ]);
  assert.deepEqual(rows.map((row) => row.id), ['p1', 'p2', 'a', 'b']);
});

test('宿主名单：必须带 scope: all，退役伙伴不进列表', async () => {
  const seen = [];
  const sdk = {
    logger: quiet,
    agents: {
      list: async (req) => {
        seen.push(req);
        return { agents: [
          { id: 'hanako', name: '汉娜', state: 'active' },
          { id: 'xiaohua', name: '小花', state: 'active' },
          { id: 'retired-one', name: '退了', state: 'retired' },
        ] };
      },
    },
  };
  setHostAgentSource((req) => sdk.agents.list(req));
  setPersonaResources(fakeResources({}));

  const body = await readState(sdk);
  assert.equal(body.ok, true);
  assert.equal(body.data.agentSource, 'host');
  assert.deepEqual(body.data.agents.map((a) => a.name), ['汉娜', '小花']);
  assert.equal(seen[0].scope, 'all');
  assert.equal(seen[0].lifecycle, 'active');
});

test('宿主不给名单：退回列目录，只要带人格文件的目录', async () => {
  const root = TMP;  const files = {
    [path.join(root, 'agents', 'hanako', 'AGENTS.md')]: '# 汉娜\n',
    [path.join(root, 'agents', 'xiaohua', 'AGENTS.md')]: '# 小花\n',
    [path.join(root, 'agents', 'empty-dir', 'notes.txt')]: '没有 AGENTS.md\n',
    [path.join(root, 'agents', 'bad name!', 'AGENTS.md')]: '非法 id\n',
  };
  // 清掉宿主来源和缓存，模拟宿主拉不到名单
  setHostAgentSource(null);
  resetAgentCache();
  setPersonaResources(fakeResources(files));

  const body = await readState({ logger: quiet });
  assert.equal(body.ok, true);
  assert.equal(body.data.agentSource, 'dir');
  const ids = body.data.agents.map((a) => a.id).sort();
  assert.deepEqual(ids, ['hanako', 'xiaohua']);
  // 列目录拿不到显示名，界面退化成 id
  assert.deepEqual(body.data.agents.map((a) => a.name).sort(), ['hanako', 'xiaohua']);
});

test('两档都空：报 source=none，不抛错', async () => {
  setHostAgentSource(null);
  resetAgentCache();
  setPersonaResources(fakeResources({}));
  const body = await readState({ logger: quiet });
  assert.equal(body.ok, true);
  assert.equal(body.data.agents.length, 0);
  assert.equal(body.data.agentSource, 'none');
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
