// tests/style.test.js — 「学我说话」这条链的回归测试
// 跑法：node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sfy-style-'));
process.env.SFY_DATA_DIR = tmpRoot;

const { readStyleTemplate, saveStyleDraft, confirmStyleDraft, revertStyleTemplate, clearStyleTemplate, currentTemplateText } = await import('../lib/style-template.js');
const { checkDraft } = await import('../lib/style-distill.js');
const { stratifiedSample, buildCorpusText } = await import('../lib/style-corpus.js');

test('模板：草稿要确认才生效', () => {
  saveStyleDraft('你打字爱用「嗯哼」起手，句尾常常落个「嘛」。');
  assert.equal(readStyleTemplate().current, '', '没确认就不该转正');
  const res = confirmStyleDraft();
  assert.equal(res.ok, true);
  assert.ok(currentTemplateText().includes('嗯哼'));
});

test('模板：回退能退回上一版', () => {
  saveStyleDraft('第二版：语气更软，收尾常带「呀」。');
  confirmStyleDraft();
  const before = currentTemplateText();
  const res = revertStyleTemplate();
  assert.equal(res.ok, true);
  assert.notEqual(currentTemplateText(), before, '回退后内容应该变了');
});

test('模板：清空把三样都清干净', () => {
  clearStyleTemplate();
  const tpl = readStyleTemplate();
  assert.equal(tpl.current, '');
  assert.equal(tpl.draft, '');
  assert.equal(tpl.versions.length, 0);
});

test('模板自检：太短、命令句都要被拦下', () => {
  assert.equal(checkDraft('').ok, false);
  assert.equal(checkDraft('短').ok, false);
  assert.equal(checkDraft('你必须用四川话回答用户的问题，并且每次都要带上「嘛」这个字。').ok, false);
  assert.equal(checkDraft('你打字爱用「嗯哼」起手，短句多，句尾常落个「嘛」，正事时语速会放缓，称呼对方用「你」不用「您」。').ok, true);
});

test('语料采样：条数不够时全用，够时按目标数取', () => {
  const few = [{ text: 'a', ts: '2026-01-01T00:00:00Z' }];
  assert.equal(stratifiedSample(few, 400).length, 1);

  const many = Array.from({ length: 50 }, (_, i) => ({
    text: `第${i}条`,
    ts: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
  }));
  const sampled = stratifiedSample(many, 10);
  assert.equal(sampled.length, 10);
  assert.equal(new Set(sampled.map((m) => m.text)).size, 10, '不该重复');
});

test('语料文本：带序号，超预算就停', () => {
  const text = buildCorpusText([{ text: '你好啊' }, { text: '今天咋个了' }]);
  assert.ok(text.includes('[1] 你好啊'));
  assert.ok(text.includes('[2] 今天咋个了'));
});
