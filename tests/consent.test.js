// tests/consent.test.js — 首次确认的凭据存取
// 跑法：node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sfy-consent-'));
process.env.SFY_DATA_DIR = tmpRoot;

const { readConsent, acceptConsent } = await import('../lib/consent.js');

const CONSENT_FILE = path.join(tmpRoot, 'consent.json');

test('没确认过就是没确认过，不猜', () => {
  assert.equal(readConsent().accepted, false);
  assert.equal(readConsent().at, '');
});

test('确认一次就记住，并留下时间', () => {
  const record = acceptConsent();
  assert.equal(record.accepted, true);
  assert.ok(record.at, '应该带上确认时间');
  const back = readConsent();
  assert.equal(back.accepted, true);
  assert.equal(back.at, record.at);
});

test('文件读坏了按没确认处理，不冒认', () => {
  fs.writeFileSync(CONSENT_FILE, '{ 这不是 json', 'utf8');
  assert.equal(readConsent().accepted, false);
});

test('只认布尔 true，别的写法都不算确认', () => {
  fs.writeFileSync(CONSENT_FILE, JSON.stringify({ accepted: 'yes' }), 'utf8');
  assert.equal(readConsent().accepted, false);
  fs.writeFileSync(CONSENT_FILE, JSON.stringify({ accepted: 1 }), 'utf8');
  assert.equal(readConsent().accepted, false);
  fs.writeFileSync(CONSENT_FILE, JSON.stringify({ accepted: true, at: 123 }), 'utf8');
  const back = readConsent();
  assert.equal(back.accepted, true);
  assert.equal(back.at, '', '时间不是字符串就当没有');
});
