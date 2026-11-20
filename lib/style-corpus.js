// lib/style-corpus.js — 采集「学我说话」的语料
//
// 语料就是用户自己说过的话。从某个伙伴的会话记录里把用户消息挑出来，
// 再分层采样一批（近期权重高，但也要覆盖更早的时间）。
//
// 读会话文件走宿主通道（ctx.resources）：App 沙箱读不到 <hana 主目录>/agents/<id>/sessions/。

import path from 'node:path';
import { listDirNames, readPersonaText } from './persona-io.js';
import { resolveAgentsRoot } from './dialect-persona.js';

const MSG_MAX_CHARS = 200;
const FEED_MAX_MSGS = 400;
const CHUNK_CHAR_BUDGET = 24000;

const RESERVED_AGENT_IDS = new Set(['__proto__', 'prototype', 'constructor']);

/** 宿主在消息前后加的隐藏块（指令、时间戳之类），不能进语料。 */
function stripHiddenMessageBlocks(text) {
  return String(text)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<[^>]*hana[^>]*>[\s\S]*?<\/[^>]*hana[^>]*>/gi, '')
    .trim();
}

/** 太短、太像自动生成的消息，不算人的说话习惯。 */
function looksNatural(text) {
  const t = String(text).trim();
  if (t.length < 4) return false;
  if (!/[\p{L}\p{N}]/u.test(t)) return false;
  if (/^(?:ok|好的|收到|嗯+|谢谢|好的，?)\s*$/i.test(t)) return false;
  return true;
}

export async function collectUserMessages(agentId, agentsRoot) {
  if (typeof agentId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(agentId)
    || RESERVED_AGENT_IDS.has(agentId)) {
    return { ok: false, error: `非法伙伴 ID: ${JSON.stringify(agentId)}` };
  }
  const root = agentsRoot || await resolveAgentsRoot();
  const sessionsDir = path.join(path.resolve(root, 'agents'), agentId, 'sessions');
  const listed = await listDirNames(sessionsDir);
  const files = listed.filter((f) => f.endsWith('.jsonl') && !f.includes('.files.json'));
  files.sort((a, b) => b.localeCompare(a)); // 从新到旧

  const messages = [];
  for (const f of files) {
    const read = await readPersonaText(path.join(sessionsDir, f));
    if (!read.ok) continue;
    for (const line of read.text.split('\n')) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry?.type !== 'message') continue;
      const msg = entry.message;
      if (!msg || msg.role !== 'user') continue;
      const content = msg.content;
      let text = '';
      if (typeof content === 'string') text = content;
      else if (Array.isArray(content)) {
        text = content
          .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
          .map((p) => p.text)
          .join('\n');
      }
      const visible = stripHiddenMessageBlocks(text);
      if (!visible || !looksNatural(visible)) continue;
      messages.push({ text: visible.slice(0, MSG_MAX_CHARS), ts: entry.timestamp || '' });
      if (messages.length >= 200000) break;
    }
  }
  return { ok: true, messages, total: messages.length };
}

/** 分层采样：按天分桶，近期桶权重高；目标 N 条均匀覆盖时间跨度。 */
export function stratifiedSample(messages, targetN) {
  const n = Math.max(1, Math.floor(targetN) || 1);
  const sorted = [...messages].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  if (sorted.length <= n) return sorted;

  const buckets = new Map();
  for (const m of sorted) {
    const day = (m.ts || '').slice(0, 10) || 'unknown';
    if (!buckets.has(day)) buckets.set(day, []);
    buckets.get(day).push(m);
  }
  const days = [...buckets.keys()].sort();
  const out = [];
  let round = 0;
  // 近期排前面：日期倒序，同一天的算同一桶
  const ordered = days.slice().reverse();
  while (out.length < n && round < 50) {
    let added = 0;
    for (const day of ordered) {
      const bucket = buckets.get(day);
      if (!bucket || round >= bucket.length) continue;
      out.push(bucket[bucket.length - 1 - round]);
      added += 1;
      if (out.length >= n) break;
    }
    if (!added) break;
    round += 1;
  }
  return out.reverse();
}

/** 把采样结果拼成喂给模型的语料文本（带序号，方便模型引用）。 */
export function buildCorpusText(messages) {
  const lines = [];
  let budget = CHUNK_CHAR_BUDGET;
  for (let i = 0; i < messages.length; i++) {
    const line = `[${i + 1}] ${messages[i].text}`;
    if (line.length > budget) break;
    budget -= line.length;
    lines.push(line);
  }
  return lines.join('\n');
}

export const STYLE_FEED_MAX_MSGS = FEED_MAX_MSGS;
