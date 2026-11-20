// lib/agents.js — 伙伴名单
//
// App 沙箱读不到 <hana 主目录>/agents，但宿主有现成的伙伴名单接口（agent:list 带显示名）。
// 三个坑：
//   ① agent:list 默认只给「本 App 自己创建的伙伴」，那个分区里当然一个都没有 ——
//      必须显式要 scope: 'all'，才能跨出分区看到用户的伙伴（v0.2.1 修的就是这个：
//      页面上一句「宿主那边没给出伙伴名单」）。
//   ② 名单是异步的，启动那一刻可能还没拉到；页面来查时如果缓存空，再拉一次。
//   ③ 名单与「有没有人」是两件事：宿主拉得到但名单是空的，就是真的没有伙伴了。
//      这时候再退回列目录兜底，会把退休的、探针用的目录重新带回来（它们的人格文件还在），
//      于是刷新完名单反而多出一堆僵尸伙伴。所以「拉成功但为空」= 缓存清空、名单就是空，
//      只有「宿主明确不可用」才允许走目录兜底。
//
// 谁算有效伙伴：只看宿主给的状态字段（retired / probe 之类的），不看名字 ——
// 名字是人起的，不能拿来当身份判据。

let hostAgents = [];
let hostList = null;
let lastRefresh = { ok: null, error: null, at: null };

/** 宿主状态里代表「不该出现在伙伴列表」的取值。 */
const HIDDEN_STATES = ['retired', 'probe', 'probing', 'archived', 'deleted'];

/** 这些键当伙伴 id 会污染原型链，一律不当身份。 */
const RESERVED_IDS = new Set(['__proto__', 'prototype', 'constructor']);

/** 由 App 入口注入宿主名单接口（sdk.agents.list）。 */
export function setHostAgentSource(fn) {
  hostList = typeof fn === 'function' ? fn : null;
}

/** 宿主状态是不是「不该出现在列表里」。没给状态的一律当有效。 */
function isHiddenState(state) {
  if (state == null) return false;
  const text = String(state).trim().toLowerCase();
  if (!text) return false;
  if (text === 'active' || text === 'enabled') return false;
  return HIDDEN_STATES.some((s) => text.includes(s));
}

/** 伙伴 id 合不合法（只挡原型键、空串和带控制字符的乱造 id）。 */
export function isValidAgentId(agentId) {
  if (typeof agentId !== 'string') return false;
  const id = agentId.trim();
  if (!id || id.length > 128) return false;
  if (RESERVED_IDS.has(id) || RESERVED_IDS.has(id.toLowerCase())) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(id)) return false;
  return true;
}

/**
 * 把宿主返回的原始名单归一化成 [{id,name}]：
 * 退役的、探针的剔掉；没名字的用 id 顶上。
 */
export function normalizeRoster(list) {
  const primary = [];
  const regular = [];
  for (const row of Array.isArray(list) ? list : []) {
    const id = String(row?.id ?? '').trim();
    if (!isValidAgentId(id)) continue;
    if (isHiddenState(row?.state ?? row?.lifecycle)) continue;
    const normalized = { id, name: String(row?.name ?? '').trim() || id };
    (row?.isPrimary === true ? primary : regular).push(normalized);
  }
  return primary.concat(regular);
}

/**
 * 写进缓存。整份替换：拉回来是空的就是空（这是「刷新」的关键语义）。
 */
export function cacheHostAgents(list) {
  hostAgents = normalizeRoster(list);
  return hostAgents.length;
}

/**
 * 从宿主重新拉一次名单。
 * 返回 { ok, count, error }：
 *   ok=true  —— 拉到了（count 可能是 0，空名单也会把缓存清掉）
 *   ok=false —— 宿主不可用/接口报错，缓存保持原样（保留最近一次名单）
 */
export async function refreshAgentsFromHostDetailed() {
  if (!hostList) {
    const error = '宿主名单接口不可用';
    lastRefresh = { ok: false, error, at: new Date().toISOString() };
    return { ok: false, count: hostAgents.length, error, hostAvailable: false };
  }
  try {
    const result = await hostList({ scope: 'all', lifecycle: 'active' });
    const rows = result?.agents ?? result?.items ?? result;
    const count = cacheHostAgents(rows);
    lastRefresh = { ok: true, error: null, at: new Date().toISOString() };
    return { ok: true, count, error: null, hostAvailable: true };
  } catch (e) {
    // 拉不到就保留最近一次名单，绝不在这儿悄悄换成目录兜底。
    const error = `拉宿主名单失败：${e?.message || e}`;
    lastRefresh = { ok: false, error, at: new Date().toISOString() };
    return { ok: false, count: hostAgents.length, error, hostAvailable: false };
  }
}

/**
 * 从宿主重新拉一次名单。返回拿到的条数（0 表示还是空的）。
 * 老调用方（index.js 开机那次）继续按数字用，行为不变。
 */
export async function refreshAgentsFromHost() {
  const res = await refreshAgentsFromHostDetailed();
  return res.count;
}

/** 上一次刷新的结果（ok / error），给接口层报显式错误用。 */
export function getLastRefreshStatus() {
  return { ...lastRefresh };
}

/**
 * 只有一个 id 的兜底名单（列目录拿到的东西），补进缓存。
 * 只在「宿主明确不可用且手上没有缓存」的初次状态下用。
 */
export function adoptAgentIds(ids) {
  const rows = [];
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = String(raw ?? '').trim();
    if (!isValidAgentId(id)) continue;
    if (hostAgents.some((row) => row.id === id)) continue;
    rows.push({ id, name: id });
  }
  if (rows.length) hostAgents = hostAgents.concat(rows);
  return rows.length;
}

/** 当前缓存的完整名单（不区分可见/隐藏）。 */
export function listAgents() {
  return hostAgents.map((row) => ({ id: row.id, name: row.name }));
}

/** 清掉缓存（测试用；也方便以后加一个「刷新名单」按钮）。 */
export function resetAgentCache() {
  hostAgents = [];
  lastRefresh = { ok: null, error: null, at: null };
}

/** 某个伙伴的显示名；查不到就用 id 顶上（界面上至少不显示成一串英文）。 */
export function agentName(agentId) {
  const row = hostAgents.find((item) => item.id === agentId);
  return row ? row.name : agentId;
}
