// tests/dialect.test.js — 方言核心逻辑的回归测试
// 跑法：node --test tests/
//
// 覆盖三件容易出事的事：
//   ① 配置归一化（不认识的方言 id 不许进配置）
//   ② 人格文件里的方言块：写得进、读得出、撤得干净，而且不碰用户自己写的内容
//   ③ 接管表情包留下的旧标记块时，旧块必须被清掉（过渡期不能两份方言同时生效）

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sfy-test-'));
const configFile = path.join(tmpRoot, 'dialect-config.json');
process.env.SFY_DIALECT_CONFIG = configFile;

const { readDialectConfig, writeDialectConfig, getAgentDialectSetting } = await import('../lib/dialect-config.js');
const { applyDialectToPersona, removeDialectFromPersona, readDialectFromPersona, syncDialectToPersona } = await import('../lib/dialect-persona.js');
const { buildDialectPersona, agentPersonaFilePath } = await import('../lib/dialect-persona.js');

function makeAgent(agentId, content) {
  const dir = path.join(tmpRoot, 'agents', agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), content, 'utf8');
  return dir;
}

test('配置归一化：不认识的方言 id 进不来，旧版 boost 字段丢掉', () => {
  writeDialectConfig({ agents: {
    a: { dialect: 'sichuan', enabled: true },
    b: { dialect: 'not-a-dialect', enabled: true },
    c: { dialect: 'beijing', enabled: true, boost: true },
  } });
  const cfg = readDialectConfig();
  assert.equal(cfg.agents.a.dialect, 'sichuan');
  assert.equal(cfg.agents.b, undefined, '不认识的方言不该留在配置里');
  assert.equal(cfg.version, 4, '配置版本升到 v4');
  assert.equal(cfg.agents.c.boost, undefined, 'v4 起没有 boost，旧值读进来就丢');
});

test('配置归一化：没开的条目不算开启', () => {
  writeDialectConfig({ agents: { d: { dialect: 'sichuan', enabled: false } } });
  assert.equal(getAgentDialectSetting('d'), null);
});

test('人格文件：写入方言块后读得出来', async () => {
  makeAgent('agent-x', '# 小花\n\n这是用户自己写的性格设定。\n');
  const res = await applyDialectToPersona('agent-x', 'sichuan', 'normal', { agentsRoot: tmpRoot });
  assert.equal(res.ok, true, res.error);
  const text = fs.readFileSync(res.path, 'utf8');
  assert.ok(text.includes('shuo-fangyan-dialect:start'), '方言块标记应该在');
  assert.ok(text.includes('土生土长的四川人'), '方言文案应该在');
  assert.ok(text.includes('这是用户自己写的性格设定。'), '用户自己写的内容不能被弄丢');

  const read = await readDialectFromPersona('agent-x', { agentsRoot: tmpRoot });
  assert.equal(read.ok, true);
  assert.equal(read.dialect, 'sichuan');
});

test('人格文件：撤掉方言块后恢复原样', async () => {
  makeAgent('agent-y', '# 小花\n\n原始内容。\n');
  await applyDialectToPersona('agent-y', 'cantonese', 'normal', { agentsRoot: tmpRoot });
  const res = await removeDialectFromPersona('agent-y', { agentsRoot: tmpRoot });
  assert.equal(res.ok, true, res.error);
  const text = fs.readFileSync(res.path, 'utf8');
  assert.ok(!text.includes('shuo-fangyan-dialect'), '方言块应该被撤干净');
  assert.ok(text.includes('原始内容。'), '用户内容要留着');
});

test('人格文件：接管时清掉表情包留下的旧标记块', async () => {
  const dir = path.join(tmpRoot, 'agents', 'agent-z');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), [
    '# 小花',
    '',
    '<!-- biaoqingbao-dialect:start -->',
    '你是一个土生土长的东北人，打字带着东北话味。',
    '<!-- biaoqingbao-dialect:end -->',
    '',
    '用户自己写的部分。',
    '',
  ].join('\n'), 'utf8');

  const res = await applyDialectToPersona('agent-z', 'sichuan', 'normal', { agentsRoot: tmpRoot });
  assert.equal(res.ok, true, res.error);
  const text = fs.readFileSync(res.path, 'utf8');
  assert.ok(!text.includes('biaoqingbao-dialect'), '旧标记块必须清掉，否则两份方言同时生效');
  assert.ok(text.includes('shuo-fangyan-dialect:start'), '新块应该写上');
  assert.ok(text.includes('用户自己写的部分。'), '用户内容不能丢');
});

test('人格文件：非法伙伴 id 直接拒绝', async () => {
  const res = await applyDialectToPersona('../evil', 'sichuan', 'normal', { agentsRoot: tmpRoot });
  assert.equal(res.ok, false);
  assert.match(res.error, /非法伙伴 ID/);
});

test('人格文案：加浓版用精修文案，普通版用通用文案', () => {
  const normal = buildDialectPersona('sichuan', 'normal');
  const advanced = buildDialectPersona('sichuan', 'advanced');
  assert.notEqual(normal, advanced);
  assert.ok(advanced.length > normal.length, '精修文案应该更长更细');
  assert.equal(buildDialectPersona('not-a-dialect', 'normal'), '');
});

test('同步：一律写精修文案，不看 boost', async () => {
  makeAgent('agent-sync', '# 小花\n\n原始内容。\n');
  const results = await syncDialectToPersona(
    { agents: { 'agent-sync': { dialect: 'sichuan', enabled: true } } },
    { agentsRoot: tmpRoot },
  );
  assert.equal(results['agent-sync'].ok, true, results['agent-sync'].error);
  const text = fs.readFileSync(results['agent-sync'].path, 'utf8');
  assert.ok(text.includes('情绪的开关'), '精修文案才有这一段');
  assert.ok(text.includes('原始内容。'), '用户自己的内容不能丢');
});
