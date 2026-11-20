// tests/panel.test.js — 「口音小册」前端最小回归
//
// 不引第三方依赖：用一副够用的假 DOM 把 ui/assets/panel.js 原样跑起来，
// 只钉住真正容易坏、而且坏了用户会直接看见的几件事：
//   1. 刷新名单走 GET /api/state?refresh=1，连点不会重复发请求
//   2. 刷新失败不丢现有名单，只在提示行里说清楚
//   3. 隐藏 / 恢复的请求体与顺序对，隐藏后学我说话的下拉跟着换名单
//   4. 名单操作排在口音写入后面，不会被旧响应盖回去
//   5. 口音写失败有反馈，而且还能再点一次重试

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'ui', 'assets', 'panel.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'ui', 'panel.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'ui', 'assets', 'panel.css'), 'utf8');

// ── 假 DOM ──────────────────────────────────────────────
function makeEl(id) {
  const el = {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    hidden: false,
    disabled: false,
    open: false,
    className: '',
    style: {},
    attrs: {},
    handlers: {},
    focused: false,
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, on) {
        if (on === undefined) on = !this._set.has(c);
        if (on) this._set.add(c); else this._set.delete(c);
      },
      contains(c) { return this._set.has(c); },
    },
    addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); },
    removeEventListener() {},
    dispatch(type, event) { (this.handlers[type] || []).forEach((fn) => fn({ ...event, currentTarget: this })); },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    focus() { el.focused = true; },
    scrollIntoView() {},
  };
  return el;
}

function jsonResp(data, ok = true, status = 200) {
  return { ok, status, json: async () => data };
}

// 假的事件目标：closest(选择器) 按剧本回答
function clickTarget(matchers) {
  return {
    closest(sel) {
      return Object.prototype.hasOwnProperty.call(matchers, sel) ? matchers[sel] : null;
    },
  };
}

function cardOf(agentId) {
  return { getAttribute: () => agentId };
}

function createApp(respond) {
  const calls = [];
  const els = new Map();
  const getEl = (id) => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  };
  const doc = {
    handlers: {},
    getElementById: getEl,
    querySelectorAll: () => [],
    addEventListener(type, fn) { (doc.handlers[type] = doc.handlers[type] || []).push(fn); },
  };
  const win = {
    __PANEL_TEST__: true,
    location: { search: '', pathname: '/api/apps/shuo-fangyan/ui/panel.html' },
  };
  const fetchStub = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(respond(url, init, calls));
  };
  const run = new Function(
    'window', 'document', 'fetch', 'Headers', 'URLSearchParams', 'AbortController',
    SRC,
  );
  run(win, doc, fetchStub, Headers, URLSearchParams, AbortController);
  // 假 DOM 里没有真的 DOM，但名单得能从 innerHTML 里读出来：
  // findCard / applyOpenState 要靠它，展开与刷新的判断才测得到。
  const board = getEl('board');
  board.querySelectorAll = function (sel) {
    if (sel !== '.agent') return [];
    const ids = [];
    const re = /data-agent="([^"]*)"/g;
    let m;
    while ((m = re.exec(board.innerHTML || ''))) ids.push(m[1]);
    return ids.map((id) => ({
      getAttribute: (k) => (k === 'data-agent' ? id : null),
      classList: { toggle() {}, add() {}, remove() {} },
      querySelector: () => null,
      querySelectorAll: () => [],
    }));
  };
  return {
    calls,
    el: getEl,
    win,
    doc,
    urls: () => calls.map((c) => c.url),
  };
}

