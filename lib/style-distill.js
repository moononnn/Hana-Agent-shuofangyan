// lib/style-distill.js — 让模型把用户的说话方式总结成一段可执行的描述
//
// 输入：一批用户自己的发言（语料）。
// 输出：一段第二人称的描述（≤600 字），写进伙伴人格文件后，ta 就会照着这个风格打字。
//
// 这一步是「学我说话」的核心，也是最容易出错的一步：
//   · 语料里全是用户的私人内容，模型总结时不能把内容本身抄进模板（那是复述，不是风格）
//   · 模板要可执行：说「你打字爱用『嗯哼』开头」比说「用户比较随性」有用得多
//   · 模型偶尔会写成「用户希望助手……」这种指令句，那会变成人格注入，越权了
// 所以 parse 之后要过一道自检，不合格的直接判失败。

import { collectUserMessages, stratifiedSample, buildCorpusText, STYLE_FEED_MAX_MSGS } from './style-corpus.js';
import { callHostModel, pickHostModel } from './model-host.js';
import { saveStyleDraft, TEMPLATE_MAX_CHARS } from './style-template.js';

const SYSTEM_PROMPT = [
  '你在做一件事：把一个人的说话习惯，整理成一段让另一个助手能照着模仿的描述。',
  '只描述**可观察的打字规律**：口头禅、起手式、句尾习惯、标点偏好、句子长短、称呼方式、语气强弱。',
  '不要复述用户说过的具体事情，不要出现用户私人的事实、名字、地点。',
  '不要写成对助手的命令（不要出现「你必须」「助手应该」「请记住」这类祈使句）。',
].join('\n');

function buildUserPrompt(corpusText, userName) {
  return [
    `下面这些是「${userName}」自己打字的原话：`,
    '',
    corpusText,
    '',
    '请按下面的要求写这段描述：',
    '1. 用第二人称「你」来写（这份描述会直接放进助手的口吻设定里）；',
    '2. 写 200 到 600 字，只写正文，不要标题、不要列表、不要解释你在做什么；',
    '3. 每一句都要是可照做的规则（怎么起手、怎么收尾、什么情况下换语气），不要「比较自然」这种空话；',
    '4. 只用你自己的话概括，不要引用上面的原句。',
  ].join('\n');
}

/** 模型输出里剥掉 markdown 围栏和多余的前后缀。 */
function cleanDraft(raw) {
  let text = String(raw || '').trim();
  text = text.replace(/^```[a-zA-Z]*\s*/g, '').replace(/\s*```$/g, '');
  text = text.replace(/^(?:模板|描述|风格描述|口吻)[：:]\s*/i, '');
  return text.trim().slice(0, TEMPLATE_MAX_CHARS);
}

/** 自检：模板里不能出现对助手的命令句，也不能太短（太短基本等于没总结）。 */
export function checkDraft(text) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, error: '模型没给出内容' };
  if (t.length < 24) return { ok: false, error: '模板太短，基本等于没总结，请再试一次' };
  const imperative = /(?:^|[。！？\n])\s*(?:你必须|你应当|你要|请|务必|必须|记住|助手应当|助手必须|助手要)/.test(t);
  if (imperative) return { ok: false, error: '模板里混进了命令句（要求助手做什么），这不该写进人格文件，请再试一次' };
  return { ok: true };
}

/**
 * 跑一次总结：采集语料 → 采样 → 调模型 → 存草稿。
 * 返回 { ok, draft, sampleCount, total } 或 { ok:false, error }。
 */
export async function runStyleSummary({ sdk, agentId, userName, modelRef, onPhase = () => {} }) {
  const collected = await collectUserMessages(agentId);
  if (!collected.ok) return { ok: false, error: collected.error };
  if (!collected.messages.length) {
    return { ok: false, error: '这位伙伴的会话里没有可用的发言，没法总结' };
  }

  const sample = stratifiedSample(collected.messages, STYLE_FEED_MAX_MSGS);
  const corpusText = buildCorpusText(sample);
  if (!corpusText.trim()) return { ok: false, error: '采样后语料是空的' };

  onPhase('distilling');
  const ref = modelRef || await pickHostModel(sdk);
  if (!ref) return { ok: false, error: '没有可用的模型，先在 Hana 里配好模型再试' };

  const result = await callHostModel(sdk, {
    provider: ref.provider,
    model: ref.model,
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(corpusText, userName) }],
    maxTokens: 1200,
    temperature: 0.4,
    timeoutMs: 120000,
  });
  if (!result.ok) return { ok: false, error: result.error || '模型调用失败' };
  if (!result.text) return { ok: false, error: result.errorMessage || '模型没给出内容' };

  const draft = cleanDraft(result.text);
  const check = checkDraft(draft);
  if (!check.ok) return { ok: false, error: check.error };

  onPhase('saving');
  const saved = saveStyleDraft(draft);
  if (!saved.ok) return { ok: false, error: saved.error };

  return {
    ok: true,
    draft,
    sampleCount: sample.length,
    total: collected.total,
  };
}
