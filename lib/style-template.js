// lib/style-template.js — 「学我说话」的模板存取
//
// 模板就是一段描述「用户自己怎么说话」的文字，由模型从用户的历史发言里总结出来。
// 它是「说方言」里的第 10 种方言：伙伴选了「学我说话」，人格文件里写的就是这份模板。
//
// 存三份东西：
//   current   当前采用的模板（写进人格文件的就是它）
//   draft     刚总结出来、还没确认的草稿（等用户点头才采用）
//   versions  历史版本（可以回退到上一版）
//
// 每次改动都留着上一版：模型总结这种事不保证一次比一次好，得给用户留后悔药。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR, atomicWriteJson } from './app-paths.js';

const TEMPLATE_FILE = path.join(DATA_DIR, 'style-template.json');

export const TEMPLATE_MAX_CHARS = 600;

function emptyTemplate() {
  return { version: 1, current: '', current_at: '', draft: '', draft_at: '', versions: [] };
}

export function getStyleTemplateFile() {
  return TEMPLATE_FILE;
}

export function readStyleTemplate() {
  try {
    const raw = JSON.parse(fs.readFileSync(TEMPLATE_FILE, 'utf8'));
    const base = emptyTemplate();
    return {
      ...base,
      ...raw,
      versions: Array.isArray(raw?.versions) ? raw.versions : [],
    };
  } catch {
    return emptyTemplate();
  }
}

export function writeStyleTemplate(tpl) {
  atomicWriteJson(TEMPLATE_FILE, tpl);
  return tpl;
}

/** 存草稿（总结完先放这儿，用户确认后才采用）。 */
export function saveStyleDraft(draft) {
  const tpl = readStyleTemplate();
  const text = String(draft || '').trim().slice(0, TEMPLATE_MAX_CHARS);
  if (!text) return { ok: false, error: '模板是空的' };
  if (tpl.draft) {
    tpl.versions.unshift({ text: tpl.draft, at: tpl.draft_at || '', kind: 'draft' });
    tpl.versions = tpl.versions.slice(0, 10);
  }
  tpl.draft = text;
  tpl.draft_at = new Date().toISOString();
  writeStyleTemplate(tpl);
  return { ok: true, draft: text };
}

/** 采用草稿：当前版本归档进 versions，draft 转正。 */
export function confirmStyleDraft() {
  const tpl = readStyleTemplate();
  const text = String(tpl.draft || '').trim();
  if (!text) return { ok: false, error: '还没有草稿可采用' };
  if (tpl.current) {
    tpl.versions.unshift({ text: tpl.current, at: tpl.current_at || '', kind: 'adopted' });
    tpl.versions = tpl.versions.slice(0, 10);
  }
  tpl.current = text;
  tpl.current_at = new Date().toISOString();
  tpl.draft = '';
  tpl.draft_at = '';
  writeStyleTemplate(tpl);
  return { ok: true, template: tpl.current };
}

/** 保留已采用模板：当前/profile 不变，把草稿归档并清掉待决定字段。 */
export function keepCurrentStyleDraft() {
  const tpl = readStyleTemplate();
  if (!String(tpl.current || '').trim()) {
    return { ok: false, error: '还没有已采用的模板，不能保留原版' };
  }
  if (!String(tpl.draft || '').trim()) {
    return { ok: false, error: '没有待决定的草稿' };
  }
  tpl.versions.unshift({ text: tpl.draft, at: tpl.draft_at || '', kind: 'draft' });
  tpl.versions = tpl.versions.slice(0, 10);
  tpl.draft = '';
  tpl.draft_at = '';
  writeStyleTemplate(tpl);
  return { ok: true };
}

/** 历史版本 ID 不改存档结构，由正文与时间戳稳定派生。 */
export function styleVersionId(version) {
  const text = String(version?.text ?? '');
  const at = String(version?.at ?? '');
  return createHash('sha256').update(JSON.stringify([text, at]), 'utf8').digest('hex');
}

/** 回退到上一版，或恢复指定历史版本；草稿保持不变。 */
export function revertStyleTemplate(versionId) {
  const tpl = readStyleTemplate();
  let index = -1;
  if (versionId !== undefined) {
    if (typeof versionId !== 'string' || !versionId) {
      return { ok: false, error: '指定的历史版本无效' };
    }
    index = tpl.versions.findIndex((version) => styleVersionId(version) === versionId);
    if (index < 0) return { ok: false, error: '指定的历史版本已不存在，请刷新后重试' };
  } else {
    // 旧式回退只处理曾采用过的版本；草稿必须由用户通过 versionId 明确选择。
    index = tpl.versions.findIndex((version) => version?.kind !== 'draft');
    if (index < 0) return { ok: false, error: '没有可回退的已采用版本' };
  }

  const [selected] = tpl.versions.splice(index, 1);
  if (tpl.current) {
    tpl.versions.unshift({ text: tpl.current, at: tpl.current_at || '', kind: 'adopted' });
  }
  tpl.versions = tpl.versions.slice(0, 10);
  tpl.current = selected.text || '';
  tpl.current_at = selected.at || '';
  writeStyleTemplate(tpl);
  return { ok: true, template: tpl.current };
}

/** 清空：当前版本、版本历史、草稿全清。 */
export function clearStyleTemplate() {
  const tpl = emptyTemplate();
  writeStyleTemplate(tpl);
  return { ok: true };
}

/** 取当前模板正文（写人格文件时用）。 */
export function currentTemplateText() {
  try {
    return String(readStyleTemplate().current || '').trim();
  } catch {
    return '';
  }
}
