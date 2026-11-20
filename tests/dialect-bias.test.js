// tests/dialect-bias.test.js — 给别的应用查方言气质
// 跑法：node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sfy-bias-'));
process.env.SFY_DATA_DIR = tmpRoot;
process.env.SFY_DIALECT_CONFIG = path.join(tmpRoot, 'dialect-config.json');

const { writeDialectConfig } = await import('../lib/dialect-config.js');
const { resolveDialectBias } = await import('../lib/dialect-bias.js');
const { DIALECT_EXPRESSION_BIAS } = await import('../lib/dialect-data.js');

test('没开方言：给一份空结果，不是报错', () => {
  writeDialectConfig({ agents: {} });
  const out = resolveDialectBias('hanako');
  assert.equal(out.agentId, 'hanako');
  assert.equal(out.dialect, null);
  assert.equal(out.bias, null);
  assert.equal(out.label, '');
});

test('开了四川话：给的就是表里那份权重', () => {
  writeDialectConfig({ agents: { hanako: { dialect: 'sichuan', enabled: true } } });
  const out = resolveDialectBias('hanako');
  assert.equal(out.dialect, 'sichuan');
  assert.equal(out.name, '四川话');
  assert.deepEqual(out.bias, DIALECT_EXPRESSION_BIAS.sichuan);
  assert.ok(out.label, '要带上气质标签，方便对方日志里看懂');
});

test('不同伙伴各算各的', () => {
  writeDialectConfig({
    agents: {
      hanako: { dialect: 'sichuan', enabled: true },
      yunying: { dialect: 'cantonese', enabled: true },
    },
  });
  assert.equal(resolveDialectBias('hanako').dialect, 'sichuan');
  assert.equal(resolveDialectBias('yunying').dialect, 'cantonese');
  assert.notDeepEqual(
    resolveDialectBias('hanako').bias,
    resolveDialectBias('yunying').bias,
    '两个口音的气质权重不该一样',
  );
});

test('关掉的方言不算数', () => {
  writeDialectConfig({ agents: { yumi: { dialect: 'taiwan', enabled: false } } });
  assert.equal(resolveDialectBias('yumi').bias, null);
});

test('空 id、陌生 id 都不炸', () => {
  writeDialectConfig({ agents: {} });
  assert.equal(resolveDialectBias('').bias, null);
  assert.equal(resolveDialectBias(undefined).bias, null);
  assert.equal(resolveDialectBias('nobody').bias, null);
});

test('「学我说话」没有气质权重，照样不报错', () => {
  writeDialectConfig({ agents: { hanako: { dialect: 'userstyle', enabled: true } } });
  const out = resolveDialectBias('hanako');
  assert.equal(out.dialect, 'userstyle');
  assert.equal(out.bias, null, '用户自己的口吻没有预设气质表');
});
