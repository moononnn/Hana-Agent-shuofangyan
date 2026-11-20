/**
 * 受管模型通道适配层（App 版）
 *
 * 老代码调模型的姿势是「自己找供应商地址 → 自己拿密钥 → 自己拼 HTTP 请求发出去」。
 * 这在 App 地基上走不通：读宿主目录、取供应商凭据都受限，而且自己发出去的请求
 * 也不在宿主的受管通道里。所以统一改成走宿主自己的通道：
 *
 *   ctx.models.list()    → { models: [{ provider, id, input, reasoning, ... }] }
 *   ctx.models.stream()  → Promise<Response>，NDJSON，每行一个事件
 *        {type:"text-delta", delta} / {type:"reasoning-delta", delta}
 *        / {type:"done", assistant, usage} / {type:"error", code, message}
 *
 * 契约参考：茶话会 lib/model.js（同一宿主，同一套契约）。
 *
 * 两点刻意的设计：
 *   ① 思考通道（reasoning-delta）一律丢弃——正好满足「不暴露思考」；
 *   ② 非法 JSON 的杂项行不接进正文（实测过那样会冒出怪字符）。
 */

function rid(tag) {
  return `bqb_${tag}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 把 Response / ReadableStream / 异步可迭代读成文本。 */
export async function readModelBody(source) {
  if (source == null) return '';
  if (typeof source.text === 'function') {
    try {
      return await source.text();
    } catch {
      // 落到后面的流式读法
    }
  }
  const stream = source.body && typeof source.body.getReader === 'function' ? source.body : source;
  if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    return buffer;
  }
  if (typeof source[Symbol.asyncIterator] === 'function') {
    let buffer = '';
    for await (const chunk of source) buffer += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return buffer;
  }
  return String(source);
}

/** 把 NDJSON 文本解析成正文。思考通道丢弃；杂项行在有合法事件时一律不接。 */
export function parseModelNdjson(text) {
  let out = '';
  let events = 0;
  let errorMessage = null;
  let providerError = false;
  const strays = [];

  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let payload;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      strays.push(trimmed);
      continue;
    }
    events += 1;
    const type = payload?.type ?? null;
    if (type === 'text-delta') {
      if (!providerError && typeof payload.delta === 'string') out += payload.delta;
    } else if (type === 'reasoning-delta') {
      // 思考通道：故意丢弃
    } else if (type === 'error') {
      errorMessage = payload.message ?? payload.code ?? 'unknown error';
      providerError = payload.code === 'APP_MODEL_PROVIDER_ERROR';
    } else if (type === 'done') {
      const parts = payload?.assistant?.content;
      if (!out && !providerError && Array.isArray(parts)) {
        for (const part of parts) {
          if (part?.type === 'text' && typeof part.text === 'string') out += part.text;
        }
      }
    }
  }

  // 整份都是纯文本（一条合法事件都没有）时仍当正文，兼容个别 provider 的发法；
  // 已经有合法事件的，杂项行丢掉，不污染正文。
  if (!events && strays.length) return { text: strays.join('\n'), events: 0, errorMessage: null };
  return { text: out, events, errorMessage };
}

/** 宿主有没有受管模型通道。 */
export function hostModelReady(ctx) {
  return Boolean(ctx?.models?.stream);
}

/**
 * 走宿主通道调一次模型，返回正文。
 * messages 支持 { role, content } 文本，也支持带 base64 图片的内容块（识图用）。
 */
export async function callHostModel(ctx, options = {}) {
  const {
    provider,
    model,
    messages,
    systemPrompt = '',
    maxTokens,
    temperature,
    timeoutMs = 90000,
  } = options;

  if (!hostModelReady(ctx)) {
    return { ok: false, error: '当前宿主没有可用的模型通道', code: 'NO_HOST_MODEL_CHANNEL', text: '', events: 0 };
  }
  if (!provider || !model) {
    return { ok: false, error: '未指定模型', code: 'NO_MODEL_REF', text: '', events: 0 };
  }

  const requestId = rid('call');
  const payload = {
    requestId,
    provider: String(provider),
    model: String(model),
    messages: Array.isArray(messages) ? messages : [],
  };
  if (systemPrompt) payload.systemPrompt = systemPrompt;
  if (Number.isFinite(maxTokens) && maxTokens > 0) payload.maxTokens = Math.floor(maxTokens);
  if (Number.isFinite(temperature)) payload.temperature = temperature;

  let timer = null;
  let timedOut = false;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const error = new Error('模型调用超时');
      error.code = 'MODEL_TIMEOUT';
      reject(error);
    }, Math.max(1000, Number(timeoutMs) || 90000));
    timer.unref?.();
  });

  try {
    const result = await Promise.race([
      (async () => {
        const response = await ctx.models.stream(payload);
        return await readModelBody(response);
      })(),
      timeout,
    ]);
    const parsed = parseModelNdjson(result);
    return { ok: true, text: parsed.text.trim(), events: parsed.events, errorMessage: parsed.errorMessage, requestId };
  } catch (error) {
    // 超时后主动释放这次请求，别让它挂在宿主的活动表里
    if (timedOut) {
      try {
        await ctx.models.cancel?.(requestId);
      } catch {}
    }
    return { ok: false, error: error?.message || String(error), code: error?.code || null, text: '', events: 0, requestId };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── 模型目录 ──
// 宿主给的 ctx 是冻结的，不能往上面挂字段；目录只能存在本模块里。
// 开机由 index.js 灌一次，页面点「总结一次」时如果还是空，就现拉一次。
let hostModelCatalog = [];

/** 收录宿主模型目录，返回可用条数。 */
export function setHostModelCatalog(models) {
  const rows = Array.isArray(models) ? models : [];
  hostModelCatalog = rows.filter((m) => m && m.provider && m.id);
  return hostModelCatalog.length;
}

export function getHostModelCatalog() {
  return hostModelCatalog;
}

/** 目录为空时向宿主现拉一次；拉过就不重复拉（失败也不再每步重试）。 */
let catalogFetched = false;
export async function ensureHostModelCatalog(ctx) {
  if (hostModelCatalog.length) return hostModelCatalog;
  if (catalogFetched) return hostModelCatalog;
  if (typeof ctx?.models?.list !== 'function') return hostModelCatalog;
  catalogFetched = true;
  try {
    const result = await ctx.models.list();
    const rows = result?.models ?? result?.items ?? result;
    setHostModelCatalog(rows);
  } catch { /* 拉不到就当没有 */ }
  return hostModelCatalog;
}

/** 文本模型才算可用：目录里声明了 input 却没有 text 的（识图/向量）跳过。 */
function isTextModel(row, needImage) {
  const input = Array.isArray(row?.input) ? row.input : null;
  if (input && !input.includes('text')) return false;
  if (needImage && input && !input.includes('image')) return false;
  return true;
}

/** 从宿主模型目录里挑一个可用的模型引用。 */
export async function pickHostModel(ctx, { needImage = false, providerId = '', modelId = '' } = {}) {
  if (providerId && modelId) return { provider: providerId, model: modelId };
  const list = await ensureHostModelCatalog(ctx);
  const first = list.find((row) => isTextModel(row, needImage));
  return first ? { provider: first.provider, model: first.id } : null;
}
