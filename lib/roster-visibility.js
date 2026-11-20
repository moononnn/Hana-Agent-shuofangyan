// lib/roster-visibility.js — 「谁在名单上显示」这件事的独立存档
//
// 两份名单分开存：
//   · 伙伴名册（lib/agents.js）：宿主那边到底有哪些伙伴，属于「事实」
//   · 可见名单（本文件）：用户把谁从界面上藏起来了，属于「偏好」
//
// 偏好单独存，不塞进方言配置、人格文件或伙伴名册里：
//   · 藏起来只是界面上不显示，方言照写、同步照跑
//   · 伙伴名册是宿主的，App 往里写会被下次刷新冲掉
//
// 存法：稳定 id 当身份，名字只是显示备份。
//   · 用 id 不用名字：名字会改，id 不会
//   · 隐藏时把名字存下来：那位伙伴之后不在名册里了，界面上还能显示「你藏了谁」
//   · 只存隐藏中的那些：放回来就直接删掉这一条
//   · 旧版/坏文件一律当空名单，不报错也不迁移
//
// 文件格式（独立文件，不碰别的）：
//   { "version": 1, "hidden": [ { "id": "hanako", "name": "汉娜" } ] }

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, atomicWriteJson } from './app-paths.js';
import { isValidAgentId } from './agents.js';

const VISIBILITY_FILE = path.join(DATA_DIR, 'roster-visibility.json');
const FILE_VERSION = 1;

let cache = null;

export function rosterVisibilityFile() {
  return VISIBILITY_FILE;
}

/** id 合不合法：躲开原型键、空串、乱造 id（空白、控制字符、超长）。 */
function validId(agentId) {
  if (!isValidAgentId(agentId)) return false;
  const id = String(agentId).trim();
  return id.length > 0 && !/\s/.test(id);
}

/** 读存档。旧版/坏文件 → 空名单。 */
export function readRosterVisibility() {
  if (cache) return cache;
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(VISIBILITY_FILE, 'utf8'));
  } catch {
    raw = null;
  }
  const hidden = [];
  const seen = new Set();
  for (const item of Array.isArray(raw?.hidden) ? raw.hidden : []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const id = String(item.id ?? '').trim();
    if (!validId(id) || seen.has(id)) continue;
    seen.add(id);
    const name = String(item.name ?? '').trim();
    hidden.push({ id, name: name && name.length <= 128 ? name : id });
  }
  cache = { version: FILE_VERSION, hidden };
  return cache;
}

/** 藏起来的 id 集合。 */
export function hiddenAgentIds() {
  return new Set(readRosterVisibility().hidden.map((entry) => entry.id));
}

/**
 * 藏起来的那几位：在名册里的用当前名字，不在名册里的用隐藏时存下的名字。
 */
export function listHiddenAgents(roster = []) {
  const nameById = new Map();
  for (const row of Array.isArray(roster) ? roster : []) {
    const id = String(row?.id ?? '').trim();
    if (id) nameById.set(id, String(row?.name ?? '').trim() || id);
  }
  return readRosterVisibility().hidden.map((entry) => ({
    id: entry.id,
    name: nameById.get(entry.id) || entry.name || entry.id,
  }));
}

/**
 * 改可见性。hidden=true 藏起来，hidden=false 放回来。
 *
 * 只写本文件：不碰方言配置、不碰人格文件、不碰宿主名册，也不去探测模型。
 * 隐藏要求这位伙伴此刻确实在名册里（名册空着就不许凭空藏人）。
 * 放回来只删这一条记录：他暂时不在名册里也能放回来。
 */
export function setAgentHidden(agentId, hidden, opts = {}) {
  const id = String(agentId ?? '').trim();
  if (!validId(id)) {
    return { ok: false, error: `伙伴 id 不合法：${JSON.stringify(String(agentId ?? ''))}` };
  }
  const roster = Array.isArray(opts.roster) ? opts.roster : [];
  const current = readRosterVisibility();
  const entries = current.hidden.map((entry) => ({ ...entry }));
  const idx = entries.findIndex((entry) => entry.id === id);

  if (hidden === true) {
    const rosterRow = roster.find((row) => String(row?.id ?? '').trim() === id);
    if (!rosterRow) {
      return { ok: false, error: `当前名单里没有「${id}」这位伙伴` };
    }
    const name = String(rosterRow.name ?? '').trim() || id;
    if (idx >= 0) entries[idx] = { id, name: entries[idx].name || name };
    else entries.push({ id, name });
  } else if (idx >= 0) {
    entries.splice(idx, 1);
  } else {
    return { ok: true, hidden: entries };   // 本来就没藏着，幂等
  }

  const next = { version: FILE_VERSION, hidden: entries };
  try {
    atomicWriteJson(VISIBILITY_FILE, next);
  } catch (e) {
    return { ok: false, error: `写可见名单失败：${e?.message || e}` };
  }
  cache = next;
  return { ok: true, hidden: entries };
}

/**
 * 按当前名册算一遍：可见的与藏起来的。只读，不写盘。
 * 名册是事实，藏起来只是不显示 —— 方言那套逻辑不查这里。
 */
export function applyVisibility(roster = []) {
  const rows = Array.isArray(roster) ? roster : [];
  const hiddenIds = hiddenAgentIds();
  const agents = rows
    .filter((row) => !hiddenIds.has(String(row?.id ?? '').trim()))
    .map((row) => ({ id: row.id, name: row.name }));
  return { agents, hiddenAgents: listHiddenAgents(rows) };
}

/** 清缓存（测试用；重启回读也是靠它）。 */
export function resetRosterVisibilityCache() {
  cache = null;
}
