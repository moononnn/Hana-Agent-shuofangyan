// lib/dialect-config.js — 方言配置的读写与归一化
//
// 配置结构（与表情包应用里的历史结构一致，方便一次性迁移）：
//   { version: 4, agents: { <伙伴id>: { dialect: 'sichuan', enabled: true } } }
//
// v4 起不再有 boost：「加浓」两档已合并成精修文案一档（见 lib/dialect-persona.js），
// 旧配置里的 boost 字段读进来就丢掉，等价于自动升到浓的那一版。
//
// 「不配置 = 不带方言」。选了再取消，就把这个伙伴的条目删掉。
// 写盘与人格文件是两件事：这里只管配置，落到人格文件见 lib/dialect-persona.js。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, atomicWriteJson } from './app-paths.js';
import { getDialect } from './dialect-data.js';

const CONFIG_FILE = process.env.SFY_DIALECT_CONFIG
  || path.join(DATA_DIR, 'dialect-config.json');
const LOG_FILE = path.join(DATA_DIR, 'dialect-log.json');

let cache = null;

export function getDialectConfigFile() {
  return CONFIG_FILE;
}

/** 归一化：只认认识的方言 id，enabled 统一成布尔；旧版的 boost 字段直接丢弃。 */
function normalizeConfig(raw) {
  const out = { version: 4, agents: {} };
  const agents = raw && typeof raw.agents === 'object' && !Array.isArray(raw.agents)
    ? raw.agents
    : {};
  for (const [agentId, value] of Object.entries(agents)) {
    if (!agentId || typeof agentId !== 'string') continue;
    const id = String(value?.dialect ?? '');
    if (!id || !getDialect(id)) continue;
    const entry = { dialect: id, enabled: value?.enabled !== false };
    out.agents[agentId] = entry;
  }
  return out;
}

export function readDialectConfig() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    cache = normalizeConfig(raw);
  } catch {
    cache = normalizeConfig(null);
  }
  return cache;
}

export function writeDialectConfig(config) {
  cache = normalizeConfig(config);
  atomicWriteJson(CONFIG_FILE, cache);
  return cache;
}

/** 某个伙伴的方言设置；没开或方言不认识就返回 null。 */
export function getAgentDialectSetting(agentId) {
  const setting = readDialectConfig().agents[agentId];
  if (!setting || setting.enabled === false) return null;
  if (!getDialect(setting.dialect)) return null;
  return setting;
}

/** 变更日志：给排查用，只留最近 20 条。 */
export function appendDialectLog(entry) {
  let list = [];
  try {
    const raw = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    if (Array.isArray(raw)) list = raw;
  } catch { /* 没有就当空 */ }
  list.unshift({ ...entry, at: new Date().toISOString() });
  list = list.slice(0, 20);
  try {
    atomicWriteJson(LOG_FILE, list);
  } catch { /* 日志写不进去不影响主流程 */ }
  return list;
}

export function readDialectLog(limit = 20) {
  try {
    const raw = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    return Array.isArray(raw) ? raw.slice(0, limit) : [];
  } catch {
    return [];
  }
}
