// lib/dialect-bias.js — 某个伙伴的方言气质权重（给别的应用查）
//
// 表情包按方言气质给候选图重新打分，就是来问这个。
// 只读：不读人格文件、不改配置、不碰任何东西。
//
// 单独放一层是为了能测：index.js 那边只负责把它挂上 bus，逻辑在这里。

import { getDialect, DIALECT_EXPRESSION_BIAS } from './dialect-data.js';
import { getAgentDialectSetting } from './dialect-config.js';

/** 没开方言、或者口音认不出来，都返回一份「没有气质」的空结果。 */
function empty(agentId) {
  return { agentId, dialect: null, name: '', label: '', bias: null };
}

export function resolveDialectBias(agentId) {
  const id = String(agentId || '').trim();
  if (!id) return empty('');
  const setting = getAgentDialectSetting(id);
  if (!setting) return empty(id);
  const dialect = getDialect(setting.dialect);
  if (!dialect) return empty(id);
  const bias = DIALECT_EXPRESSION_BIAS[setting.dialect] || null;
  return {
    agentId: id,
    dialect: setting.dialect,
    name: dialect.name,
    label: bias?.label || '',
    bias,
  };
}