async function waitFor(fn, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

const BASE_STATE = {
  dialects: [
    { id: 'sichuan', name: '四川话', tagline: '巴适得板', example: '你在搞啥子嘛' },
    { id: 'userstyle', name: '学我说话', tagline: '', example: '' },
  ],
  agents: [{ id: 'a1', name: '小花' }, { id: 'a2', name: '小草' }],
  hiddenAgents: [],
  config: { agents: {} },
  actual: {},
  agentSource: 'cache',
  modelReady: true,
};

// 每次回话都现拷一份：页面拿到的是同一个 config 对象，
// 页面改口音时会写进去，不拷贝的话一个用例会把下一个用例的夹具改了。
function stateData(overrides) {
  return structuredClone({ ...BASE_STATE, ...(overrides || {}) });
}

function defaultRespond(overrides = {}) {
  return (url, init) => {
    const key = Object.keys(overrides).find((k) => url.includes(k));
    if (key) { const v = overrides[key]; return typeof v === 'function' ? v(url, init) : v; }
    if (url.includes('/api/state')) return jsonResp({ ok: true, data: stateData() });
    if (url.includes('/api/style-template')) {
      return jsonResp({ ok: true, data: { current: '', current_at: '', draft: '', versionCount: 0 } });
    }
    if (url.includes('/api/dialect')) return jsonResp({ ok: true, failures: [] });
    if (url.includes('/api/roster-visibility')) {
      return jsonResp({ ok: true, data: { agents: stateData().agents, hiddenAgents: [] } });
    }
    return jsonResp({ ok: false, error: '未知接口 ' + url }, false, 404);
  };
}

// ── 用例 ────────────────────────────────────────────────
test('页签支持ARIA方向键切换，隐藏页不可聚焦且稿本选择保留', async () => {
  const app = createApp(defaultRespond({
    '/api/style-template': jsonResp({ ok: true, data: {
      current: '已采用', draft: '',
      versions: [
        { id: 'v1', text: '旧历史', at: '2026-04-01' },
        { id: 'v2', text: '新历史', at: '2026-05-01' },
      ],
    } }),
  }));
  assert.ok(await waitFor(() => app.el('style-text').textContent === '新历史'));
  app.el('style-version').value = 'v1';
  app.el('style-version').dispatch('change', {});
  assert.equal(app.el('style-text').textContent, '旧历史');

  let prevented = false;
  app.el('tab-dialect').dispatch('keydown', { key: 'ArrowRight', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(app.el('tab-style').attrs['aria-selected'], 'true');
  assert.equal(app.el('panel-dialect').hidden, true);
  assert.equal(app.el('panel-dialect').inert, true);
  assert.equal(app.el('panel-style').hidden, false);
  assert.equal(app.el('style-version').value, 'v1');
  app.el('tab-style').dispatch('keydown', { key: 'ArrowLeft', preventDefault() {} });
  assert.equal(app.el('tab-dialect').attrs['aria-selected'], 'true');
  assert.equal(app.el('panel-style').inert, true);
  app.el('tab-dialect').dispatch('keydown', { key: 'ArrowRight', preventDefault() {} });
  assert.equal(app.el('style-version').value, 'v1');
  assert.equal(app.el('style-text').textContent, '旧历史');
});

test('userstyle独立于方言格；无已采用模板时引导查看且不写口音', async () => {
  const app = createApp(defaultRespond({
    '/api/state': jsonResp({ ok: true, data: stateData({
      config: { agents: { a1: { dialect: 'sichuan', enabled: true } } },
    }) }),
    '/api/style-template': jsonResp({ ok: true, data: { current: '', draft: '待采用草稿', versions: [] } }),
  }));
  assert.ok(await waitFor(() => app.el('board').innerHTML.includes('userstyle-row')));
  assert.ok(!app.el('board').innerHTML.includes('data-dialect="userstyle"'));
  assert.ok(app.el('board').innerHTML.includes('用我的口吻'));
  assert.ok(app.el('board').innerHTML.includes('启用会替代当前方言'));

  const target = (selector) => clickTarget({ '.agent': cardOf('a1'), [selector]: {} });
  app.el('board').dispatch('click', { target: target('[data-act="userstyle"]') });
  assert.equal(app.el('tab-style').attrs['aria-selected'], 'true');
  assert.match(app.el('style-status').textContent, /模板还是草稿/);
  assert.equal(app.win.__panelTest.state.config.agents.a1.dialect, 'sichuan');
  assert.equal(app.calls.filter((call) => call.url.includes('/api/dialect')).length, 0);

  app.el('tab-dialect').dispatch('click', {});
  app.el('board').dispatch('click', { target: target('[data-act="view-style"]') });
  assert.equal(app.el('tab-style').attrs['aria-selected'], 'true');
  assert.equal(app.win.__panelTest.state.config.agents.a1.dialect, 'sichuan');
  assert.equal(app.calls.filter((call) => call.url.includes('/api/dialect')).length, 0);
});

test('有已采用模板时显式启用userstyle写入排他的同一方言设置', async () => {
  const app = createApp(defaultRespond({
    '/api/state': jsonResp({ ok: true, data: stateData({
      config: { agents: { a1: { dialect: 'sichuan', enabled: true } } },
    }) }),
    '/api/style-template': jsonResp({ ok: true, data: { current: '已采用口吻', draft: '', versions: [] } }),
  }));
  assert.ok(await waitFor(() => app.el('board').innerHTML.includes('userstyle-row')));
  app.el('board').dispatch('click', { target: clickTarget({
    '.agent': cardOf('a1'), '[data-act="userstyle"]': {},
  }) });
  assert.ok(await waitFor(() => app.calls.some((call) => call.url.includes('/api/dialect') && call.init.method === 'POST')));
  const write = app.calls.find((call) => call.url.includes('/api/dialect') && call.init.method === 'POST');
  assert.deepEqual(JSON.parse(write.init.body), {
    version: 4, agents: { a1: { dialect: 'userstyle', enabled: true } },
  });
});

test('总结接口返回纯文本 500 时显示中文提示，且可以重试', async () => {
  const app = createApp(defaultRespond({
    '/api/style/summary': (_url, init) => init.method === 'POST' ? {
      ok: false, status: 500,
      json: async () => JSON.parse('Internal Server Error'),
    } : jsonResp({ ok: true, data: { task: null } }),
  }));
  assert.ok(await waitFor(() => !app.el('btn-style-summary').disabled && app.el('board').innerHTML.includes('小花')));
  app.el('style-source').value = 'a1';
  app.el('btn-style-summary').dispatch('click', {});
  assert.ok(await waitFor(() => app.el('style-status').textContent.includes('Hana 未能返回总结结果（HTTP 500）')));
  assert.equal(app.el('btn-style-summary').disabled, false);
});
test('重开页面接回后台任务，完成后读取草稿', async () => {
  const draft = '测试草稿：用亲切的短句，句尾留一点口语。';
  let checks = 0;
  const app = createApp(defaultRespond({
    '/api/style/summary': () => jsonResp({ ok: true, data: { task: ++checks === 1
      ? { id: 'task-1', status: 'running', phase: 'distilling' }
      : { id: 'task-1', status: 'done', phase: 'saving' } } }),
    '/api/style-template': () => jsonResp({ ok: true, data: checks >= 2 ? { draft } : {} }),
  }));
  assert.ok(await waitFor(() => app.el('style-status').textContent.includes('正在总结说话习惯')));
  assert.equal(app.el('btn-style-summary').disabled, true);
  await new Promise((resolve) => setTimeout(resolve, 1550));
  assert.ok(await waitFor(() => app.el('style-text').textContent === draft));
  assert.equal(app.el('btn-style-summary').disabled, false);
  assert.equal(app.el('btn-style-confirm').hidden, false);
  assert.equal(app.urls().some((url) => url.includes('/confirm')), false);
});

test('无已采用版时上一份归档草稿 A 与新草稿 B 并列', async () => {
  const app = createApp(defaultRespond({
    '/api/style-template': jsonResp({ ok: true, data: {
      current: '', draft: '新草稿 B',
      versions: [
        { id: 'old-a', kind: 'draft', text: '上一份草稿 A', at: '2026-05-02' },
        { id: 'adopted', kind: 'adopted', text: '曾采用的版本', at: '2026-04-01' },
      ],
    } }),
    '/api/style/summary': jsonResp({ ok: true, data: { task: null } }),
  }));
  assert.ok(await waitFor(() => app.el('style-text').textContent === '新草稿 B'));
  assert.equal(app.el('style-current-title').textContent, '上一份草稿');
  assert.equal(app.el('style-current').textContent, '上一份草稿 A');
  assert.equal(app.el('style-candidate-title').textContent, '新草稿');
  assert.match(app.el('style-status').textContent, /还没有已采用版/);
});

test('选择旧草稿只切换对比，不会自动采用；明确动作才提交', async () => {
  let revertCalls = 0;
  const app = createApp(defaultRespond({
    '/api/style-template/revert': (_url, init) => {
      revertCalls += 1;
      assert.deepEqual(JSON.parse(init.body), { versionId: 'old-a' });
      return jsonResp({ ok: true });
    },
    '/api/style-template': jsonResp({ ok: true, data: {
      current: '', draft: '新草稿 B',
      versions: [{ id: 'old-a', kind: 'draft', text: '上一份草稿 A', at: '2026-05-02' }],
    } }),
    '/api/style/summary': jsonResp({ ok: true, data: { task: null } }),
  }));
  assert.ok(await waitFor(() => app.el('style-text').textContent === '新草稿 B'));
  app.el('style-version').value = 'old-a';
  app.el('style-version').dispatch('change', {});
  assert.equal(app.el('style-current-title').textContent, '新草稿');
  assert.equal(app.el('style-current').textContent, '新草稿 B');
  assert.equal(app.el('style-candidate-title').textContent, '旧草稿 · 2026-05-02');
  assert.equal(app.el('style-text').textContent, '上一份草稿 A');
  assert.equal(app.el('btn-style-revert').textContent, '采用这份旧草稿');
  assert.equal(revertCalls, 0);
  app.el('btn-style-revert').dispatch('click', {});
  assert.ok(await waitFor(() => revertCalls === 1));
  assert.ok(await waitFor(() => app.el('style-status').textContent === '已恢复这版'));

  app.el('style-current').scrollTop = 70;
  app.el('style-text').scrollTop = 90;
  app.el('style-version').value = '__style_draft__';
  app.el('style-version').dispatch('change', {});
  assert.equal(app.el('style-current-title').textContent, '上一份草稿');
  assert.equal(app.el('style-current').textContent, '上一份草稿 A');
  assert.equal(app.el('style-text').textContent, '新草稿 B');
  assert.equal(app.el('style-current').scrollTop, 0);
  assert.equal(app.el('style-text').scrollTop, 0);
  assert.equal(revertCalls, 1);
});

test('无历史的首稿按钮明确为采用首版', async () => {
  let confirmCalls = 0;
  const app = createApp(defaultRespond({
    '/api/style-template/confirm': () => {
      confirmCalls += 1;
      return jsonResp({ ok: true, message: '首版已采用' });
    },
    '/api/style-template': jsonResp({ ok: true, data: { current: '', draft: '首稿', versions: [] } }),
    '/api/style/summary': jsonResp({ ok: true, data: { task: null } }),
  }));
  assert.ok(await waitFor(() => app.el('style-text').textContent === '首稿'));
  assert.equal(app.el('btn-style-confirm').textContent, '采用首版');
  assert.equal(app.el('btn-style-revert').hidden, true);
  app.el('btn-style-confirm').dispatch('click', {});
  assert.ok(await waitFor(() => confirmCalls === 1));
});

test('当前版与新稿提供采用新版/保留原版；保留失败可重试，成功刷新模板不清空', async () => {
  let keepCalls = 0;
  let keepSucceeded = false;
  let templateReads = 0;
  const app = createApp(defaultRespond({
    '/api/style-template/keep-current': (_url, init) => {
      keepCalls += 1;
      assert.equal(init.method, 'POST');
      assert.equal(init.body, undefined);
      assert.equal(init.headers, undefined);
      if (keepCalls === 1) return jsonResp({ ok: false, error: '暂时保留失败' });
      keepSucceeded = true;
      return jsonResp({ ok: true, message: '已保留原版，新稿已存入历史。' });
    },
    '/api/style-template': () => {
      templateReads += 1;
      return jsonResp({ ok: true, data: {
        current: '原版',
        draft: keepSucceeded ? '' : '新版草稿',
        versions: keepSucceeded ? [{ id: 'draft-1', kind: 'draft', text: '新版草稿', at: '2026-05-10' }] : [],
      } });
    },
    '/api/style/summary': jsonResp({ ok: true, data: { task: null } }),
  }));
  assert.ok(await waitFor(() => app.el('style-text').textContent === '新版草稿'));
  assert.equal(app.el('btn-style-confirm').textContent, '采用新版');
  assert.equal(app.el('btn-style-revert').textContent, '保留原版');
  const readsBefore = templateReads;

  app.el('btn-style-revert').dispatch('click', {});
  assert.ok(await waitFor(() => app.el('style-status').textContent === '暂时保留失败'));
  assert.equal(app.el('btn-style-revert').disabled, false);
  assert.equal(templateReads, readsBefore);

  app.el('btn-style-revert').dispatch('click', {});
  assert.ok(await waitFor(() => app.el('style-status').textContent === '已保留原版，新稿已存入历史。'));
  assert.equal(keepCalls, 2);
  assert.ok(templateReads > readsBefore, '成功后重新读取模板与版本状态');
  assert.equal(app.el('style-current').textContent, '原版');
  assert.equal(app.el('style-text').textContent, '新版草稿');
  assert.equal(app.urls().some((url) => url.includes('/api/style-template/confirm')), false);
  assert.equal(app.urls().some((url) => url.includes('/api/style-template/revert')), false);
  assert.equal(app.urls().some((url) => url.includes('/api/style-template/clear')), false);
});

test('无当前版的最新草稿可采用新版或采用上一稿，后一操作只点按钮才恢复', async () => {
  let revertCalls = 0;
  const app = createApp(defaultRespond({
    '/api/style-template/revert': (_url, init) => {
      revertCalls += 1;
      assert.deepEqual(JSON.parse(init.body), { versionId: 'previous-draft' });
      return jsonResp({ ok: true, message: '上一稿已采用' });
    },
    '/api/style-template': jsonResp({ ok: true, data: {
      current: '', draft: '最新草稿',
      versions: [{ id: 'previous-draft', kind: 'draft', text: '上一份草稿', at: '2026-05-01' }],
    } }),
    '/api/style/summary': jsonResp({ ok: true, data: { task: null } }),
  }));
  assert.ok(await waitFor(() => app.el('style-text').textContent === '最新草稿'));
  assert.equal(app.el('btn-style-confirm').textContent, '采用新版');
  assert.equal(app.el('btn-style-revert').textContent, '采用上一稿');
  assert.equal(revertCalls, 0);
  app.el('btn-style-revert').dispatch('click', {});
  assert.ok(await waitFor(() => revertCalls === 1));
});

test('双版对比：当前版与草稿并列，且无当前版时明确显示空态', async () => {
  const draft = '新草稿的纯文本内容';
  const app = createApp(defaultRespond({
    '/api/style-template': jsonResp({ ok: true, data: { current: '', draft, versions: [] } }),
    '/api/style/summary': jsonResp({ ok: true, data: { task: null } }),
  }));
  assert.ok(await waitFor(() => app.el('style-text').textContent === draft));
  assert.equal(app.el('style-current-title').textContent, '上一份草稿');
  assert.equal(app.el('style-current').textContent, '还没有归档的旧草稿。');
  assert.equal(app.el('style-candidate-title').textContent, '新草稿');
  assert.equal(app.el('btn-style-confirm').hidden, false);
  assert.equal(app.el('btn-style-revert').hidden, true);
});

test('默认比较最近历史；选历史后按 versionId 恢复，重载仍保留版本', async () => {
  const versions = [
    { id: 'v-new', text: '最近的旧版', at: '2026-03-02T12:00:00Z' },
    { id: 'v-old', text: '更早的旧版', at: '2026-02-01T12:00:00Z' },
  ];
  let restored = false;
  const respond = defaultRespond({
    '/api/style-template/revert': (url, init) => {
      assert.deepEqual(JSON.parse(init.body), { versionId: 'v-old' });
      restored = true;
      return jsonResp({ ok: true, message: '恢复完成' });
    },
    '/api/style-template': () => jsonResp({ ok: true, data: {
      current: restored ? '更早的旧版' : '当前人格里的版本',
      current_at: '2026-03-10',
      draft: '',
      versions,
      versionCount: versions.length,
    } }),
    '/api/style/summary': jsonResp({ ok: true, data: { task: null } }),
  });
  const app = createApp(respond);
  assert.ok(await waitFor(() => app.el('style-current').textContent === '当前人格里的版本'));
  assert.equal(app.el('style-candidate-title').textContent, '历史版 · 2026-03-02');
  assert.equal(app.el('style-text').textContent, '最近的旧版');
  assert.equal(app.el('btn-style-confirm').hidden, true);
  assert.equal(app.el('btn-style-revert').hidden, false);

  app.el('style-version').value = 'v-old';
  app.el('style-version').dispatch('change', {});
  assert.equal(app.el('style-text').textContent, '更早的旧版');
  app.el('btn-style-revert').dispatch('click', {});
  assert.ok(await waitFor(() => restored && app.el('style-current').textContent === '更早的旧版'));
  assert.equal(app.el('style-version').innerHTML.includes('v-new'), true);
  assert.equal(app.el('style-version').innerHTML.includes('v-old'), true);

  const reopened = createApp(respond);
  assert.ok(await waitFor(() => reopened.el('style-current').textContent === '更早的旧版'));
  assert.equal(reopened.el('style-version').innerHTML.includes('v-new'), true);
  assert.equal(reopened.el('style-version').innerHTML.includes('v-old'), true);
});

test('切到历史后可从同一列表切回未采用草稿', async () => {
  const app = createApp(defaultRespond({
    '/api/style-template': jsonResp({ ok: true, data: {
      current: '当前', draft: '待采用草稿',
      versions: [{ id: 'v1', text: '历史版本', at: '2026-04-05' }],
    } }),
    '/api/style/summary': jsonResp({ ok: true, data: { task: null } }),
  }));
  assert.ok(await waitFor(() => app.el('style-text').textContent === '待采用草稿'));
  app.el('style-version').value = 'v1';
  app.el('style-version').dispatch('change', {});
  assert.equal(app.el('style-text').textContent, '历史版本');
  assert.equal(app.el('btn-style-revert').hidden, false);
  app.el('style-version').value = '__style_draft__';
  app.el('style-version').dispatch('change', {});
  assert.equal(app.el('style-text').textContent, '待采用草稿');
  assert.equal(app.el('btn-style-confirm').hidden, false);
  assert.equal(app.el('btn-style-revert').hidden, false);
  assert.equal(app.el('btn-style-revert').textContent, '保留原版');
});

test('恢复人格同步失败但模板已变：刷新对比并保留后端错误', async () => {
  let changed = false;
  const versions = [{ id: 'v1', text: '历史版本', at: '2026-04-05' }];
  const app = createApp(defaultRespond({
    '/api/style-template/revert': () => {
      changed = true;
      return jsonResp({ ok: false, error: '人格同步失败，但模板已恢复' });
    },
    '/api/style-template': () => jsonResp({ ok: true, data: {
      current: changed ? '历史版本' : '当前版本', draft: '', versions,
    } }),
    '/api/style/summary': jsonResp({ ok: true, data: { task: null } }),
  }));
  assert.ok(await waitFor(() => app.el('style-current').textContent === '当前版本'));
  app.el('btn-style-revert').dispatch('click', {});
  assert.ok(await waitFor(() => app.el('style-current').textContent === '历史版本'));
  assert.equal(app.el('style-status').textContent, '人格同步失败，但模板已恢复');
  assert.equal(app.el('style-status').className, 'style-status is-error');
});

test('无当前版、无草稿、无历史时左右空态清楚', async () => {
  const app = createApp(defaultRespond({
    '/api/style-template': jsonResp({ ok: true, data: { current: '', draft: '', versions: [] } }),
    '/api/style/summary': jsonResp({ ok: true, data: { task: null } }),
  }));
  assert.ok(await waitFor(() => app.el('style-current').textContent.includes('还没有已采用')));
  assert.equal(app.el('style-text').textContent, '还没有草稿或历史版本。');
  assert.equal(app.el('btn-style-confirm').hidden, true);
  assert.equal(app.el('btn-style-revert').hidden, true);
});

test('首屏读一次 /api/state，名单渲染出来', async () => {
  const app = createApp(defaultRespond());
  assert.ok(await waitFor(() => app.el('board').innerHTML.includes('小花')));
  assert.equal(app.urls().filter((u) => u.includes('/api/state')).length, 1);
  assert.ok(app.el('board').innerHTML.includes('选口音 ›'));
});

test('刷新名单走 ?refresh=1，连点两次只发一次', async () => {
  let refreshCount = 0;
  const app = createApp(defaultRespond({
    '/api/state?refresh=1': () => {
      refreshCount += 1;
      return jsonResp({ ok: true, data: stateData() });
    },
  }));
  await waitFor(() => app.el('board').innerHTML.includes('小花'));
  app.el('btn-refresh').dispatch('click', {});
  app.el('btn-refresh').dispatch('click', {});
  assert.ok(await waitFor(() => refreshCount === 1));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(refreshCount, 1);
  assert.equal(app.urls().filter((u) => u.includes('/api/state?refresh=1')).length, 1);
});

test('刷新失败：原来的名单还在，只在提示行里报错', async () => {
  const app = createApp(defaultRespond({
    '/api/state?refresh=1': jsonResp({ ok: false, error: '宿主没回应' }, false),
  }));
  await waitFor(() => app.el('board').innerHTML.includes('小花'));
  const before = app.el('board').innerHTML;
  app.el('btn-refresh').dispatch('click', {});
  assert.ok(await waitFor(() => app.el('status').textContent.includes('刷新失败')));
  assert.equal(app.el('board').innerHTML, before);
  assert.ok(app.el('board').innerHTML.includes('小花'));
});

test('隐藏：请求体对，返回的名单与已隐藏名单接上', async () => {
  const app = createApp(defaultRespond({
    '/api/roster-visibility': jsonResp({
      ok: true,
      data: {
        agents: [{ id: 'a2', name: '小草' }],
        hiddenAgents: [{ id: 'a1', name: '小花' }],
      },
    }),
  }));
  await waitFor(() => app.el('board').innerHTML.includes('小花'));
  app.el('board').dispatch('click', { target: clickTarget({
    '.agent': cardOf('a1'),
    '[data-act="hide"]': {},
  }) });
  assert.ok(await waitFor(() => app.win.__panelTest.state.hiddenAgents.length === 1));
  const call = app.calls.find((c) => c.url.includes('/api/roster-visibility'));
  assert.deepEqual(JSON.parse(call.init.body), { agentId: 'a1', hidden: true });
  assert.equal(app.win.__panelTest.state.agents.length, 1);
  assert.equal(app.win.__panelTest.state.hiddenAgents[0].id, 'a1');
  // 名单变了，学我说话的下拉也得跟着换
  assert.ok(!app.el('style-source').innerHTML.includes('小花'));
  assert.ok(app.el('style-source').innerHTML.includes('小草'));
});

test('隐藏后学我说话的下拉保留还合法的那个选项', async () => {
  const app = createApp(defaultRespond({
    '/api/roster-visibility': jsonResp({
      ok: true,
      data: {
        agents: [{ id: 'a2', name: '小草' }],
        hiddenAgents: [{ id: 'a1', name: '小花' }],
      },
    }),
  }));
  await waitFor(() => app.el('board').innerHTML.includes('小花'));
  app.el('style-source').value = 'a2';
  app.el('board').dispatch('click', { target: clickTarget({
    '.agent': cardOf('a1'),
    '[data-act="hide"]': {},
  }) });
  assert.ok(await waitFor(() => app.win.__panelTest.state.hiddenAgents.length === 1));
  assert.ok(app.el('style-source').innerHTML.includes('value="a2" selected'));
});

test('恢复：请求体 hidden:false，恢复后焦点落到那一行', async () => {
  const app = createApp(defaultRespond({
    '/api/roster-visibility': jsonResp({
      ok: true,
      data: {
        agents: [{ id: 'a1', name: '小花' }, { id: 'a2', name: '小草' }],
        hiddenAgents: [],
      },
    }),
  }));
  await waitFor(() => app.el('board').innerHTML.includes('小花'));
  app.el('hidden-list').dispatch('click', { target: clickTarget({
    '[data-restore]': { getAttribute: () => 'a1' },
  }) });
  assert.ok(await waitFor(() => app.el('row-aa1').focused === true));
  const call = app.calls.find((c) => c.url.includes('/api/roster-visibility'));
  assert.deepEqual(JSON.parse(call.init.body), { agentId: 'a1', hidden: false });
});

test('隐藏排在口音写入后面，不会盖回去', async () => {
  const app = createApp(defaultRespond({
    '/api/roster-visibility': jsonResp({
      ok: true,
      data: { agents: [{ id: 'a2', name: '小草' }], hiddenAgents: [{ id: 'a1', name: '小花' }] },
    }),
  }));
  await waitFor(() => app.el('board').innerHTML.includes('小花'));
  // 先点口音（进入待写入），再点隐藏
  app.el('board').dispatch('click', { target: clickTarget({
    '.agent': cardOf('a1'),
    '.opt': { getAttribute: () => 'sichuan' },
  }) });
  app.el('board').dispatch('click', { target: clickTarget({
    '.agent': cardOf('a1'),
    '[data-act="hide"]': {},
  }) });
  assert.ok(await waitFor(() => app.win.__panelTest.state.hiddenAgents.length === 1));
  const urls = app.urls();
  const dialectAt = urls.findIndex((u) => u.includes('/api/dialect'));
  const rosterAt = urls.findIndex((u) => u.includes('/api/roster-visibility'));
  assert.ok(dialectAt >= 0 && rosterAt > dialectAt, `顺序不对：${urls.join(' | ')}`);
});

test('口音写失败：有反馈，还能再点一次重试', async () => {
  const app = createApp(defaultRespond({
    '/api/dialect': jsonResp({ ok: false, error: '人格文件写不进去' }, false),
  }));
  await waitFor(() => app.el('board').innerHTML.includes('小花'));
  app.el('board').dispatch('click', { target: clickTarget({
    '.agent': cardOf('a1'),
    '.opt': { getAttribute: () => 'sichuan' },
  }) });
  assert.ok(await waitFor(() => Boolean(app.win.__panelTest.rowErrors().a1)));
  assert.match(app.win.__panelTest.rowErrors().a1, /人格文件写不进去/);
  assert.equal(app.win.__panelTest.statusOf('a1').kind, 'error');

  const before = app.urls().filter((u) => u.includes('/api/dialect')).length;
  app.el('board').dispatch('click', { target: clickTarget({
    '.agent': cardOf('a1'),
    '.opt': { getAttribute: () => 'sichuan' },
  }) });
  assert.ok(await waitFor(
    () => app.urls().filter((u) => u.includes('/api/dialect')).length === before + 1,
  ));
});

test('隐藏失败：名单不动，提示行里说清楚', async () => {
  const app = createApp(defaultRespond({
    '/api/roster-visibility': jsonResp({ ok: false, error: '宿主没答应' }, false),
  }));
  await waitFor(() => app.el('board').innerHTML.includes('小花'));
  app.el('board').dispatch('click', { target: clickTarget({
    '.agent': cardOf('a1'),
    '[data-act="hide"]': {},
  }) });
  assert.ok(await waitFor(() => app.el('status').textContent.includes('隐藏失败')));
  assert.equal(app.win.__panelTest.state.agents.length, 2);
  assert.equal(app.win.__panelTest.state.hiddenAgents.length, 0);
});

// ── 并发与护栏 ──────────────────────────────────────────
test('刷新还在跑的时候点口音：不发写请求，只给一句提示', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const app = createApp(defaultRespond({
    '/api/state?refresh=1': () => gate,
  }));
  try {
  await waitFor(() => app.el('board').innerHTML.includes('小花'));
  app.el('btn-refresh').dispatch('click', {});
  await waitFor(() => app.el('status').textContent.includes('正在刷新名单'));

  // 这一位在刷新前是什么口音，刷新中点一下就该还是什么口音
  const before = JSON.stringify(app.win.__panelTest.state.config);
  app.el('board').dispatch('click', { target: clickTarget({
    '.agent': cardOf('a1'),
    '.opt': { getAttribute: () => 'sichuan' },
  }) });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(app.urls().filter((u) => u.includes('/api/dialect')).length, 0);
  assert.match(app.el('status').textContent, /正在刷新名单|等它跑完再改口音/);
  assert.equal(JSON.stringify(app.win.__panelTest.state.config), before);

  release(jsonResp({ ok: true, data: stateData() }));
  assert.ok(await waitFor(() => app.el('status').textContent.includes('名单已刷新')));
  } finally {
    // 闸门一定放行，不然那次请求会挂到超时
    release(jsonResp({ ok: true, data: stateData() }));
  }
});

test('同一位正在写入时再点：不发第二次写请求', async () => {
  const app = createApp(defaultRespond());
  await waitFor(() => app.el('board').innerHTML.includes('小花'));
  app.el('board').dispatch('click', { target: clickTarget({
    '.agent': cardOf('a1'),
    '.opt': { getAttribute: () => 'sichuan' },
  }) });
  // 第二次点：这一位还在 pending，不能把新选择挤掉
  app.el('board').dispatch('click', { target: clickTarget({
    '.agent': cardOf('a1'),
    '.opt': { getAttribute: () => 'sichuan' },
  }) });
  assert.ok(await waitFor(() => app.urls().filter((u) => u.includes('/api/dialect')).length === 1));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(app.urls().filter((u) => u.includes('/api/dialect')).length, 1);
  assert.match(app.el('status').textContent, /正在写入|等写完再点/);
});

test('刷新回来的名单里没有展开的那位，就收起', async () => {
  const app = createApp(defaultRespond({
    '/api/state?refresh=1': jsonResp({
      ok: true,
      data: stateData({ agents: [{ id: 'a2', name: '小草' }] }),
    }),
  }));
  await waitFor(() => app.el('board').innerHTML.includes('小花'));
  app.el('board').dispatch('click', { target: clickTarget({
    '.agent': cardOf('a1'),
    '.row': {},
  }) });
  assert.equal(app.win.__panelTest.state.open, 'a1');

  app.el('btn-refresh').dispatch('click', {});
  assert.ok(await waitFor(() => app.win.__panelTest.state.open === null));
  assert.ok(app.el('board').innerHTML.includes('小草'));
  assert.ok(!app.el('board').innerHTML.includes('小花'));
});

// ── 静态约定 ────────────────────────────────────────────
test('页面与样式守住了几条约定', () => {
  assert.ok(HTML.includes('刷新列表'), '刷新按钮要一直在');
  assert.ok(HTML.includes('学我说话'), '学我说话不能被砍');
  assert.ok(HTML.includes('id="btn-style-summary">总结</button>'), '总结入口用短文案');
  assert.ok(HTML.includes('role="tablist"') && HTML.includes('role="tab"') && HTML.includes('aria-controls="panel-style"'), '两页使用ARIA页签');
  assert.ok(HTML.includes('id="panel-style" role="tabpanel"') && HTML.includes('hidden inert'), '隐藏页不可聚焦');
  assert.ok(HTML.indexOf('id="style-source"') < HTML.indexOf('class="style-compare"'), '语料来源与总结位于稿纸对比之前');
  assert.ok(HTML.indexOf('class="style-decision-actions"') < HTML.indexOf('class="style-history"'), '决策按钮在历史折叠区之前');
  assert.ok(!HTML.includes('btn-style-clear'), '界面移除清空入口，不碰历史数据');
  assert.ok(!SRC.includes('/api/style-template/clear'), '不再注册清空请求');
  assert.ok(!SRC.includes('btn-style-clear'), '不保留清空按钮事件');
  assert.ok(HTML.includes('已隐藏'), '要有已隐藏名单的入口');
  assert.ok(!CSS.includes('dashed'), '不用虚线');
  assert.ok(CSS.includes('KaiTi') && CSS.includes('sans-serif'), '标题/正文两种字体');
  assert.ok(CSS.includes('scrollbar-width: thin') && CSS.includes('scrollbar-color: var(--mint)'), '两栏使用薄荷细滚动条');
  assert.ok(CSS.includes('.style-compare { grid-template-columns: 1fr; }'), '窄屏稿纸保持单列');
  assert.ok(CSS.includes('overflow-wrap: anywhere'), '窄屏内容允许断行避免溢出');
  assert.ok(!SRC.includes('已写进人格'), '「已写进人格」换成一次性保存反馈');
  assert.ok(SRC.includes('?refresh=1'), '刷新要带 refresh=1');
  assert.ok(SRC.includes('/api/roster-visibility'), '隐藏/恢复走 roster-visibility');
  assert.ok(SRC.includes('只影响「说方言」里的显示，不改 ta 的口音和人格'), '隐藏影响的是说方言里的显示');
  assert.ok(SRC.includes('隐藏这位伙伴'), '按钮直说隐藏的是这位伙伴');
  assert.ok(!SRC.includes('在此隐藏'), '「在此隐藏」这种拐弯说法不要再出现');
  assert.ok(!SRC.includes('隐藏只影响这一页'), '不要说成「这一页」');
});

// ── 首次确认：写人格这件事先说清楚 ─────────────────────
test('首次进入：点确认才发出记录，随后遮罩收起', async () => {
  let posted = null;
  const app = createApp(defaultRespond({
    '/api/consent': (url, init) => {
      posted = JSON.parse(init.body);
      return jsonResp({ ok: true, data: { accepted: true, at: '2026-11-20T00:00:00.000Z' } });
    },
  }));
  assert.ok(await waitFor(() => app.el('board').innerHTML.includes('小花')), '名单先要出来');
  assert.ok(HTML.includes('知道了，开始挑'), '确认按钮的文案在页面里');
  assert.equal(app.el('btn-consent').disabled, false);

  app.el('btn-consent').dispatch('click', {});
  assert.ok(await waitFor(() => app.el('consent-veil').hidden === true), '确认后要收起遮罩');
  assert.deepEqual(posted, { accepted: true });
  assert.equal(app.el('btn-consent').disabled, false, '按钮要复原');
});

test('首次进入：确认失败就停在遮罩上，不能假装过了', async () => {
  const app = createApp(defaultRespond({
    '/api/consent': jsonResp({ ok: false, error: '网络不通' }, false, 500),
  }));
  assert.ok(await waitFor(() => app.el('board').innerHTML.includes('小花')));
  app.el('btn-consent').dispatch('click', {});
  assert.ok(await waitFor(() => /再点一次/.test(app.el('btn-consent').textContent)), '要给出重试提示');
  assert.equal(app.el('consent-veil').hidden, false, '失败时遮罩必须还挡着');
});

test('已确认过的老用户：不弹遮罩', async () => {
  const app = createApp(defaultRespond({
    '/api/state': jsonResp({
      ok: true,
      data: stateData({ consent: { accepted: true, at: '2026-11-01T00:00:00.000Z' } }),
    }),
  }));
  assert.ok(await waitFor(() => app.el('board').innerHTML.includes('小花')));
  assert.equal(app.el('consent-veil').hidden, true);
});

// ── 取消口音：得一眼看得见 ────────────────────────
test('取消口音：展开就看得到，点了把这位伙伴清掉', async () => {
  const app = createApp(defaultRespond({
    '/api/state': jsonResp({
      ok: true,
      data: stateData({ config: { agents: { a1: { dialect: 'taiwan', enabled: true } } } }),
    }),
    '/api/dialect': (url, init) => jsonResp({ ok: true, data: JSON.parse(init.body), changed: [] }),
  }));
  assert.ok(await waitFor(() => app.el('board').innerHTML.includes('小花')));
  const html = app.el('board').innerHTML;
  assert.match(html, /取消口音/, '有口音时要给出取消入口');
  assert.match(html, /当前：/, '要写清当前是什么口音');

  app.el('board').dispatch('click', {
    target: clickTarget({ '.agent': cardOf('a1'), '[data-act="clear"]': {} }),
  });
  const sent = await waitFor(() => app.calls.some((c) => c.url.includes('/api/dialect')));
  assert.ok(sent, '点取消要发出保存请求');
  const call = app.calls.find((c) => c.url.includes('/api/dialect'));
  const body = JSON.parse(call.init.body);
  assert.ok(!body.agents.a1, '这位伙伴的条目要被删掉');
});

test('没口音的那位：不显示取消，只提示可以点一格', async () => {
  const app = createApp(defaultRespond());
  assert.ok(await waitFor(() => app.el('board').innerHTML.includes('小花')));
  const html = app.el('board').innerHTML;
  assert.ok(!html.includes('取消口音'), '没口音就不该有取消按钮');
  assert.match(html, /现在没有口音/, '要告诉人可以点格子');
});

// 后端也要拦：前端那层是体验，这一层才是保证。
test('后端拦没确认的保存请求（源码级哨兵）', () => {
  const api = fs.readFileSync(path.join(ROOT, 'server', 'api.js'), 'utf8');
  assert.ok(api.includes("if (!readConsent().accepted)"), '/api/dialect 要先查确认');
  assert.ok(api.includes('needConsent: true'), '要告诉前端是缺确认，方便它把遮罩摆回来');
  assert.ok(api.includes("body.accepted !== true"), '记确认只认布尔 true');
});
