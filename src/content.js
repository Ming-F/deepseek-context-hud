/* ============================================================================
 * DeepSeek 上下文仪表 · UI 与状态层
 * ----------------------------------------------------------------------------
 * 运行环境：isolated world（可用 chrome.storage）
 * 数据来源：main-world.js 通过 window.postMessage 投递
 *
 * 显示原则：
 *   实测值 → 实心数字；估算值 → 前缀 ~ 并置灰；上次记忆值 → 时钟标记。
 *   宁可显示"未知"，也不把估算伪装成精确值。
 * ==========================================================================*/
(function () {
  'use strict';

  if (window.__dsHudUiLoaded) return;
  window.__dsHudUiLoaded = true;

  var TAG = '__dsHud';
  var STORE_KEY = 'dsh:v1:sessions';
  var SETTINGS_KEY = 'dsh:v1:settings';
  var MAX_SESSIONS = 40;

  /* 三个不同的"上限"，含义不同，不能混用：
   *   windowSize  模型窗口，官方公告为 1M，覆盖网页版（deepseek.com/news/v4-preview）
   *   serverLimit 服务端下发的 normal_history_and_file_token_limit，字段真实但语义未公开
   *   blockLine   实际被拒发时的已用量，非官方数值，靠拦截事件实测得到
   * 默认分母取服务端下发值；拿不到才退回经验值，被拦截后再用实测值修正。 */
  var DEFAULTS = {
    limit: 962000,        // 经验值，非官方。仅作兜底
    window: 1000000       // 官方：1M context
  };

  var state = {
    sessionKey: '',       // 置空以便首次 switchSession 能正常加载记忆值
    used: null,
    usedSource: null,     // sse | history | estimate | memory
    usedAt: 0,
    limit: DEFAULTS.limit,
    limitSource: 'default',
    windowSize: DEFAULTS.window,
    serverLimit: null,    // 服务端下发的原始值
    serverTokenLimit: null,
    thinkingLimit: null,
    thinking: false,
    blockLine: null,      // 实测被拒发时的已用量
    startedAt: null,      // 会话起点（毫秒）
    startedSource: null,  // history | observed
    lastAt: null,
    turns: [],            // [{ delta, total, at }]
    messages: [],         // [{ role, text }]
    blocked: null,
    inputTokens: 0,
    pendingDelta: 0,
    turnBase: null,       // 上一轮结束时的已用量，避免增量重复累加
    lastThinkChars: 0,
    lastTurn: null,       // { delta, ansChars, thinkChars } —— 用于单轮交叉验证
    cotChars: 0,
    answerChars: 0,
    expanded: false,
    digestText: '',
    toastTimer: null
  };

  var settings = { autoCalibrate: true, limitOverride: 0 };
  var refs = {};
  var host = null;
  var shadow = null;
  var lastComposer = null;

  /* =========================================================== 工具 =====*/

  function fmt(n) {
    if (n === null || n === undefined || !isFinite(n)) return '--';
    if (n >= 1000000) return (n / 1000000).toFixed(2).replace(/\.?0+$/, '') + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'K';
    return String(Math.round(n));
  }

  function clampText(s, n) {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function estimateTokens(text) {
    if (!text) return 0;
    var cjk = 0, other = 0;
    for (var i = 0; i < text.length; i++) {
      var code = text.codePointAt(i);
      if (code >= 0x4e00 && code <= 0x9fff) cjk++;
      else other++;
    }
    return Math.round(cjk * 0.6 + other * 0.3);
  }

  /* 72 小时长对话限制：App 端已生效（「由于算力不足，已超过 72 小时的长对话暂不可用」），
     网页端尚未全量，作为参考基线展示。 */
  var TIME_CAP_MS = 72 * 3600 * 1000;

  function fmtDur(ms) {
    if (ms == null || !isFinite(ms) || ms < 0) return '--';
    var m = Math.floor(ms / 60000);
    if (m < 60) return m + ' 分钟';
    var h = Math.floor(m / 60);
    if (h < 48) return h + ' 小时' + (m % 60 ? ' ' + (m % 60) + ' 分' : '');
    var d = Math.floor(h / 24);
    return d + ' 天' + (h % 24 ? ' ' + (h % 24) + ' 小时' : '');
  }

  /** 已用时长，向下取整到分钟——否则剩余时间会出现「1 小时 59 分」这类秒级残差 */
  function elapsedMs() {
    if (!state.startedAt) return null;
    var e = Date.now() - state.startedAt;
    if (e < 0) return 0;
    return Math.floor(e / 60000) * 60000;
  }

  function timePercent() {
    var e = elapsedMs();
    return e === null ? null : (e / TIME_CAP_MS) * 100;
  }

  function post(cmd, extra) {
    var msg = { k: 'cmd', cmd: cmd };
    if (extra) for (var k in extra) msg[k] = extra[k];
    msg[TAG] = 1;
    window.postMessage(msg, location.origin);
  }

  /* =========================================================== 存储 =====*/

  function loadSessions() {
    return chrome.storage.local.get(STORE_KEY).then(function (r) {
      return r[STORE_KEY] || {};
    }).catch(function () { return {}; });
  }

  function persist() {
    return loadSessions().then(function (all) {
      all[state.sessionKey] = {
        used: state.used,
        usedAt: state.usedAt,
        turns: state.turns.slice(-40),
        limit: state.limit,
        limitSource: state.limitSource,
        startedAt: state.startedAt,
        startedSource: state.startedSource
      };
      var keys = Object.keys(all);
      if (keys.length > MAX_SESSIONS) {
        keys.sort(function (a, b) { return (all[a].usedAt || 0) - (all[b].usedAt || 0); });
        for (var i = 0; i < keys.length - MAX_SESSIONS; i++) delete all[keys[i]];
      }
      var patch = {};
      patch[STORE_KEY] = all;
      return chrome.storage.local.set(patch);
    }).catch(function () {});
  }

  var persistTimer = null;
  function debouncedPersist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persist, 400);
  }

  var turnTimer = null;
  function scheduleTurnCommit() {
    clearTimeout(turnTimer);
    turnTimer = setTimeout(function () {
      if (state.pendingDelta > 0) {
        state.turns.push({
          delta: Math.round(state.pendingDelta),
          total: state.used,
          at: Date.now()
        });
        if (state.turns.length > 60) state.turns = state.turns.slice(-60);
        state.lastTurn = {
          delta: Math.round(state.pendingDelta),
          ansChars: lastAssistantText().length,
          thinkChars: state.lastThinkChars
        };
        state.lastThinkChars = 0;
        state.turnBase = state.used;
        state.pendingDelta = 0;
        persist();
        render();
      }
    }, 1200);
  }

  function loadSettings() {
    return chrome.storage.local.get(SETTINGS_KEY).then(function (r) {
      var s = r[SETTINGS_KEY] || {};
      settings.autoCalibrate = s.autoCalibrate !== false;
      settings.limitOverride = s.limitOverride || 0;
      if (settings.limitOverride > 0) {
        state.limit = settings.limitOverride;
        state.limitSource = 'override';
      }
      if (refs.autoCal) refs.autoCal.checked = settings.autoCalibrate;
      post('config', { autoCalibrate: settings.autoCalibrate });
    }).catch(function () {});
  }

  function saveSettings() {
    var patch = {};
    patch[SETTINGS_KEY] = settings;
    chrome.storage.local.set(patch).catch(function () {});
    post('config', { autoCalibrate: settings.autoCalibrate });
  }

  /* ======================================================= 会话切换 =====*/

  function switchSession(key) {
    if (!key || key === state.sessionKey) return;
    state.sessionKey = key;
    state.used = null;
    state.usedSource = null;
    state.turns = [];
    state.messages = [];
    state.blocked = null;
    state.inputTokens = 0;
    state.pendingDelta = 0;
    state.turnBase = null;
    state.lastThinkChars = 0;
    state.lastTurn = null;
    state.cotChars = 0;
    state.answerChars = 0;
    state.startedAt = null;
    state.startedSource = null;
    state.lastAt = null;

    loadSessions().then(function (all) {
      var saved = all[key];
      if (saved && saved.used) {
        state.used = saved.used;
        state.usedSource = 'memory';
        state.usedAt = saved.usedAt || 0;
        state.turns = saved.turns || [];
        state.startedAt = saved.startedAt || null;
        state.startedSource = saved.startedSource || null;
        state.turnBase = state.used;
        if (!settings.limitOverride && saved.limit) {
          state.limit = saved.limit;
          state.limitSource = saved.limitSource || 'memory';
        }
      }
      render();
    });
  }

  /* =========================================================== 派生 =====*/

  function usedPercent() {
    if (state.used === null) return null;
    if (!state.limit) return null;
    return Math.min(999, (state.used / state.limit) * 100);
  }

  function remaining() {
    if (state.used === null || !state.limit) return null;
    return Math.max(0, state.limit - state.used);
  }

  /** 预计还能聊几轮：用最近 3 轮的平均增量外推 */
  function turnsLeft() {
    var recent = state.turns.slice(-3).map(function (t) { return t.delta; })
      .filter(function (d) { return d > 0; });
    if (recent.length < 2) return null;
    var avg = recent.reduce(function (a, b) { return a + b; }, 0) / recent.length;
    if (avg <= 0) return null;
    var rem = remaining();
    if (rem === null) return null;
    return Math.max(0, Math.floor(rem / avg));
  }

  function avgTurn() {
    var recent = state.turns.slice(-3).map(function (t) { return t.delta; })
      .filter(function (d) { return d > 0; });
    if (!recent.length) return null;
    return Math.round(recent.reduce(function (a, b) { return a + b; }, 0) / recent.length);
  }

  function sessionGrowth() {
    if (!state.turns.length) return null;
    return state.turns.reduce(function (a, t) { return a + t.delta; }, 0);
  }

  function level() {
    var p = usedPercent();
    if (state.blocked) return 'blocked';
    if (p === null) return 'unknown';
    if (p >= 95) return 'critical';
    if (p >= 85) return 'warn';
    if (p >= 60) return 'mid';
    return 'ok';
  }

  var LEVEL_COLOR = {
    unknown: '#8a8a8a',
    ok: '#1d9e75',
    mid: '#378add',
    warn: '#ef9f27',
    critical: '#e24b4a',
    blocked: '#a32d2d'
  };

  /* =========================================================== 渲染 =====*/

  function ringSvg(percent, color, size) {
    size = size || 16;
    var r = size / 2 - 2;
    var c = 2 * Math.PI * r;
    var p = percent === null ? 0 : Math.max(0, Math.min(100, percent));
    var dash = (p / 100) * c;
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '" aria-hidden="true">' +
      '<circle cx="' + (size / 2) + '" cy="' + (size / 2) + '" r="' + r + '" fill="none" stroke="currentColor" stroke-opacity="0.18" stroke-width="2.4"/>' +
      '<circle cx="' + (size / 2) + '" cy="' + (size / 2) + '" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="2.4" stroke-linecap="round" ' +
      'stroke-dasharray="' + dash.toFixed(1) + ' ' + c.toFixed(1) + '" transform="rotate(-90 ' + (size / 2) + ' ' + (size / 2) + ')"/>' +
      '</svg>';
  }

  var renderPending = false;
  function requestRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(function () {
      renderPending = false;
      render();
    });
  }

  var ringCache = { pct: -1, level: '' };

  function render() {
    if (!refs.band) return;
    var p = usedPercent();
    var lv = level();
    var color = LEVEL_COLOR[lv];
    var rem = remaining();
    var tl = turnsLeft();

    var pctRounded = p === null ? -1 : Math.round(p);
    if (pctRounded !== ringCache.pct || lv !== ringCache.level) {
      ringCache.pct = pctRounded;
      ringCache.level = lv;
      refs.bandRing.innerHTML = ringSvg(p, color, 16);
    }

    var pctText = p === null ? '--' : Math.round(p) + '%';
    var usedMark = state.usedSource === 'estimate' ? '~' : '';
    var usedText = state.used === null ? '--' : usedMark + fmt(state.used);

    refs.bandPct.textContent = pctText;
    refs.bandPct.style.color = color;

    var parts = [];
    if (rem !== null) parts.push('剩余 ' + fmt(rem));
    if (tl !== null) parts.push('约 ' + tl + ' 轮');
    var tp = timePercent();
    if (tp !== null && tp >= 60) {
      parts.push('时长 ' + Math.round(elapsedMs() / 3600000) + 'h/72h');
    }
    if (!parts.length) parts.push('等待服务端用量');
    refs.bandSub.textContent = parts.join(' · ');

    refs.band.title = [
      '已用 ' + usedText + ' / 上限 ' + fmt(state.limit),
      '数据来源：' + sourceLabel(state.usedSource),
      '分母来源：' + limitLabel(state.limitSource),
      '模型窗口 ' + fmt(state.windowSize) + '（官方）' +
        (state.serverLimit ? '，服务端下发 ' + fmt(state.serverLimit) : '') +
        (state.blockLine ? '，实测拦截于 ' + fmt(state.blockLine) : ''),
      state.usedSource === 'estimate' ? '当前为估算值，下一轮回复后转为实测' : ''
    ].filter(Boolean).join('\n');

    refs.band.setAttribute('data-level', lv);
    refs.panel.setAttribute('data-level', lv);

    if (!state.expanded) return;

    /* ---- 展开面板 ----*/
    refs.gauge.innerHTML = ringSvg(p, color, 96).replace(/aria-hidden="true"/, 'role="img" aria-label="上下文占用"');
    refs.gaugeValue.textContent = usedText;
    refs.gaugeSub.textContent = '/ ' + fmt(state.limit);

    var pctClamped = p === null ? 0 : Math.max(0, Math.min(100, p));
    refs.barUsed.style.width = pctClamped + '%';
    refs.barUsed.style.background = color;
    refs.barFree.style.width = (100 - pctClamped) + '%';

    refs.gsrc.textContent = '数据来源：' + sourceLabel(state.usedSource);
    refs.mLimit.textContent = fmt(state.limit);
    refs.mLimitHint.textContent = limitLabel(state.limitSource);

    var growth = sessionGrowth();
    refs.mGrowth.textContent = growth === null ? '--' : '+' + fmt(growth);
    refs.mGrowthHint.textContent = state.turns.length ? '共 ' + state.turns.length + ' 轮' : '暂无记录';

    var avg = avgTurn();
    refs.mAvg.textContent = avg === null ? '--' : fmt(avg);
    refs.mAvgHint.textContent = state.turns.length
      ? '近 ' + Math.min(3, state.turns.length) + ' 轮均值'
      : '暂无数据';

    refs.mTurns.textContent = tl === null ? '--' : tl + ' 轮';
    refs.mTurnsHint.textContent = tl === null ? '需至少 2 轮数据' : '按近 3 轮外推';

    renderSparkline();
    renderTime();
    renderCot();
    renderAdvice(lv);
  }

  function sourceLabel(s) {
    return {
      sse: '服务端实测',
      history: '历史接口实测',
      estimate: '本地估算（未校准）',
      memory: '上次已知值'
    }[s] || '未知';
  }

  function limitLabel(s) {
    return {
      default: '经验值（未校准）',
      settings: '服务端下发字段',
      blocked: '被拦截后实测',
      override: '手动指定',
      memory: '记忆值'
    }[s] || s;
  }

  function renderSparkline() {
    var turns = state.turns.slice(-24);
    if (!turns.length) {
      refs.spark.innerHTML = '<span style="font-size:11px;color:var(--muted)">发送一条消息后开始记录</span>';
      refs.sparkHint.textContent = '';
      return;
    }
    var max = Math.max.apply(null, turns.map(function (t) { return t.delta; })) || 1;
    var html = '';
    for (var i = 0; i < turns.length; i++) {
      var h = Math.max(6, Math.round((turns[i].delta / max) * 100));
      var heavy = turns.length >= 3 && turns[i].delta >= max * 0.7;
      html += '<div class="bar' + (heavy ? ' heavy' : '') + '" style="height:' + h + '%" title="第 ' +
        (state.turns.length - turns.length + i + 1) + ' 轮：+' + fmt(turns[i].delta) + '"></div>';
    }
    refs.spark.innerHTML = html;
    var maxIdx = turns.findIndex(function (t) { return t.delta === max; });
    refs.sparkHint.textContent = '峰值 ' + fmt(max) + '（第 ' + (state.turns.length - turns.length + maxIdx + 1) + ' 轮）';
  }

  function renderTime() {
    if (!refs.timeSect) return;

    if (!state.startedAt) {
      refs.timeHint.textContent = '未知';
      refs.timeHint.style.color = '';
      refs.timeFill.style.width = '0%';
      refs.timeMeta.textContent = '未捕获到会话创建时间，发出第一条消息后按当时起算';
      return;
    }

    var elapsed = elapsedMs();
    var pct = (elapsed / TIME_CAP_MS) * 100;
    var color = pct >= 95 ? '#a32d2d' : pct >= 80 ? '#ef9f27' : '#888780';
    var left = TIME_CAP_MS - elapsed;

    refs.timeFill.style.width = Math.min(100, pct) + '%';
    refs.timeFill.style.background = color;
    refs.timeHint.textContent = left > 0 ? '剩 ' + fmtDur(left) : '已超 ' + fmtDur(-left);
    refs.timeHint.style.color = pct >= 80 ? color : '';
    refs.timeMeta.textContent =
      '起点 ' + new Date(state.startedAt).toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
      }) +
      ' · 已 ' + fmtDur(elapsed) +
      (state.startedSource === 'observed' ? '（按首次发言估算，可能晚于真实起点）' : '');
  }

  function renderCot() {
    var total = state.cotChars + state.answerChars;
    if (!total || state.cotChars < 500) {
      refs.cotRow.style.display = 'none';
      return;
    }
    refs.cotRow.style.display = 'flex';
    var pct = Math.round((state.cotChars / total) * 100);
    refs.cotValue.textContent = '~' + pct + '%';
    refs.cotHint.textContent = '本次会话捕获的思考内容占比（按字符推算）';
  }

  function renderAdvice(lv) {
    var tp = timePercent();
    if (tp !== null && tp >= 90) {
      var leftMs = TIME_CAP_MS - elapsedMs();
      refs.advice.textContent = '这个对话已经开了 ' + fmtDur(elapsedMs()) +
        (leftMs > 0 ? '，距 72 小时长对话限制不足 ' + fmtDur(leftMs) : '，已超过 72 小时') +
        '，建议尽快生成交接摘要';
      refs.advice.setAttribute('data-strong', '1');
      refs.digestBtn.style.display = '';
      refs.digestBtn.classList.add('primary');
      return;
    }

    var map = {
      unknown: ['等待第一轮回复后即可获得实测用量', false],
      ok: ['上下文充裕，可以放心展开长对话', false],
      mid: ['已用超过六成，建议在收尾时预先准备交接摘要', false],
      warn: ['接近上限，早期内容可能被服务端悄悄丢弃', true],
      critical: ['下一轮很可能被拦截，建议现在生成交接摘要', true],
      blocked: ['已被上下文长度限制拦截，需要开新对话', true]
    };
    var conf = map[lv] || map.ok;
    refs.advice.textContent = conf[0];
    refs.advice.setAttribute('data-strong', conf[1] ? '1' : '0');
    // 摘要入口常驻，只在临近上限时升为主要按钮
    refs.digestBtn.style.display = '';
    if (conf[1]) refs.digestBtn.classList.add('primary');
    else refs.digestBtn.classList.remove('primary');
  }

  /* =========================================================== 摘要 =====*/

  function lastAssistantText() {
    for (var i = state.messages.length - 1; i >= 0; i--) {
      if (state.messages[i].role !== 'user') return state.messages[i].text || '';
    }
    return '';
  }

  function splitSentences(text) {
    return (text || '')
      .replace(/\r/g, '')
      .split(/(?<=[。！？；\n])/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  var RE_CONF = /(已确认|确认|结论|根因|决定|确定为|实测|验证|已经|已完成|问题在于|原因是)/;
  var RE_TODO = /(下一步|接下来|建议|待办|需要|可以改成|应该|还没|尚未|TODO)/;
  var RE_TODO_LEAD = /^(建议|下一步|接下来|需要|可以|应该|待办|请先|先做)/;
  var RE_CONS = /(必须|不要|禁止|格式|字数|语言|只用|仅限|不超过|限定|先给|再给|务必)/;

  function normKey(s) {
    return (s || '').replace(/[\s，。；、,.;:：！？!?]/g, '').slice(0, 36);
  }

  /** 去掉句子开头的分类标签，避免和段落标题重复 */
  function stripLead(s) {
    return s.replace(/^(已确认|确认|结论|根因|总结|待办|建议|下一步|接下来)\s*[：:，,]\s*/, '');
  }

  function buildDigest() {
    var msgs = state.messages || [];
    if (!msgs.length) return '';

    var users = msgs.filter(function (m) { return m.role === 'user'; });
    var ais = msgs.filter(function (m) { return m.role !== 'user'; });
    if (!users.length) return '';

    var goal = clampText(users[0].text, 140);
    var claimed = {};
    var conclusions = [];
    var todos = [];
    var cons = [];

    // 先扫最近的 AI 回复：以「建议类开头」的句子归为待办，其余命中结论词的归为已确认
    ais.slice(-8).forEach(function (m, msgIdx) {
      var isRecent = msgIdx >= ais.slice(-8).length - 3;
      splitSentences(m.text).forEach(function (raw) {
        var s = raw.trim();
        if (s.length < 8 || s.length > 180) return;
        var key = normKey(s);
        if (!key || claimed[key]) return;

        var looksTodo = RE_TODO_LEAD.test(s) || (RE_TODO.test(s) && !RE_CONF.test(s));
        if (looksTodo) {
          if (!isRecent) return;
          claimed[key] = 1;
          todos.push(clampText(stripLead(s), 120));
        } else if (RE_CONF.test(s)) {
          claimed[key] = 1;
          conclusions.push(clampText(stripLead(s), 120));
        }
      });
    });

    users.forEach(function (m) {
      splitSentences(m.text).forEach(function (raw) {
        var s = raw.trim();
        if (s.length < 6 || s.length > 160) return;
        if (!RE_CONS.test(s)) return;
        var key = normKey(s);
        if (claimed[key]) return;
        claimed[key] = 1;
        cons.push(clampText(s, 100));
      });
    });

    conclusions = conclusions.slice(-5);
    todos = todos.slice(-4);
    cons = cons.slice(-5);

    var lines = [];
    lines.push('【任务】' + goal);
    if (conclusions.length) lines.push('【已确认】' + conclusions.join('；'));
    if (todos.length) lines.push('【待办】' + todos.join('；'));
    if (cons.length) lines.push('【约束】' + cons.join('；'));
    lines.push('');
    lines.push('（以上由本地规则从最近 ' + msgs.length + ' 条消息抽取，未经模型改写，请自行核对后使用）');
    return lines.join('\n');
  }

  function openDigest() {
    var text = buildDigest();
    if (!text) {
      toast('还没有可抽取的对话内容');
      return;
    }
    state.digestText = text;
    refs.digestInput.value = text;
    refs.digestMask.classList.add('open');
    setTimeout(function () { refs.digestInput.focus(); }, 30);
  }

  function copyText(text) {
    return navigator.clipboard.writeText(text).catch(function () {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) { /* ignore */ }
      document.body.removeChild(ta);
    });
  }

  /* =========================================================== 提示 =====*/

  function toast(msg) {
    refs.toast.textContent = msg;
    refs.toast.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () {
      refs.toast.classList.remove('show');
    }, 1800);
  }

  /* ======================================================= 诊断面板 =====*/

  function openDiag() {
    refs.diagMask.classList.add('open');
    refreshDiag();
  }

  function refreshDiag() {
    post('stats');
    var p = usedPercent();

    /* 交叉验证：只用「最近一轮」比较。
       拿会话总 token 去比本次捕获字符是错的——历史正文在服务端，本地根本看不到，
       那个比值必然离谱。单轮对比才有意义：本轮服务端增量 vs 本轮捕获文本折算。 */
    var lt = state.lastTurn;
    var lastText = lastAssistantText();
    var estAns = estimateTokens(lastText);
    var estThink = Math.round((lt ? lt.thinkChars : 0) * 0.55);
    var estTurn = estAns + estThink;
    var ratio = (lt && lt.delta && estTurn) ? lt.delta / estTurn : null;

    // 全量参考值（仅用于观察覆盖率，不参与判定）
    var chars = 0;
    var est = 0;
    state.messages.forEach(function (m) {
      chars += (m.text || '').length;
      est += estimateTokens(m.text || '');
    });

    var verdict = '等待数据';
    var tone = 'neutral';
    var times = ratio === null ? '' : (ratio >= 99 ? '远大于 99' : ratio.toFixed(2));
    if (ratio !== null) {
      if (ratio >= 0.5 && ratio <= 2.5) {
        verdict = '单轮对得上：本轮新增 ' + lt.delta + ' token，捕获正文折算约 ' + estTurn +
          '，比值 ' + times + '。抓取链路正常，开销可解释为系统提示与格式。';
        tone = 'ok';
      } else if (ratio > 2.5) {
        verdict = '本轮新增 ' + lt.delta + ' token，但只折算到约 ' + estTurn + '（比值 ' + times +
          '）。该轮可能含联网搜索、网页抓取或附件内容，这部分 token 未计入正文。';
        tone = 'neutral';
      } else {
        verdict = '本轮新增 ' + lt.delta + ' token，却折算到约 ' + estTurn + '（比值 ' + times +
          '），正文可能重复计入，需排查。';
        tone = 'warn';
      }
    } else if (!lt) {
      verdict = '还没有完整的一轮数据。发送一条消息并等回复结束后再看。';
    }

    refs.diagVerdict.textContent = verdict;
    refs.diagVerdict.setAttribute('data-tone', tone);

    var report = {
      生成时间: new Date().toLocaleString('zh-CN'),
      页面: location.href,
      会话键: state.sessionKey,
      已用token: state.used,
      数据来源: state.usedSource,
      分母: state.limit,
      分母来源: state.limitSource,
      三个上限对照: {
        模型窗口_官方: state.windowSize,
        服务端下发_历史文件上限: state.serverLimit,
        服务端下发_单文件上限: state.serverTokenLimit,
        实测拦截线: state.blockLine
      },
      交叉验证: {
        口径: '最近一轮：服务端增量 vs 本地捕获折算',
        本轮新增token: lt ? lt.delta : null,
        本轮正文字符: lt ? lt.ansChars : null,
        本轮思考字符: lt ? lt.thinkChars : null,
        正文折算token: estAns,
        思考折算token: estThink,
        合计折算token: estTurn,
        比值: ratio === null ? null : Math.round(ratio * 100) / 100
      },
      覆盖率参考: {
        本次会话捕获消息数: state.messages.length,
        捕获字符总数: chars,
        折算token: est,
        会话累计token: state.used,
        比值: (state.used && est) ? Math.round((state.used / est) * 100) / 100 : null,
        说明: '本次会话之外的历史正文在服务端，本地不可见，比值大是正常的'
      },
      占用百分比: p === null ? null : Math.round(p * 10) / 10,
      会话起点: state.startedAt ? new Date(state.startedAt).toLocaleString('zh-CN') : null,
      起点来源: state.startedSource,
      已记录轮次: state.turns.length,
      每轮增量: state.turns.slice(-10).map(function (t) { return t.delta; }),
      已拦截: state.blocked,
      是否允许自动补数: settings.autoCalibrate
    };
    refs.diagOut.value = JSON.stringify(report, null, 2);
  }

  function applyStats(stats) {
    refs.diagStats.textContent = [
      '接管状态：fetch ' + (stats.fetchPatched ? '已接管' : '未接管') +
        '　XHR ' + (stats.xhrPatched ? '已接管' : '未接管') +
        '　框架：' + (stats.inFrame ? '子框架' : '主框架'),
      'fetch 调用：' + (stats.fetchSeen || 0) + '　XHR 调用：' + (stats.xhrSeen || 0),
      'SSE 事件数：' + stats.sseEvents,
      '用量命中：' + stats.usageHits,
      '历史命中：' + stats.historyHits,
      '最近来源：' + (stats.lastUsageSource || '无'),
      '补数回放：' + stats.replays + ' 次（成功 ' + (stats.replayOk || 0) + '）',
      '片段类型：' + JSON.stringify(stats.fragmentTypes),
      '正文 patch 路径：' + (stats.patchPaths && stats.patchPaths.length ? stats.patchPaths.join(' , ') : '无'),
      'patch 形态采样：' + (stats.patchSamples && stats.patchSamples.length ? '\n  ' + stats.patchSamples.join('\n  ') : '无'),
      'settings 空响应：' + (stats.settingsEmpty || 0) + ' 次',
      '会话时间命中：' + (stats.sessionTimes || 0) + ' 条',
      '正文/思考字符：' + stats.answerChars + ' / ' + stats.thinkChars
    ].join('\n');
    state.cotChars = stats.thinkChars || 0;
    state.answerChars = stats.answerChars || 0;
    renderCot();
    if (stats.historyCache) {
      refs.diagStats.textContent += '\nhistory 缓存模式：' + stats.historyCache;
    }
    if (stats.settingsShapes && stats.settingsShapes.length) {
      stats.settingsShapes.forEach(function (sh) {
        refs.diagStats.textContent += '\n—— settings[' + sh.scope + '] 结构 ——\n' +
          sh.keys.slice(0, 26).join('\n');
      });
    }
    if (stats.shapeHistory) {
      refs.diagStats.textContent += '\n—— history 结构 ——\n' + stats.shapeHistory.join('\n');
    }
    if (stats.reqLog && stats.reqLog.length) {
      refs.diagStats.textContent += '\n抓到的接口：\n' + stats.reqLog.slice(-14).join('\n');
    } else {
      refs.diagStats.textContent += '\n抓到的接口：无（发一条消息再看）';
    }
    if (stats.errors && stats.errors.length) {
      refs.diagStats.textContent += '\n错误：\n' + stats.errors.slice(-6).join('\n');
    }
  }

  /* =========================================================== 定位 =====*/

  /* 定位是一个高频动作：流式输出时 DOM 每秒会变上千次。
     这里做三件事把开销压到接近零：
       ① 缓存输入框元素，只有脱离文档时才重新查询
       ② 记住上次的位置，尺寸没变就不写 style（避免写后读的强制重排）
       ③ 所有触发点统一走 rAF 合并 */

  var lastRect = { left: -1, width: -1, bottom: -1 };
  var posCalls = 0;
  var composerMisses = 0;

  function findComposer() {
    if (lastComposer && document.contains(lastComposer) && lastComposer.offsetParent !== null) {
      return lastComposer;
    }
    composerMisses++;

    var boxes = document.querySelectorAll('textarea');
    for (var i = boxes.length - 1; i >= 0; i--) {
      var el = boxes[i];
      var r = el.getBoundingClientRect();
      if (r.width > 120 && r.height > 10 && el.offsetParent !== null) return el;
    }
    var editables = document.querySelectorAll('[contenteditable="true"]');
    for (var j = editables.length - 1; j >= 0; j--) {
      var e2 = editables[j];
      var r2 = e2.getBoundingClientRect();
      if (r2.width > 120 && e2.offsetParent !== null) return e2;
    }
    return null;
  }

  var posPending = false;
  function schedulePosition() {
    if (posPending) return;
    posPending = true;
    requestAnimationFrame(function () {
      posPending = false;
      position();
    });
  }

  function position() {
    if (!host) return;
    var el = findComposer();

    if (!el) {
      if (host.style.display !== 'none') host.style.display = 'none';
      lastRect = { left: -1, width: -1, bottom: -1 };
      return;
    }
    lastComposer = el;

    var r = el.getBoundingClientRect();
    if (r.width < 120 || r.top < 0) {
      if (host.style.display !== 'none') host.style.display = 'none';
      return;
    }

    var left = Math.round(r.left);
    var width = Math.round(r.width);
    var bottom = Math.round(window.innerHeight - r.top + 6);

    // 位置没变就什么都不做——这一步省掉了绝大多数无谓的样式写入
    if (host.style.display !== 'none' &&
        left === lastRect.left && width === lastRect.width && bottom === lastRect.bottom) {
      return;
    }

    lastRect = { left: left, width: width, bottom: bottom };
    posCalls++;
    host.style.display = '';
    host.style.left = left + 'px';
    host.style.width = width + 'px';
    host.style.bottom = bottom + 'px';
  }

  /* =========================================================== 构建 =====*/

  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box}',
    '.hud{',
    '  --bg:#ffffff; --bg2:#f7f7f5; --fg:#1b1b1b; --muted:#8a8a86;',
    '  --line:rgba(0,0,0,.10); --line2:rgba(0,0,0,.06);',
    '  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;',
    '  font-size:12px; color:var(--fg); line-height:1.5;',
    '}',
    '.hud[data-theme="dark"]{',
    '  --bg:#23252a; --bg2:#2b2d33; --fg:#e9e9e6; --muted:#9a9a95;',
    '  --line:rgba(255,255,255,.14); --line2:rgba(255,255,255,.08);',
    '}',
    '.wrap{position:relative;display:flex;flex-direction:column;align-items:stretch;gap:6px;pointer-events:none}',
    '.band{',
    '  pointer-events:auto;display:flex;align-items:center;gap:8px;',
    '  height:28px;padding:0 10px;border-radius:14px;',
    '  background:var(--bg);border:1px solid var(--line);',
    '  cursor:pointer;width:fit-content;max-width:100%;',
    '  transition:border-color .15s ease;user-select:none;',
    '}',
    '.band:hover{border-color:var(--line2)}',
    '.band[data-level="warn"]{border-color:rgba(239,159,39,.45)}',
    '.band[data-level="critical"],.band[data-level="blocked"]{border-color:rgba(226,75,74,.5)}',
    '.band .ring{display:flex;align-items:center;color:var(--muted)}',
    '.band .pct{font-weight:500;font-size:12px;font-variant-numeric:tabular-nums}',
    '.band .sub{color:var(--muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.band .caret{margin-left:auto;color:var(--muted);transition:transform .18s ease;display:flex;padding-left:6px}',
    '.band.open .caret{transform:rotate(180deg)}',
    '.panel{',
    '  pointer-events:auto;display:none;background:var(--bg);border:1px solid var(--line);',
    '  border-radius:14px;padding:14px 16px;max-height:60vh;overflow:auto;',
    '}',
    '.panel.open{display:block}',
    '.top{display:flex;gap:16px;align-items:center}',
    '.gaugewrap{position:relative;width:96px;height:96px;flex:0 0 auto;display:flex;align-items:center;justify-content:center}',
    '.gaugewrap svg{position:absolute;inset:0}',
    '.gaugeText{position:relative;text-align:center}',
    '.gaugeText b{display:block;font-size:19px;font-weight:500;line-height:1.1;font-variant-numeric:tabular-nums}',
    '.gaugeText span{display:block;font-size:10px;color:var(--muted)}',
    '.barwrap{flex:1 1 auto;min-width:0}',
    '.bar{display:flex;height:7px;border-radius:4px;overflow:hidden;background:var(--bg2);margin-bottom:10px}',
    '.bar i{display:block;height:100%;transition:width .3s ease}',
    '.bar .free{background:transparent}',
    '.gsrc{font-size:10px;color:var(--muted);margin:-4px 0 8px}',
    '.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px}',
    '.metric{background:var(--bg2);border-radius:8px;padding:7px 8px;min-width:0}',
    '.metric .k{font-size:10px;color:var(--muted);margin-bottom:2px;white-space:nowrap}',
    '.metric .v{font-size:13px;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.metric .h{font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.sect{margin-top:13px;padding-top:12px;border-top:1px solid var(--line2)}',
    '.sectHead{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:7px}',
    '.sectHead .t{font-size:11px;color:var(--muted)}',
    '.sectHead .x{font-size:10px;color:var(--muted)}',
    '.spark{display:flex;align-items:flex-end;gap:2px;height:40px}',
    '.spark .bar{flex:1 1 0;max-width:22px;border-radius:2px 2px 0 0;background:#b5d4f4;min-height:2px;transition:height .2s ease}',
    '.spark .bar.heavy{background:#ef9f27}',
    '.timeBar{height:5px;border-radius:3px;background:var(--bg2);overflow:hidden;margin:7px 0 5px}',
    '.timeBar i{display:block;height:100%;width:0;background:#888780;transition:width .3s ease}',
    '.timeMeta{font-size:10px;color:var(--muted)}',
    '.cot{display:none;align-items:center;justify-content:space-between;gap:8px;margin-top:16px;font-size:11px;color:var(--muted)}',
    '.cot b{font-weight:500;color:var(--fg)}',
    '.advice{font-size:11px;color:var(--muted);margin-top:12px}',
    '.advice[data-strong="1"]{color:#b06000}',
    '.actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:11px}',
    'button{',
    '  font:inherit;font-size:11px;padding:6px 11px;border-radius:8px;',
    '  border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer;',
    '  transition:background .15s ease;white-space:nowrap;',
    '}',
    'button:hover{background:var(--bg2)}',
    'button.primary{background:#1b1b1b;color:#fff;border-color:#1b1b1b}',
    '.hud[data-theme="dark"] button.primary{background:#e9e9e6;color:#1b1b1b;border-color:#e9e9e6}',
    'button.ghost{color:var(--muted)}',
    '.mask{display:none;position:fixed;inset:0;background:rgba(0,0,0,.32);z-index:2;align-items:center;justify-content:center;pointer-events:auto}',
    '.mask.open{display:flex}',
    '.modal{background:var(--bg);border-radius:14px;padding:16px;width:min(520px,92vw);max-height:78vh;display:flex;flex-direction:column;gap:10px}',
    '.modal h3{margin:0;font-size:14px;font-weight:500}',
    '.modal p{margin:0;font-size:11px;color:var(--muted)}',
    'textarea{width:100%;min-height:190px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;',
    '  font-size:11px;line-height:1.65;padding:9px;border-radius:8px;border:1px solid var(--line);',
    '  background:var(--bg2);color:var(--fg);outline:none}',
    '.modalFoot{display:flex;gap:7px;justify-content:flex-end}',
    '.diag{white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;font-size:10px;color:var(--muted);max-height:180px;overflow:auto}',
    '.diagVerdict{font-size:11px;line-height:1.6;padding:8px 10px;border-radius:8px;background:var(--bg2);color:var(--fg);border-left:2px solid var(--muted)}',
    '.diagVerdict[data-tone="ok"]{border-left-color:#1d9e75}',
    '.diagVerdict[data-tone="warn"]{border-left-color:#ef9f27}',
    '.label{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted)}',
    '.toast{position:absolute;left:50%;top:-32px;transform:translateX(-50%) translateY(4px);',
    '  background:#1b1b1b;color:#fff;padding:5px 12px;border-radius:8px;font-size:11px;',
    '  opacity:0;pointer-events:none;transition:opacity .18s ease,transform .18s ease;white-space:nowrap;z-index:3}',
    '.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}',
    '.hud[data-theme="dark"] .toast{background:#e9e9e6;color:#1b1b1b}'
  ].join('');

  var HTML = [
    '<div class="wrap">',
    '  <div class="band" data-level="unknown" title="">',
    '    <span class="ring"></span>',
    '    <span class="pct">--</span>',
    '    <span class="sub">等待服务端用量</span>',
    '    <span class="caret"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 4 L5 7 L8 4" fill="none" stroke="currentColor" stroke-width="1.3"/></svg></span>',
    '  </div>',
    '  <div class="panel">',
    '    <div class="top">',
    '      <div class="gaugewrap"><div class="gauge"></div><div class="gaugeText"><b>--</b><span>/ --</span></div></div>',
    '      <div class="barwrap">',
    '        <div class="bar"><i class="used" style="width:0%;background:#1d9e75"></i><i class="free" style="width:100%"></i></div>',
    '        <div class="gsrc"></div>',
    '        <div class="metrics">',
    '          <div class="metric"><div class="k">上限</div><div class="v mLimit">--</div><div class="h mLimitHint"></div></div>',
    '          <div class="metric"><div class="k">本会话新增</div><div class="v mGrowth">--</div><div class="h mGrowthHint"></div></div>',
    '          <div class="metric"><div class="k">每轮均值</div><div class="v mAvg">--</div><div class="h mAvgHint"></div></div>',
    '          <div class="metric"><div class="k">预计可聊</div><div class="v mTurns">--</div><div class="h mTurnsHint"></div></div>',
    '        </div>',
    '      </div>',
    '    </div>',
    '    <div class="sect">',
    '      <div class="sectHead"><span class="t">逐轮增量</span><span class="x sparkHint"></span></div>',
    '      <div class="spark"></div>',
    '    </div>',
    '    <div class="sect timeSect">',
    '      <div class="sectHead"><span class="t">对话时长</span><span class="x timeHint"></span></div>',
    '      <div class="timeBar"><i></i></div>',
    '      <div class="timeMeta"></div>',
    '    </div>',
    '    <div class="cot"><span>深度思考占比 <b class="cotValue">--</b></span><span class="cotHint"></span></div>',
    '    <div class="advice" data-strong="0"></div>',
    '    <div class="actions">',
    '      <button class="primary digestBtn">生成交接摘要</button>',
    '      <button class="diagBtn ghost">诊断</button>',
    '    </div>',
    '    <div class="toast"></div>',
    '  </div>',
    '  <div class="mask digestMask">',
    '    <div class="modal">',
    '      <h3>交接摘要</h3>',
    '      <p>本地规则抽取，未经模型改写。可直接编辑后复制到新对话。</p>',
    '      <textarea class="digestInput" spellcheck="false"></textarea>',
    '      <div class="modalFoot">',
    '        <button class="digestClose ghost">取消</button>',
    '        <button class="digestCopyNew">复制并开新对话</button>',
    '        <button class="primary digestCopy">复制</button>',
    '      </div>',
    '    </div>',
    '  </div>',
    '  <div class="mask diagMask">',
    '    <div class="modal">',
    '      <h3>诊断信息</h3>',
    '      <p>用于确认数据链路是否正常。可整段复制反馈。</p>',
    '      <div class="diagVerdict" data-tone="neutral">等待数据</div>',
    '      <div class="diag diagStats">（等待统计…）</div>',
    '      <textarea class="diagOut" spellcheck="false" style="min-height:230px"></textarea>',
    '      <label class="label"><input type="checkbox" class="autoCal"> 允许自动补数（切会话时读取一次历史用量）</label>',
    '      <div class="modalFoot">',
    '        <button class="diagClose ghost">关闭</button>',
    '        <button class="diagCopy">复制诊断</button>',
    '      </div>',
    '    </div>',
    '  </div>',
    '</div>'
  ].join('');

  function build() {
    host = document.createElement('div');
    host.id = 'ds-context-hud-host';
    host.style.cssText = 'position:fixed;z-index:2147483000;pointer-events:none;';
    shadow = host.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    var root = document.createElement('div');
    root.className = 'hud';
    root.innerHTML = HTML;
    shadow.appendChild(root);

    document.body.appendChild(host);

    refs.hud = root;
    refs.band = root.querySelector('.band');
    refs.bandRing = root.querySelector('.ring');
    refs.bandPct = root.querySelector('.pct');
    refs.bandSub = root.querySelector('.sub');
    refs.panel = root.querySelector('.panel');
    refs.gauge = root.querySelector('.gauge');
    refs.gaugeValue = root.querySelector('.gaugeText b');
    refs.gaugeSub = root.querySelector('.gaugeText span');
    refs.barUsed = root.querySelector('.bar .used');
    refs.barFree = root.querySelector('.bar .free');
    refs.mSource = null;
    refs.gsrc = root.querySelector('.gsrc');
    refs.mLimit = root.querySelector('.mLimit');
    refs.mLimitHint = root.querySelector('.mLimitHint');
    refs.mGrowth = root.querySelector('.mGrowth');
    refs.mGrowthHint = root.querySelector('.mGrowthHint');
    refs.mAvg = root.querySelector('.mAvg');
    refs.mAvgHint = root.querySelector('.mAvgHint');
    refs.mTurns = root.querySelector('.mTurns');
    refs.mTurnsHint = root.querySelector('.mTurnsHint');
    refs.spark = root.querySelector('.spark');
    refs.sparkHint = root.querySelector('.sparkHint');
    refs.timeSect = root.querySelector('.timeSect');
    refs.timeHint = root.querySelector('.timeHint');
    refs.timeFill = root.querySelector('.timeBar i');
    refs.timeMeta = root.querySelector('.timeMeta');
    refs.cotRow = root.querySelector('.cot');
    refs.cotValue = root.querySelector('.cotValue');
    refs.cotHint = root.querySelector('.cotHint');
    refs.advice = root.querySelector('.advice');
    refs.digestBtn = root.querySelector('.digestBtn');
    refs.toast = root.querySelector('.toast');
    refs.digestMask = root.querySelector('.digestMask');
    refs.digestInput = root.querySelector('.digestInput');
    refs.diagMask = root.querySelector('.diagMask');
    refs.diagStats = root.querySelector('.diagStats');
    refs.diagVerdict = root.querySelector('.diagVerdict');
    refs.diagOut = root.querySelector('.diagOut');
    refs.autoCal = root.querySelector('.autoCal');

    // mTurns 已是独立指标卡，无需别名

    bind();
    updateTheme();
    render();

    // 点击面板外部收起
    document.addEventListener('mousedown', function (e) {
      if (!state.expanded) return;
      var path = e.composedPath ? e.composedPath() : [];
      if (path.indexOf(host) === -1) {
        state.expanded = false;
        refs.panel.classList.remove('open');
        refs.band.classList.remove('open');
      }
    }, true);
  }

  function updateTheme() {
    if (!refs.hud) return;
    var bg = '';
    try { bg = getComputedStyle(document.body).backgroundColor; } catch (e) { /* ignore */ }
    var m = /(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(bg || '');
    var dark = false;
    if (m) {
      var lum = 0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3];
      dark = lum < 128;
    }
    refs.hud.setAttribute('data-theme', dark ? 'dark' : 'light');
  }

  function bind() {
    refs.band.addEventListener('click', function () {
      state.expanded = !state.expanded;
      refs.panel.classList.toggle('open', state.expanded);
      refs.band.classList.toggle('open', state.expanded);
      render();
    });

    refs.digestBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openDigest();
    });

    refs.digestMask.addEventListener('click', function (e) {
      if (e.target === refs.digestMask) refs.digestMask.classList.remove('open');
    });
    shadow.querySelector('.digestClose').addEventListener('click', function () {
      refs.digestMask.classList.remove('open');
    });
    shadow.querySelector('.digestCopy').addEventListener('click', function () {
      copyText(refs.digestInput.value).then(function () {
        toast('已复制');
      });
    });
    shadow.querySelector('.digestCopyNew').addEventListener('click', function () {
      copyText(refs.digestInput.value).then(function () {
        refs.digestMask.classList.remove('open');
        toast('已复制，正在打开新对话');
        setTimeout(function () { location.href = 'https://chat.deepseek.com/'; }, 500);
      });
    });

    shadow.querySelector('.diagBtn').addEventListener('click', function (e) {
      e.stopPropagation();
      openDiag();
    });
    shadow.querySelector('.diagClose').addEventListener('click', function () {
      refs.diagMask.classList.remove('open');
    });
    refs.diagMask.addEventListener('click', function (e) {
      if (e.target === refs.diagMask) refs.diagMask.classList.remove('open');
    });
    shadow.querySelector('.diagCopy').addEventListener('click', function () {
      copyText(refs.diagOut.value + '\n\n' + refs.diagStats.textContent).then(function () {
        toast('诊断信息已复制');
      });
    });
    refs.autoCal.addEventListener('change', function () {
      settings.autoCalibrate = refs.autoCal.checked;
      saveSettings();
      toast(settings.autoCalibrate ? '已开启自动补数' : '已关闭自动补数');
    });
  }

  /* =========================================================== 事件 =====*/

  function onMessage(ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d[TAG] !== 1) return;

    if (d.k === 'ready' || d.k === 'navigate') {
      if (d.sessionKey) switchSession(d.sessionKey);
      schedulePosition();
      return;
    }

    if (d.k === 'usage') {
      var prev = state.used;
      state.used = d.value;
      state.usedSource = d.source || 'sse';
      state.usedAt = Date.now();
      if (d.source === 'sse') {
        // 以「上轮结束时的值」为基线算增量，而不是逐次相减——
        // 否则同一条回复的多次上报会被反复累加，柱状图会虚高
        if (state.turnBase === null) state.turnBase = prev === null ? 0 : prev;
        if (d.value > state.turnBase) {
          state.pendingDelta = d.value - state.turnBase;
          scheduleTurnCommit();
        }
      } else {
        // 历史/估算值只作基线，不算增量
        state.turnBase = d.value;
      }
      state.blocked = null;
      debouncedPersist();
      requestRender();
      return;
    }

    if (d.k === 'limit') {
      if (d.historyLimit) state.serverLimit = d.historyLimit;
      if (d.tokenLimit) state.serverTokenLimit = d.tokenLimit;
      if (d.thinkingLimit) state.thinkingLimit = d.thinkingLimit;
      if (settings.limitOverride > 0 || state.limitSource === 'blocked') return;
      var candidates = [];
      // 深度思考模式有独立上限，开启时以它为准
      if (state.thinking && state.thinkingLimit) candidates.push(state.thinkingLimit);
      if (d.historyLimit) candidates.push(d.historyLimit);
      if (d.tokenLimit) candidates.push(d.tokenLimit);
      // 只接受量级合理（>50 万）的值，避免把单文件上限误当上下文窗口
      // 注：settings 里的 token_limit 属于 file_feature，是「单个文件/粘贴」的上限，
      // 不是上下文窗口。只有量级接近百万的值才可能是上下文上限。
      var usable = candidates.filter(function (v) { return v >= 800000; });
      if (usable.length) {
        var next = Math.min.apply(null, usable);
        var changed = next !== state.limit;
        state.limit = next;
        state.limitSource = 'settings';
        if (changed) persist();
        requestRender();
      }
      return;
    }

    if (d.k === 'blocked') {
      state.blocked = d.reason;
      // 记录实测拦截线：这是最可靠的证据，但拦截时这一条并没发出去，
      // 所以 real ceiling ≥ used，只在没有更可信分母时才用它当分母。
      state.blockLine = state.used;
      if (state.limitSource === 'default' && state.used > 0) {
        state.limit = state.used;
        state.limitSource = 'blocked';
      }
      persist();
      requestRender();
      return;
    }

    if (d.k === 'thinking') {
      if (state.thinking !== d.enabled) {
        state.thinking = d.enabled;
        if (state.thinking && state.thinkingLimit && state.limitSource !== 'blocked') {
          state.limit = state.thinkingLimit;
          state.limitSource = 'settings';
          persist();
          requestRender();
        }
      }
      return;
    }

    if (d.k === 'session-time') {
      // 会话列表给的创建时间是权威来源，优先于「首次发言」的观测值
      if (d.id && d.id === state.sessionKey && d.startedAt) {
        if (!state.startedAt || d.startedAt < state.startedAt || state.startedSource !== 'history') {
          state.startedAt = d.startedAt;
          state.startedSource = 'history';
          if (d.updatedAt) state.lastAt = d.updatedAt;
          persist();
          requestRender();
        }
      }
      return;
    }

    if (d.k === 'session-meta') {
      // 历史接口给的时间更可信；若已有观测值但历史更早，以历史为准
      if (!state.startedAt || d.startedAt < state.startedAt || state.startedSource !== 'history') {
        state.startedAt = d.startedAt;
        state.startedSource = 'history';
        state.lastAt = d.lastAt || null;
        persist();
        requestRender();
      }
      return;
    }

    if (d.k === 'user') {
      if (!state.startedAt) {
        state.startedAt = Date.now();
        state.startedSource = 'observed';
      }
      state.lastAt = Date.now();
      state.messages.push({ role: 'user', text: d.text });
      if (state.messages.length > 400) state.messages = state.messages.slice(-400);
      return;
    }

    if (d.k === 'assistant') {
      if (d.text) {
        state.messages.push({ role: 'assistant', text: d.text });
        if (state.messages.length > 400) state.messages = state.messages.slice(-400);
      }
      if (d.think) { state.cotChars += d.think.length; state.lastThinkChars += d.think.length; }
      if (d.text) state.answerChars += d.text.length;
      renderCot();
      return;
    }

    if (d.k === 'history-messages') {
      var msgs = d.messages || [];
      if (msgs.length) {
        var known = {};
        state.messages.forEach(function (m) { known[m.role + '|' + m.text.slice(0, 60)] = 1; });
        msgs.forEach(function (m) {
          var key = m.role + '|' + m.text.slice(0, 60);
          if (!known[key]) {
            known[key] = 1;
            state.messages.push({ role: m.role, text: m.text });
          }
        });
        if (state.messages.length > 400) state.messages = state.messages.slice(-400);
      }
      return;
    }

    if (d.k === 'stats' && d.stats) {
      applyStats(d.stats);
    }

    if (d.k === 'fatal') {
      state.fatal = d.message;
      refs.diagStats.textContent = '初始化异常：' + d.message;
    }
  }

  /* =========================================================== 启动 =====*/

  function start() {
    build();
    loadSettings();
    switchSession((/\/chat\/s\/([A-Za-z0-9_-]+)/.exec(location.pathname) || [])[1] || 'new');

    window.addEventListener('message', onMessage);

    window.addEventListener('resize', schedulePosition, { passive: true });
    window.addEventListener('scroll', schedulePosition, { passive: true, capture: true });

    /* 流式输出时 DOM 每秒会变动上千次。
       这里只在「输入框丢了」时才重新定位，且最多每 300ms 检查一次；
       尺寸变化由 ResizeObserver 负责，滚动由 scroll 事件负责。 */
    var lastDomCheck = 0;
    var mo = new MutationObserver(function () {
      var now = performance.now();
      if (now - lastDomCheck < 300) return;
      lastDomCheck = now;
      if (!lastComposer || !document.contains(lastComposer)) schedulePosition();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });

    if (window.ResizeObserver) {
      try {
        new ResizeObserver(function () { schedulePosition(); }).observe(document.body);
      } catch (e) { /* ignore */ }
    }

    // 主题与位置的低频兜底：每 20 秒一次，而不是每 2 秒
    setInterval(function () {
      if (document.hidden) return;
      updateTheme();
      schedulePosition();
    }, 20000);

    // 时长每秒在走，展开时定期刷新，避免长时间挂着数字不动
    setInterval(function () {
      if (state.expanded) renderTime();
    }, 30000);

    schedulePosition();
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
