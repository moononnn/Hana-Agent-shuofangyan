// ui/assets/panel.js — 「说方言」页面交互
//
// 版面是一本小册子：单列名单，一位伙伴一行，右边写着 ta 现在是什么口音。
// 点一行就展开，展开区里有话笺（ta 的一句例句）、可选的口音（每个按钮都带着自己的例句）
// 和两个小动作：关闭口音、在此隐藏。一次只展开一行。
//
// 隐藏只动「说方言」里的显示：名单接口照旧，口音和人格一个字都不改；
// 语料来源下拉也跟着换名单，所以影响的是说方言这一块，不只是眼前这一页。
// 刷新名单走 GET /api/state?refresh=1；失败了就把原来那页留着，只在旁边提示一句。
//
// 并发：口音保存和名单操作（刷新 / 隐藏 / 恢复）都排在同一条队列上，
// 免得旧响应把新状态盖回去。名单操作还会带上序号，迟到的响应直接丢掉。

(function () {
  'use strict';

  // ── 认证与地址 ──
  function getAuthParams() {
    var params = new URLSearchParams(window.location.search);
    return {
      surface: params.get('appSurfaceSession') || params.get('pluginSurfaceSession') || '',
      token: params.get('token') || '',
    };
  }

  function baseUrl() {
    var m = window.location.pathname.match(/^\/api\/apps\/([^/]+)\/ui\//);
    if (m) return '/api/apps/' + m[1] + '/routes';
    return '/api/apps/shuo-fangyan/routes';
  }

  var API = baseUrl();

  function apiFetch(url, opts) {
    opts = opts || {};
    var init = {};
    for (var k in opts) if (k !== 'timeout') init[k] = opts[k];
    var auth = getAuthParams();
    if (auth.surface && !auth.token) {
      var headers = new Headers(init.headers || {});
      headers.set('X-Hana-App-Surface-Session', auth.surface);
      headers.set('X-Hana-Plugin-Surface-Session', auth.surface);
      init.headers = headers;
    }
    if (!init.signal) {
      try {
        var ctrl = new AbortController();
        var timer = setTimeout(function () { try { ctrl.abort(); } catch (e) { /* 已结束 */ } }, opts.timeout || 15000);
        init.signal = ctrl.signal;
        init.signal.__clearTimer = timer;
      } catch (e) { /* 老内核没有 AbortController：放弃超时 */ }
    }
    return fetch(url, init).then(function (r) {
      if (init.signal && init.signal.__clearTimer) clearTimeout(init.signal.__clearTimer);
      return r;
    }, function (e) {
      if (init.signal && init.signal.__clearTimer) clearTimeout(init.signal.__clearTimer);
      if (e && e.name === 'AbortError') {
        var err = new Error('请求超时');
        err.name = 'TimeoutError';
        throw err;
      }
      throw e;
    });
  }

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // id 里可能有奇怪字符，做成能进 DOM id 的样子，顺便避免撞名。
  function safeId(agentId) {
    return 'a' + String(agentId == null ? '' : agentId).replace(/[^A-Za-z0-9_-]/g, '_');
  }

  // ── 状态 ──
  var state = {
    dialects: [],        // [{id,name,tagline,example}]
    agents: [],          // [{id,name}] —— 可见的
    hiddenAgents: [],    // [{id,name}] —— 被藏起来的
    config: { agents: {} },
    actual: {},          // 人格文件里真实写着什么
    agentSource: 'none', // cache / host / dir / none
    modelReady: null,    // null = 还不知道；false = 宿主没有可用文本模型
    style: null,         // 模板状态
    open: null,          // 展开着的那一行：agentId
    consent: { accepted: false },  // 有没有确认过「会改人格文件」
  };

  var pending = {};      // 正在写的伙伴：agentId -> true
  var rowErrors = {};    // 写失败的伙伴：agentId -> 原因
  var savedFlags = {};   // 刚保存成功的一次性反馈：agentId -> true
  var savedTimers = {};
  var chain = Promise.resolve();  // 口音写入与名单操作共用的一条队列
  var saveTimer = null;
  var rosterBusy = false;   // 名单操作进行中
  var rosterEpoch = 0;      // 名单请求序号，迟到的响应作废
  var refreshBusy = false;  // 刷新进行中

  var $board = document.getElementById('board');
  var $tally = document.getElementById('tally');
  var $status = document.getElementById('status');
  var $btnRefresh = document.getElementById('btn-refresh');
  var $hiddenBox = document.getElementById('hidden-box');
  var $hiddenCount = document.getElementById('hidden-count');
  var $hiddenList = document.getElementById('hidden-list');
  var $tabDialect = document.getElementById('tab-dialect');
  var $tabStyle = document.getElementById('tab-style');
  var $panelDialect = document.getElementById('panel-dialect');
  var $panelStyle = document.getElementById('panel-style');
  var $styleTabIndicator = document.getElementById('style-tab-indicator');
  var $styleCurrentTitle = document.getElementById('style-current-title');
  var $styleCurrent = document.getElementById('style-current');
  var $styleText = document.getElementById('style-text');
  var $styleCandidateTitle = document.getElementById('style-candidate-title');
  var $styleHistory = document.getElementById('style-history');
  var $styleHistoryCount = document.getElementById('style-history-count');
  var $styleVersion = document.getElementById('style-version');
  var selectedVersionId = null;
  var styleCompareMode = null; // draft / history
  var $styleStatus = document.getElementById('style-status');
  var $styleSource = document.getElementById('style-source');
  if (typeof window.beautifySelect === 'function') {
    window.beautifySelect($styleSource);
    window.beautifySelect($styleVersion);
  }
  var $btnSummary = document.getElementById('btn-style-summary');
  var $btnConfirm = document.getElementById('btn-style-confirm');
  var $btnRevert = document.getElementById('btn-style-revert');
  var styleRevertAction = null;
  var styleRevertVersionId = null;
  var styleActionBusy = false;
  var $consentVeil = document.getElementById('consent-veil');
  var $btnConsent = document.getElementById('btn-consent');
  var consentBusy = false;

  // ── 小工具 ──
  function dialectMeta(id) {
    for (var i = 0; i < state.dialects.length; i++) {
      if (state.dialects[i].id === id) return state.dialects[i];
    }
    return null;
  }

  function dialectName(id) {
    var d = dialectMeta(id);
    return d ? d.name : (id || '未配置');
  }

  function settingOf(agentId) {
    var s = state.config.agents && state.config.agents[agentId];
    if (!s || s.enabled === false || !s.dialect) return null;
    return s;
  }

  // 人格里真正写进去的只有「已采用」的那份模板，草稿不算。
  function hasTemplate() {
    return Boolean(state.style && state.style.current);
  }

  function findCard(agentId) {
    var cards = $board.querySelectorAll('.agent');
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].getAttribute('data-agent') === agentId) return cards[i];
    }
    return null;
  }

  // 名单位置换了以后，旧 DOM 不能用来判断「这位还在不在」。
  function agentInList(list, agentId) {
    for (var i = 0; i < (list || []).length; i++) {
      if (list[i] && list[i].id === agentId) return true;
    }
    return false;
  }

  function saveBusy() {
    return Object.keys(pending).length > 0;
  }

  var statusTimer = null;
  function setStatus(text, kind) {
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
    $status.textContent = text || '';
    $status.className = 'status' + (kind ? ' is-' + kind : '');
    if (kind === 'ok' || kind === 'info') {
      statusTimer = setTimeout(function () {
        statusTimer = null;
        $status.textContent = '';
        $status.className = 'status';
      }, 4000);
    }
  }

  // ── 读状态 ──
  function applyState(data) {
    data = data || {};
    state.dialects = data.dialects || [];
    state.agents = data.agents || [];
    state.hiddenAgents = data.hiddenAgents || [];
    state.config = data.config || { agents: {} };
    state.actual = data.actual || {};
    state.agentSource = data.agentSource || 'none';
    state.modelReady = data.modelReady === undefined ? null : !!data.modelReady;
    state.consent = data.consent && typeof data.consent === 'object'
      ? { accepted: data.consent.accepted === true, at: data.consent.at || '' }
      : { accepted: false, at: '' };
  }

  // 没确认过就把遮罩摆出来。遮罩本身挡住页面点击，
  // 后端也会拦没确认的保存请求，两层都在。
  function syncConsentUi() {
    if (!$consentVeil) return;
    var accepted = !!(state.consent && state.consent.accepted);
    $consentVeil.hidden = accepted;
    if (!accepted && $btnConsent && !consentBusy) $btnConsent.focus();
  }

  function load() {
    return apiFetch(API + '/api/state')
      .then(function (r) { return r.json(); })
      .then(function (resp) {
        if (!resp || !resp.ok) throw new Error((resp && resp.error) || '读取失败');
        applyState(resp.data || {});
        rowErrors = {};
        buildBoard();
        syncConsentUi();
      })
      .catch(function (e) {
        $board.innerHTML = '<div class="empty"><strong>读不到设置</strong>'
          + '<span class="empty-hint">' + escHtml(e && e.message ? e.message : e) + '</span></div>';
        $tally.textContent = '';
      });
  }

  // 刷新：始终可点。失败时不动现有名单，只把原因说清楚。
  function refreshList() {
    if (refreshBusy || rosterBusy) return;
    if (saveBusy()) {
      setStatus('正在保存口音，等保存完再刷新。', 'error');
      return;
    }
    refreshBusy = true;
    $btnRefresh.disabled = true;
    syncBusyUi();
    setStatus('正在刷新名单…');
    apiFetch(API + '/api/state?refresh=1', { timeout: 20000 })
      .then(function (r) { return r.json(); })
      .then(function (resp) {
        refreshBusy = false;
        if (!resp || !resp.ok) throw new Error((resp && resp.error) || '刷新失败');
        applyState(resp.data || {});
        // 展开的那位还在不在，按新名单判断：这时 DOM 还是旧的，findCard 会说谎。
        if (state.open && !agentInList(state.agents, state.open)) state.open = null;
        buildBoard();
        syncBusyUi();
        setStatus('名单已刷新。', 'ok');
      })
      .catch(function (e) {
        refreshBusy = false;
        syncBusyUi();
        setStatus('刷新失败：' + (e && e.message ? e.message : e) + '（原来的名单还在）', 'error');
      });
  }

  // ── 渲染 ──
  function statusOf(agentId) {
    if (rowErrors[agentId]) return { kind: 'error', text: '没写进去：' + rowErrors[agentId] };
    if (pending[agentId]) return { kind: '', text: '写入中…' };
    if (savedFlags[agentId]) return { kind: 'on', text: '已保存' };
    var s = settingOf(agentId);
    if (!s) return { kind: '', text: '' };
    var actual = state.actual[agentId];
    if (!actual) return { kind: 'warn', text: '还没写进人格' };
    if (actual !== s.dialect) return { kind: 'warn', text: '人格里还是「' + dialectName(actual) + '」' };
    return { kind: '', text: '' };
  }

  function stateSpanHtml(agentId) {
    var o = statusOf(agentId);
    return '<span class="state' + (o.kind ? ' is-' + o.kind : '') + '">' + escHtml(o.text) + '</span>';
  }

  function voiceOf(agentId) {
    var s = settingOf(agentId);
    if (!s) return { empty: true, text: '还没开口音' };
    return { empty: false, text: dialectName(s.dialect) };
  }

  // 话笺：ta 现在这句会怎么说。例句取自方言库本身，不另编一句。
  function noteOf(agentId, name) {
    var s = settingOf(agentId);
    var who = name || (agentId || 'ta');
    if (!s) return { empty: true, text: '还没开口音 —— 挑一口，ta 说话的味儿就定下来了。' };
    if (s.dialect === 'userstyle') return { empty: false, text: who + ' 照着你的语气说话' };
    var meta = dialectMeta(s.dialect);
    var line = meta && meta.example ? meta.example : '';
    if (!line) return { empty: false, text: who + ' 说' + dialectName(s.dialect) };
    return { empty: false, text: who + ' ' + line };
  }

  // 口音选项：每个按钮都带着自己那句例句。
  function optsHtml(agentId) {
    var s = settingOf(agentId);
    var current = s ? s.dialect : '';
    var flat = [];
    state.dialects.forEach(function (d) {
      if (d.id === 'userstyle') return;
      var on = d.id === current ? ' is-on' : '';
      var eg = d.example ? d.example : (d.tagline || '');
      var html = '<button type="button" class="opt' + on + '" data-dialect="' + escHtml(d.id) + '">'
        + '<span class="opt-name">' + escHtml(d.name) + '</span>'
        + '<span class="opt-eg">' + escHtml(eg) + '</span>'
        + '</button>';
      flat.push(html);
    });
    return flat.join('');
  }

  function userstyleRowHtml(agentId) {
    var s = settingOf(agentId);
    var enabled = Boolean(s && s.dialect === 'userstyle');
    var otherDialect = Boolean(s && s.dialect !== 'userstyle');
    var note = otherDialect
      ? '启用会替代当前方言，不会同时使用。'
      : '与方言互斥，同一位伙伴只用一种口吻。';
    return '<div class="userstyle-row">'
      + '<div class="userstyle-copy"><strong>用我的口吻</strong>'
      + '<span class="userstyle-state">' + (enabled ? '已开' : '未启用') + '</span>'
      + '<span class="userstyle-note">' + note + '</span></div>'
      + '<button type="button" class="btn-ghost userstyle-toggle" data-act="userstyle" aria-pressed="' + (enabled ? 'true' : 'false') + '"'
      + (pending[agentId] || isGloballyBusy() ? ' disabled' : '') + '>' + (enabled ? '关闭口吻' : '启用口吻') + '</button>'
      + '<button type="button" class="btn-ghost btn-line" data-act="view-style">查看口吻模板</button>'
      + '</div>';
  }

  function agentHtml(agent, showId) {
    var label = agent.name || agent.id;
    var s = settingOf(agent.id);
    var open = state.open === agent.id;
    var v = voiceOf(agent.id);
    var n = noteOf(agent.id, label);
    var cls = 'agent';
    if (open) cls += ' is-open';
    if (pending[agent.id]) cls += ' is-pending';
    var sid = safeId(agent.id);

    return ''
      + '<article class="' + cls + '" data-agent="' + escHtml(agent.id) + '">'
      + '  <button type="button" class="row" id="row-' + sid + '" aria-expanded="' + (open ? 'true' : 'false') + '"'
      + ' aria-controls="det-' + sid + '">'
      + '    <span class="ava" aria-hidden="true">' + escHtml(String(label).slice(0, 1)) + '</span>'
      + '    <span class="name">' + escHtml(label) + '</span>'
      + (showId ? '    <span class="agent-id">' + escHtml(agent.id) + '</span>' : '')
      + '    <span class="row-tail">'
      + '      <span class="voice' + (v.empty ? ' is-empty' : '') + '">' + escHtml(v.text) + '</span>'
      + '      ' + stateSpanHtml(agent.id)
      + '      <span class="row-act">' + (s ? '换口音 ›' : '选口音 ›') + '</span>'
      + '    </span>'
      + '  </button>'
      + '  <div class="detail" id="det-' + sid + '" aria-hidden="' + (open ? 'false' : 'true') + '">'
      + '    <div class="detail-inner">'
      + '      <p class="note' + (n.empty ? ' is-empty' : '') + '">' + escHtml(n.text) + '</p>'
      + '      <div class="opts" role="group" aria-label="挑一口口音">' + optsHtml(agent.id) + '</div>'
      + '      ' + userstyleRowHtml(agent.id)
      + '      <div class="actions">'
      + '        <button type="button" class="btn-ghost" data-act="clear"' + (s ? '' : ' disabled') + '>关闭口音</button>'
      + '        <button type="button" class="btn-ghost btn-line" data-act="hide">在此隐藏</button>'
      + '        <span class="hint">隐藏只影响「说方言」里的显示（语料来源下拉也会跟着），不改 ta 的口音和人格。</span>'
      + '      </div>'
      + '    </div>'
      + '  </div>'
      + '</article>';
  }

  function emptyHtml() {
    if (state.hiddenAgents && state.hiddenAgents.length) {
      return '<div class="empty"><strong>名单都藏起来了</strong>'
        + '<span class="empty-hint">现在没有可见的伙伴。下面「已隐藏」里可以放回来。</span></div>';
    }
    var hint = state.agentSource === 'none'
      ? '宿主名单、伙伴目录两档都是空的。确认 Hana 里已经有伙伴，再点右上角「刷新列表」重读一次。'
      : '名单拿到了，但一条也没剩。';
    return '<div class="empty"><strong>没读到伙伴名单</strong>'
      + '<span class="empty-hint">' + escHtml(hint) + '</span></div>';
  }

  function buildBoard() {
    if (!state.agents.length) {
      $board.innerHTML = emptyHtml();
    } else {
      // 重名时才把 id 露出来：平时 id 是噪音，撞名时它是唯一能分开的线索。
      var dup = {};
      state.agents.forEach(function (a) {
        var label = a.name || a.id;
        dup[label] = (dup[label] || 0) + 1;
      });
      $board.innerHTML = state.agents.map(function (a) {
        return agentHtml(a, dup[a.name || a.id] > 1);
      }).join('');
    }
    buildHiddenList();
    updateTally();
    updateStyleSource();
    applyOpenState();
  }

  function buildHiddenList() {
    var list = state.hiddenAgents || [];
    $hiddenBox.hidden = !list.length;
    $hiddenCount.textContent = list.length;
    if (!list.length) { $hiddenList.innerHTML = ''; return; }
    $hiddenList.innerHTML = list.map(function (a) {
      var label = a.name || a.id;
      return '<li class="hidden-item">'
        + '<span class="ava is-small" aria-hidden="true">' + escHtml(String(label).slice(0, 1)) + '</span>'
        + '<span class="name">' + escHtml(label) + '</span>'
        + '<button type="button" class="btn-ghost btn-line" data-restore="' + escHtml(a.id) + '">恢复显示</button>'
        + '</li>';
    }).join('');
  }

  // 局部更新：只改这一行的文字和类名，不碰 DOM 结构，过渡才有起点。
  function updateCard(agentId) {
    var card = findCard(agentId);
    if (!card) return;
    var s = settingOf(agentId);
    card.classList.toggle('is-pending', Boolean(pending[agentId]));

    var row = card.querySelector('.row');
    if (row) row.setAttribute('aria-expanded', state.open === agentId ? 'true' : 'false');

    var st = card.querySelector('.state');
    if (st) {
      var o = statusOf(agentId);
      st.className = 'state' + (o.kind ? ' is-' + o.kind : '');
      st.textContent = o.text;
    }

    var v = voiceOf(agentId);
    var voiceEl = card.querySelector('.voice');
    if (voiceEl) {
      voiceEl.className = 'voice' + (v.empty ? ' is-empty' : '');
      voiceEl.textContent = v.text;
    }

    var act = card.querySelector('.row-act');
    if (act) act.textContent = s ? '换口音 ›' : '选口音 ›';

    var note = card.querySelector('.note');
    if (note) {
      var nameEl = card.querySelector('.name');
      var n = noteOf(agentId, nameEl ? nameEl.textContent : '');
      note.className = 'note' + (n.empty ? ' is-empty' : '');
      note.textContent = n.text;
    }

    var current = s ? s.dialect : '';
    Array.prototype.forEach.call(card.querySelectorAll('.opt'), function (o) {
      o.classList.toggle('is-on', o.getAttribute('data-dialect') === current);
    });
    var userstyleState = card.querySelector('.userstyle-state');
    var userstyleNote = card.querySelector('.userstyle-note');
    var userstyleToggle = card.querySelector('.userstyle-toggle');
    var userstyleEnabled = current === 'userstyle';
    if (userstyleState) userstyleState.textContent = userstyleEnabled ? '已开' : '未启用';
    if (userstyleNote) userstyleNote.textContent = current && !userstyleEnabled
      ? '启用会替代当前方言，不会同时使用。'
      : '与方言互斥，同一位伙伴只用一种口吻。';
    if (userstyleToggle) {
      userstyleToggle.textContent = userstyleEnabled ? '关闭口吻' : '启用口吻';
      userstyleToggle.setAttribute('aria-pressed', userstyleEnabled ? 'true' : 'false');
    }

    syncCardBusy(card, agentId);
  }

  // 正在刷名单 / 正在动名单时，整页都不许改口音：
  // 刷新回来的配置会把没保存的选择盖掉，写入途中的同一位再点也会被冲掉。
  function isGloballyBusy() {
    return refreshBusy || rosterBusy;
  }

  function syncCardBusy(card, agentId) {
    var busy = isGloballyBusy();
    var writing = Boolean(pending[agentId]);
    Array.prototype.forEach.call(card.querySelectorAll('.opt'), function (o) {
      o.disabled = busy || writing;
    });
    var clearBtn = card.querySelector('[data-act="clear"]');
    if (clearBtn) clearBtn.disabled = busy || writing || !settingOf(agentId);
    var userstyleBtn = card.querySelector('[data-act="userstyle"]');
    if (userstyleBtn) userstyleBtn.disabled = busy || writing;
    var hideBtn = card.querySelector('[data-act="hide"]');
    if (hideBtn) hideBtn.disabled = busy;
  }

  function syncBusyUi() {
    Array.prototype.forEach.call($board.querySelectorAll('.agent'), function (card) {
      syncCardBusy(card, card.getAttribute('data-agent'));
    });
    $btnRefresh.disabled = rosterBusy || refreshBusy;
  }

  function updateTally() {
    var total = state.agents.length;
    var hidden = (state.hiddenAgents || []).length;
    var bits = [];
    if (total) {
      var on = state.agents.filter(function (a) { return Boolean(settingOf(a.id)); }).length;
      bits.push(total + ' 位伙伴 · ' + on + ' 位开了口音');
    }
    if (hidden) bits.push(hidden + ' 位已隐藏');
    $tally.textContent = bits.join(' · ');
  }

  function scrollCardIntoView(agentId) {
    var card = findCard(agentId);
    if (!card) return;
    try {
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) { /* 老内核不支持平滑滚动，忽略 */ }
  }

  function markRowError(agentId, reason) {
    rowErrors[agentId] = reason;
    updateCard(agentId);
    setTimeout(function () {
      if (rowErrors[agentId] === reason) {
        delete rowErrors[agentId];
        updateCard(agentId);
      }
    }, 6000);
  }

  // ── 展开 / 收起 ──
  function applyOpenState() {
    Array.prototype.forEach.call($board.querySelectorAll('.agent'), function (card) {
      var on = card.getAttribute('data-agent') === state.open;
      card.classList.toggle('is-open', on);
      var row = card.querySelector('.row');
      if (row) row.setAttribute('aria-expanded', on ? 'true' : 'false');
      var detail = card.querySelector('.detail');
      if (detail) {
        detail.setAttribute('aria-hidden', on ? 'false' : 'true');
        try { detail.inert = !on; } catch (e) { /* 老内核没有 inert */ }
      }
    });
  }

  function setOpen(agentId) {
    state.open = agentId || null;
    applyOpenState();
    if (state.open) scrollCardIntoView(state.open);
  }

  function toggleOpen(agentId) {
    setOpen(state.open === agentId ? null : agentId);
  }

  // ── 改一位 ──
  function setLocal(agentId, dialect) {
    if (!state.config.agents) state.config.agents = {};
    if (!dialect) delete state.config.agents[agentId];
    else state.config.agents[agentId] = { dialect: dialect, enabled: true };
  }

  function configPayload() {
    var agents = {};
    Object.keys(state.config.agents || {}).forEach(function (id) {
      var s = state.config.agents[id];
      if (!s || s.enabled === false || !s.dialect) return;
      agents[id] = { dialect: s.dialect, enabled: true };
    });
    return { version: 4, agents: agents };
  }

  function handlePick(agentId, dialect) {
    // 护栏：名单正在变的时候不收新选择。
    // 刷新回来的配置会把还没保存的选择盖掉；写入途中的同一位再点，
    // 会被下一次 flush 按旧的选择写回去。
    if (refreshBusy) {
      setStatus('正在刷新名单，等它跑完再改口音。', 'error');
      return;
    }
    if (rosterBusy) {
      setStatus('正在动名单（隐藏/恢复），等它跑完再改口音。', 'error');
      return;
    }
    if (pending[agentId]) {
      setStatus('这一位正在写入，等写完再点。', 'error');
      return;
    }
    if (!state.dialects.length || !state.agents.length) {
      setStatus('还没读到名单和口音清单，稍后再点。', 'error');
      return;
    }

    var s = settingOf(agentId);
    var next = s && s.dialect === dialect ? '' : dialect;

    // 「学我说话」得先有模板，不然人格里没东西可写。把人引到模板区去。
    if (next === 'userstyle' && !hasTemplate()) {
      openStyle();
      var hasDraft = Boolean(state.style && state.style.draft);
      if (state.modelReady === false) {
        styleStatus('Hana 里现在没有可用的文本模型，「学我说话」跑不起来。先在设置里配好模型。', 'error');
      } else {
        var adoptLabel = state.style && state.style.draft && !state.style.current
          && !((state.style.versions || []).length) ? '采用首版' : '采用新版';
        styleStatus(hasDraft
          ? '模板还是草稿，先在上面点「' + adoptLabel + '」，再回来挑这一格。'
          : '还没有模板。挑一位伙伴当语料来源，点「总结」，再回来挑这一格。', 'error');
      }
      return;
    }

    delete rowErrors[agentId];
    setLocal(agentId, next);
    updateCard(agentId);
    updateTally();
    scheduleSave([agentId]);
    // 让选中态先亮相再收抽屉，不然一眨眼什么都看不见
    setTimeout(function () {
      if (state.open === agentId) setOpen(null);
    }, 260);
  }

  function switchPage(page, focusTab) {
    var showStyle = page === 'style';
    $tabDialect.setAttribute('aria-selected', showStyle ? 'false' : 'true');
    $tabStyle.setAttribute('aria-selected', showStyle ? 'true' : 'false');
    $tabDialect.tabIndex = showStyle ? -1 : 0;
    $tabStyle.tabIndex = showStyle ? 0 : -1;
    $panelDialect.hidden = showStyle;
    $panelStyle.hidden = !showStyle;
    $panelDialect.inert = showStyle;
    $panelStyle.inert = !showStyle;
    if (focusTab) (showStyle ? $tabStyle : $tabDialect).focus();
  }

  $tabDialect.addEventListener('click', function () { switchPage('dialect'); });
  $tabStyle.addEventListener('click', function () { switchPage('style'); });
  function handleTabKeydown(e) {
    var next = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') next = e.currentTarget === $tabStyle ? 'dialect' : 'style';
    else if (e.key === 'Home') next = 'dialect';
    else if (e.key === 'End') next = 'style';
    if (!next) return;
    e.preventDefault();
    switchPage(next, true);
  }
  $tabDialect.addEventListener('keydown', handleTabKeydown);
  $tabStyle.addEventListener('keydown', handleTabKeydown);

  $board.addEventListener('click', function (e) {
    var card = e.target.closest ? e.target.closest('.agent') : null;
    if (!card) return;
    var agentId = card.getAttribute('data-agent');

    if (e.target.closest('[data-act="view-style"]')) {
      switchPage('style', true);
      return;
    }

    if (e.target.closest('[data-act="userstyle"]')) {
      handlePick(agentId, 'userstyle');
      return;
    }

    if (e.target.closest('[data-act="hide"]')) {
      hideAgent(agentId);
      return;
    }

    if (e.target.closest('[data-act="clear"]')) {
      var cur = settingOf(agentId);
      if (cur) handlePick(agentId, cur.dialect);
      return;
    }

    var opt = e.target.closest('.opt');
    if (opt) {
      handlePick(agentId, opt.getAttribute('data-dialect'));
      return;
    }

    if (e.target.closest('.row')) toggleOpen(agentId);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || $panelDialect.hidden || !state.open) return;
    var id = state.open;
    setOpen(null);
    var row = document.getElementById('row-' + safeId(id));
    if (row && row.focus) {
      try { row.focus(); } catch (e) { /* 聚焦失败就算了 */ }
    }
  });

  // ── 保存口音 ──
  function scheduleSave(agentIds) {
    agentIds.forEach(function (id) { pending[id] = true; });
    agentIds.forEach(updateCard);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      chain = chain.then(flush).catch(function () { /* flush 自己会报错 */ });
    }, 240);
  }

  function flush() {
    var ids = Object.keys(pending);
    if (!ids.length) return Promise.resolve();
    return apiFetch(API + '/api/dialect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(configPayload()),
      timeout: 30000,
    })
      .then(function (r) { return r.json(); })
      .then(function (resp) {
        var failures = {};
        ((resp && resp.failures) || []).forEach(function (f) {
          failures[f.agentId] = f.error || '写入失败';
        });
        var ok = resp && resp.ok;
        var configError = resp && resp.error ? resp.error : '';
        ids.forEach(function (id) {
          delete pending[id];
          if (ok && !failures[id]) {
            var s = settingOf(id);
            if (s) state.actual[id] = s.dialect; else delete state.actual[id];
            markSaved(id);
          }
        });
        ids.forEach(function (id) {
          if (failures[id]) markRowError(id, failures[id]);
          else if (!ok && configError) markRowError(id, configError);
          else updateCard(id);
        });
        updateTally();
      })
      .catch(function (e) {
        var reason = e && e.message ? e.message : String(e);
        ids.forEach(function (id) {
          delete pending[id];
          markRowError(id, reason);
        });
      });
  }

  // 保存成功只说一次：过几秒自己淡掉，不长期占着这一行。
  function markSaved(agentId) {
    savedFlags[agentId] = true;
    updateCard(agentId);
    if (savedTimers[agentId]) clearTimeout(savedTimers[agentId]);
    savedTimers[agentId] = setTimeout(function () {
      delete savedTimers[agentId];
      delete savedFlags[agentId];
      updateCard(agentId);
    }, 2600);
  }

  // ── 名单可见性：隐藏 / 恢复 ──
  // 名单操作排在口音写入后面：先把手上的写完，再动名单。
  function enqueueRoster(fn) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (saveBusy()) {
      chain = chain.then(flush).catch(function () { /* flush 自己会报错 */ });
    }
    var run = chain.then(fn);
    // 队列本身不能因为一次失败而断掉，但这次失败要交给调用方处理。
    chain = run.catch(function () { /* 失败由 rosterRequest 自己报 */ });
    return run;
  }

  function setRosterBusyUi(busy) {
    rosterBusy = busy;
    var buttons = document.querySelectorAll('[data-act="hide"], [data-restore]');
    Array.prototype.forEach.call(buttons, function (b) { b.disabled = busy; });
    syncBusyUi();
  }

  function applyRoster(data) {
    data = data || {};
    if (Array.isArray(data.agents)) state.agents = data.agents;
    if (Array.isArray(data.hiddenAgents)) state.hiddenAgents = data.hiddenAgents;
    // 展开的那位还在不在，按新名单判断：DOM 还是旧的，findCard 会说谎。
    if (state.open && !agentInList(state.agents, state.open)) state.open = null;
    buildBoard();
    syncBusyUi();
  }

  function rosterRequest(agentId, hidden) {
    if (rosterBusy) return Promise.resolve(false);
    var epoch = ++rosterEpoch;
    setRosterBusyUi(true);
    return enqueueRoster(function () {
      return apiFetch(API + '/api/roster-visibility', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: agentId, hidden: hidden }),
        timeout: 20000,
      })
        .then(function (r) {
          return r.json().catch(function () {
            return { ok: false, error: '接口没有返回 JSON（' + r.status + '）' };
          });
        })
        .then(function (resp) {
          if (!resp || !resp.ok) throw new Error((resp && resp.error) || '操作失败');
          if (epoch !== rosterEpoch) return;   // 迟到的响应，丢掉
          applyRoster(resp.data || {});
        });
    })
      .then(function () {
        setRosterBusyUi(false);
        return true;
      })
      .catch(function (e) {
        setRosterBusyUi(false);
        setStatus((hidden ? '隐藏失败：' : '恢复失败：') + (e && e.message ? e.message : e), 'error');
        return false;
      });
  }

  function hideAgent(agentId) {
    var name = agentName(agentId);
    return rosterRequest(agentId, true).then(function (ok) {
      if (ok) setStatus('已隐藏「' + name + '」，在下面「已隐藏」里可以放回来。', 'ok');
    });
  }

  function restoreAgent(agentId) {
    var name = agentName(agentId);
    return rosterRequest(agentId, false).then(function (ok) {
      if (!ok) return;
      setStatus('已把「' + name + '」放回名单。', 'ok');
      var row = document.getElementById('row-' + safeId(agentId));
      if (row && row.focus) {
        try { row.focus(); } catch (e) { /* 聚焦失败就算了 */ }
      }
    });
  }

  function agentName(agentId) {
    var all = state.agents.concat(state.hiddenAgents || []);
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === agentId) return all[i].name || all[i].id;
    }
    return agentId;
  }

  $hiddenList.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-restore]') : null;
    if (!btn) return;
    restoreAgent(btn.getAttribute('data-restore'));
  });

  $btnRefresh.addEventListener('click', refreshList);

  // ── 「学我说话」模板 ──
  function openStyle() {
    switchPage('style', true);
  }

  function updateStyleTabIndicator() {
    var hasDraft = Boolean(state.style && state.style.draft);
    var text = summaryBusy ? '总结中' : (hasDraft ? '有新稿' : '');
    $styleTabIndicator.textContent = text;
    $styleTabIndicator.hidden = !text;
  }

  function styleStatus(text, kind) {
    $styleStatus.textContent = text || '';
    $styleStatus.className = 'style-status' + (kind ? ' is-' + kind : '');
  }

  // 名单变了，下拉跟着变；原来选的那位还在就留着，不在了就换第一位。
  function updateStyleSource(previous) {
    var prev = previous === undefined ? $styleSource.value : previous;
    var legal = {};
    state.agents.forEach(function (a) { legal[a.id] = true; });
    if (!prev || !legal[prev]) prev = state.agents.length ? state.agents[0].id : '';
    $styleSource.innerHTML = state.agents.map(function (a) {
      var sel = a.id === prev ? ' selected' : '';
      return '<option value="' + escHtml(a.id) + '"' + sel + '>' + escHtml(a.name || a.id) + '</option>';
    }).join('');
    $styleSource.disabled = !state.agents.length;
  }

  var summaryBusy = false;
  var summaryTimer;
  function setStyleActionBusy(busy) {
    styleActionBusy = busy;
    $btnSummary.disabled = busy || summaryBusy || state.modelReady === false;
    $btnConfirm.disabled = $btnRevert.disabled = busy || summaryBusy;
    $styleVersion.disabled = busy || summaryBusy;
  }

  function setSummaryBusy(busy) {
    summaryBusy = busy;
    $btnSummary.disabled = busy || styleActionBusy || state.modelReady === false;
    $btnConfirm.disabled = $btnRevert.disabled = busy || styleActionBusy;
    $styleVersion.disabled = busy || styleActionBusy;
    updateStyleTabIndicator();
  }

  function latestStyleVersion(versions, kind) {
    var candidates = kind ? versions.filter(function (v) { return v.kind === kind; }) : versions;
    if (!candidates.length) return null;
    var latest = candidates[0];
    var latestAt = Date.parse(latest.at || '');
    candidates.forEach(function (version) {
      var at = Date.parse(version.at || '');
      if (!isNaN(at) && (isNaN(latestAt) || at > latestAt)) {
        latest = version;
        latestAt = at;
      }
    });
    return latest;
  }

  function renderStyleComparison(d) {
    var versions = Array.isArray(d.versions) ? d.versions : [];
    var current = d.current ? String(d.current) : '';
    var draft = d.draft ? String(d.draft) : '';
    var previousDraft = !current && draft ? latestStyleVersion(versions, 'draft') : null;
    styleRevertAction = null;
    styleRevertVersionId = null;

    var versionOptions = [];
    if (draft) versionOptions.push('<option value="__style_draft__">新草稿</option>');
    versions.forEach(function (v) {
      var date = v.at ? String(v.at).slice(0, 16).replace('T', ' ') : '未标注时间';
      var label = v.kind === 'draft' ? '旧草稿 · ' + date : '历史版 · ' + date;
      versionOptions.push('<option value="' + escHtml(v.id) + '">' + escHtml(label) + '</option>');
    });
    $styleVersion.innerHTML = versionOptions.join('');
    $styleHistory.hidden = !versions.length;
    $styleHistoryCount.textContent = versions.length ? '（' + versions.length + '）' : '';

    var selected = null;
    if (selectedVersionId != null) {
      selected = versions.find(function (v) { return String(v.id) === String(selectedVersionId); }) || null;
    }
    if (styleCompareMode !== 'history' || !selected) {
      if (draft) {
        styleCompareMode = 'draft';
        selectedVersionId = null;
      } else if (versions.length) {
        styleCompareMode = 'history';
        selected = latestStyleVersion(versions);
        selectedVersionId = selected.id;
      } else {
        styleCompareMode = null;
        selectedVersionId = null;
      }
    }

    if (!current && draft && styleCompareMode === 'draft') {
      $styleCurrentTitle.textContent = '上一份草稿';
      $styleCurrent.textContent = previousDraft ? String(previousDraft.text == null ? '' : previousDraft.text) : '还没有归档的旧草稿。';
    } else if (!current && draft && styleCompareMode === 'history') {
      $styleCurrentTitle.textContent = '新草稿';
      $styleCurrent.textContent = draft;
    } else {
      $styleCurrentTitle.textContent = current ? '当前版' : '尚无当前版';
      $styleCurrent.textContent = current || '还没有已采用的版本。';
    }

    if (styleCompareMode === 'history' && selected) {
      $styleVersion.value = String(selected.id);
      var dateLabel = selected.at ? String(selected.at).slice(0, 10) : '未标注日期';
      $styleCandidateTitle.textContent = (selected.kind === 'draft' ? '旧草稿 · ' : '历史版 · ') + dateLabel;
      $styleText.textContent = String(selected.text == null ? '' : selected.text);
      $btnConfirm.hidden = true;
      $btnRevert.hidden = false;
      $btnRevert.textContent = selected.kind === 'draft' ? '采用这份旧草稿' : '恢复这版';
      styleRevertAction = 'version';
      styleRevertVersionId = selected.id;
    } else if (draft) {
      $styleVersion.value = '__style_draft__';
      $styleCandidateTitle.textContent = '新草稿';
      $styleText.textContent = draft;
      $btnConfirm.hidden = false;
      $btnConfirm.textContent = !current && versions.length === 0 ? '采用首版' : '采用新版';
      $btnRevert.hidden = true;
      if (current) {
        $btnRevert.hidden = false;
        $btnRevert.textContent = '保留原版';
        styleRevertAction = 'keep-current';
      } else if (previousDraft) {
        $btnRevert.hidden = false;
        $btnRevert.textContent = '采用上一稿';
        styleRevertAction = 'version';
        styleRevertVersionId = previousDraft.id;
      }
    } else {
      $styleCandidateTitle.textContent = '历史版本';
      $styleText.textContent = selected ? String(selected.text == null ? '' : selected.text) : '还没有草稿或历史版本。';
      $btnConfirm.hidden = true;
      $btnRevert.hidden = !selected;
      if (selected) {
        $btnRevert.textContent = selected.kind === 'draft' ? '采用这份旧草稿' : '恢复这版';
        styleRevertAction = 'version';
        styleRevertVersionId = selected.id;
      }
    }

    // 换版本时从首行开始看，避免滚动位置把新内容的开头藏住。
    $styleCurrent.scrollTop = 0;
    $styleText.scrollTop = 0;
    updateStyleTabIndicator();
  }

  function styleComparisonStatus(d) {
    if (d.current && d.draft && styleCompareMode === 'history') return '左栏是当前采用版；右栏是所选版本，可从列表切回新草稿。';
    if (d.current && d.draft) return '左栏是当前采用版；右栏是新草稿，也可切到历史版本。';
    if (d.current) return '左栏是当前采用版；右栏显示所选历史版本。';
    if (d.draft && styleCompareMode === 'history') return '还没有已采用版；左栏保留新草稿，右栏是所选版本。';
    if (d.draft) return '还没有已采用版；左栏是上一份归档草稿（若有），右栏是新草稿。';
    if (Array.isArray(d.versions) && d.versions.length) return '还没有已采用版；右栏显示所选历史版本。';
    return '还没有已采用的版本。选一位伙伴当语料来源，点「总结」。';
  }

  $styleVersion.addEventListener('change', function () {
    if (summaryBusy || styleActionBusy) return;
    if ($styleVersion.value === '__style_draft__') {
      selectedVersionId = null;
      styleCompareMode = 'draft';
    } else {
      selectedVersionId = $styleVersion.value;
      styleCompareMode = 'history';
    }
    var d = state.style || {};
    renderStyleComparison(d);
    styleStatus(styleComparisonStatus(d));
  });

  function loadStyle() {
    return apiFetch(API + '/api/style-template')
      .then(function (r) { return r.json(); })
      .then(function (resp) {
        if (!resp || !resp.ok) throw new Error((resp && resp.error) || '读取失败');
        var d = resp.data || {};
        state.style = d;
        renderStyleComparison(d);
        styleStatus(styleComparisonStatus(d), d.current || d.draft ? 'ok' : '');

        // 没有可用模型时把「总结」按住，别让人白点。
        var noModel = state.modelReady === false;
        setSummaryBusy(summaryBusy);
        if (noModel && !d.draft) {
          styleStatus('Hana 里现在没有可用的文本模型，「学我说话」跑不起来。先在设置里配好模型，再回这一栏。', 'error');
        }

        updateStyleSource();
      })
      .catch(function (e) {
        updateStyleTabIndicator();
        styleStatus('读不到模板：' + (e && e.message ? e.message : e), 'error');
      });
  }

  function readSummaryResponse(r) {
    return r.json().catch(function () {
      throw new Error('Hana 未能返回总结结果' + (r.status ? '（HTTP ' + r.status + '）' : '') + '。');
    });
  }

  function showSummaryTask(task, resumed) {
    if (task && task.status === 'running') {
      setSummaryBusy(true);
      var phases = { sampling: '正在从会话取样…', distilling: '正在总结说话习惯…', saving: '正在保存草稿…' };
      updateStyleTabIndicator();
      styleStatus(phases[task.phase] || '正在总结…');
      summaryTimer = setTimeout(pollSummary, 1500);
      return;
    }
    if (task && task.status === 'done' && !resumed) {
      styleCompareMode = 'draft';
      selectedVersionId = null;
      return loadStyle().finally(function () { setSummaryBusy(false); });
    }
    setSummaryBusy(false);
    if (task && task.status === 'failed') {
      updateStyleTabIndicator();
      styleStatus(task.error || '总结失败，请重试。', 'error');
    } else if (!task && !resumed) {
      updateStyleTabIndicator();
      styleStatus('找不到这次总结任务，请重试。', 'error');
    }
  }

  function pollSummary(resumed) {
    clearTimeout(summaryTimer);
    return apiFetch(API + '/api/style/summary', { timeout: 5000 })
      .then(readSummaryResponse)
      .then(function (resp) {
        if (!resp || !resp.ok) throw new Error(resp && resp.error || '读取进度失败');
        return showSummaryTask(resp.data && resp.data.task, resumed);
      })
      .catch(function () {
        if (resumed) { setSummaryBusy(false); return; }
        if (!summaryBusy) return;
        styleStatus('暂时读不到进度，任务可能还在后台运行。正在重连…', 'error');
        summaryTimer = setTimeout(pollSummary, 3000);
      });
  }

  $btnSummary.addEventListener('click', function () {
    if (summaryBusy || styleActionBusy) return;
    var agentId = $styleSource.value;
    if (!agentId) { styleStatus('先选一位伙伴当语料来源', 'error'); return; }
    setSummaryBusy(true);
    styleStatus('正在提交总结任务…');
    apiFetch(API + '/api/style/summary', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: agentId }),
    })
      .then(readSummaryResponse)
      .then(function (resp) {
        if (!resp || !resp.ok) {
          setSummaryBusy(false);
          styleStatus((resp && resp.error) || '总结失败', 'error');
          return;
        }
        return showSummaryTask(resp.data && resp.data.task);
      })
      .catch(function (e) {
        setSummaryBusy(false);
        styleStatus('提交未获确认：' + (e && e.message ? e.message : e) + '可重试；已在运行的任务不会重复启动。', 'error');
      });
  });

  $btnConfirm.addEventListener('click', function () {
    if (summaryBusy || styleActionBusy || $btnConfirm.hidden) return;
    setStyleActionBusy(true);
    apiFetch(API + '/api/style-template/confirm', { method: 'POST', timeout: 60000 })
      .then(function (r) { return r.json(); })
      .then(function (resp) {
        if (!resp || !resp.ok) {
          setStyleActionBusy(false);
          styleStatus((resp && resp.error) || '采用失败', 'error');
          return;
        }
        styleCompareMode = null;
        selectedVersionId = null;
        return loadStyle().then(function () {
          setStyleActionBusy(false);
          styleStatus(resp.message || '已采用', 'ok');
        });
      })
      .catch(function (e) {
        setStyleActionBusy(false);
        styleStatus('采用失败：' + (e && e.message ? e.message : e), 'error');
      });
  });

  $btnRevert.addEventListener('click', function () {
    if (summaryBusy || styleActionBusy || $btnRevert.hidden || !styleRevertAction) return;
    var action = styleRevertAction;
    var versionId = styleRevertVersionId;
    setStyleActionBusy(true);

    if (action === 'keep-current') {
      apiFetch(API + '/api/style-template/keep-current', { method: 'POST', timeout: 60000 })
        .then(function (r) { return r.json(); })
        .then(function (resp) {
          if (!resp || !resp.ok) {
            setStyleActionBusy(false);
            styleStatus((resp && resp.error) || '保留原版失败', 'error');
            return;
          }
          styleCompareMode = null;
          selectedVersionId = null;
          return loadStyle().then(function () {
            setStyleActionBusy(false);
            styleStatus(resp.message || '已保留原版，新稿已存入历史。', 'ok');
          });
        })
        .catch(function (e) {
          setStyleActionBusy(false);
          styleStatus('保留原版失败：' + (e && e.message ? e.message : e), 'error');
        });
      return;
    }

    if (versionId == null) {
      setStyleActionBusy(false);
      styleStatus('先选一版历史内容。', 'error');
      return;
    }
    apiFetch(API + '/api/style-template/revert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ versionId: versionId }),
      timeout: 60000,
    })
      .then(function (r) { return r.json(); })
      .then(function (resp) {
        if (!resp || !resp.ok) {
          var reason = (resp && resp.error) || '恢复失败';
          // 后端可能已更新模板、但人格同步失败；刷新对比后仍保留业务错误。
          return loadStyle().then(function () {
            setStyleActionBusy(false);
            styleStatus(reason, 'error');
          });
        }
        styleCompareMode = null;
        selectedVersionId = null;
        return loadStyle().then(function () {
          setStyleActionBusy(false);
          styleStatus(resp.message || '已恢复这版', 'ok');
        });
      })
      .catch(function (e) {
        var reason = '恢复失败：' + (e && e.message ? e.message : e);
        // 请求结果不明确时也重新读模板；失败提示保留供用户重试。
        loadStyle().then(function () {
          setStyleActionBusy(false);
          styleStatus(reason, 'error');
        });
      });
  });

  // 首次确认：写人格这件事，点过才动手。
  if ($btnConsent) {
    $btnConsent.addEventListener('click', function () {
      if (consentBusy) return;
      consentBusy = true;
      $btnConsent.disabled = true;
      $btnConsent.textContent = '记下了…';
      apiFetch(API + '/api/consent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accepted: true }),
        timeout: 10000,
      })
        .then(function (r) { return r.json(); })
        .then(function (resp) {
          consentBusy = false;
          if (!resp || !resp.ok) throw new Error((resp && resp.error) || '没记下来');
          state.consent = { accepted: true, at: (resp.data && resp.data.at) || '' };
          $btnConsent.disabled = false;
          $btnConsent.textContent = '知道了，开始挑';
          syncConsentUi();
        })
        .catch(function (e) {
          // 没记下来就停在遮罩上：不能让人以为已经确认过了。
          consentBusy = false;
          $btnConsent.disabled = false;
          $btnConsent.textContent = '再点一次（' + (e && e.message ? e.message : e) + '）';
        });
    });
  }

  switchPage('dialect');
  setSummaryBusy(true);
  load().then(loadStyle).then(function () { return pollSummary(true); });

  // 测试钩子：只有测试自己把 window.__PANEL_TEST__ 打开时才挂出来，
  // 平时页面上不会多出全局变量。
  if (window.__PANEL_TEST__) {
    window.__panelTest = {
      state: state,
      statusOf: statusOf,
      settingOf: settingOf,
      rowErrors: function () { return rowErrors; },
      savedFlags: function () { return savedFlags; },
      pending: function () { return pending; },
      busy: function () { return { refreshBusy: refreshBusy, rosterBusy: rosterBusy }; },
      consent: function () { return state.consent; },
      syncConsentUi: syncConsentUi,
    };
  }
})();
