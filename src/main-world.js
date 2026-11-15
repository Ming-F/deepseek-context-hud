/* ============================================================================
 * DeepSeek 上下文仪表 · 页面上下文桥接层
 * ----------------------------------------------------------------------------
 * 运行环境：world = MAIN（与 DeepSeek 页面同一 JS 上下文）
 * 可用 API：window.*  ——  不可用 chrome.*
 * 职责：
 *   1. 被动 tap fetch / XHR，读取**已经收到**的响应，提取真实 token 用量
 *   2. 从 SSE 流中解析 accumulated_token_usage（权威真值）
 *   3. 从 settings 接口读取真实上下文分母
 *   4. 从 history_messages 读取会话累计用量（冷启动补数）
 *   5. 通过 window.postMessage 单向投递给 content 层
 *
 * 底线：不修改请求、不伪造请求、不自动发送任何消息。
 *      唯一的额外请求是「历史补数」，需用户开启，且只回放页面自己发过的请求。
 * ==========================================================================*/
(function () {
  'use strict';

  if (window.__dsHudHooked) return;
  window.__dsHudHooked = true;

  /* 顶层兜底：任何初始化异常都要能报出来，否则表现为"统计有回、抓取为 0" */

  var TAG = '__dsHud';
  var nativeFetch = window.fetch;
  var nativeXHR = window.XMLHttpRequest;

  var config = {
    autoCalibrate: true   // 是否允许历史补数（回放一次自己的请求以拿真实值）
  };

  var stats = {
    patchPaths: [],
    settingsEmpty: 0,
    fetchPatched: false,
    xhrPatched: false,
    inFrame: (function () { try { return window.top !== window; } catch (e) { return true; } })(),
    fetchSeen: 0,
    xhrSeen: 0,
    reqLog: [],
    sseEvents: 0,
    usageHits: 0,
    historyHits: 0,
    lastUsageSource: null,
    fragmentTypes: {},
    answerChars: 0,
    thinkChars: 0,
    replays: 0,
    errors: []
  };

  var lastHistoryRequest = null;
  var replayedSessions = {};

  /* ---------------------------------------------------------------- 通信 ---*/

  function post(payload) {
    payload[TAG] = 1;
    try {
      window.postMessage(payload, location.origin);
    } catch (e) {
      try { window.postMessage(payload, '*'); } catch (e2) { /* ignore */ }
    }
  }

  /** 记录请求路径（只存 method + path，不存 body / query），用于排查接口变更 */
  function logReq(method, url) {
    try {
      var path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
      if (path.indexOf('/api/') === -1 && path.indexOf('/chat/') === -1) return;
      var entry = method + ' ' + path;
      if (stats.reqLog.indexOf(entry) !== -1) return;
      stats.reqLog.push(entry);
      if (stats.reqLog.length > 40) stats.reqLog.shift();
    } catch (e) { /* ignore */ }
  }

  function noteError(where, e) {
    if (stats.errors.length > 40) stats.errors.shift();
    stats.errors.push(where + ': ' + (e && e.message ? e.message : String(e)));
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d[TAG] !== 1 || d.k !== 'cmd') return;
    if (d.cmd === 'config') {
      config.autoCalibrate = !!d.autoCalibrate;
    }
    if (d.cmd === 'stats') {
      post({ k: 'stats', stats: JSON.parse(JSON.stringify(stats)) });
    }
  });

  /* ------------------------------------------------------------ 工具函数 ---*/

  function urlOf(input) {
    try {
      if (typeof input === 'string') return input;
      if (input && typeof input.url === 'string') return input.url;
    } catch (e) { /* ignore */ }
    return '';
  }

  /** 在任意深度的 JSON 中查找某个数值字段，返回全部命中（后面取最大/最后一个） */
  function findNumbersDeep(root, wanted, out, depth) {
    out = out || [];
    depth = depth || 0;
    if (!root || typeof root !== 'object' || depth > 10) return out;
    if (Array.isArray(root)) {
      for (var i = 0; i < root.length; i++) findNumbersDeep(root[i], wanted, out, depth + 1);
      return out;
    }
    for (var k in root) {
      if (!Object.prototype.hasOwnProperty.call(root, k)) continue;
      var v = root[k];
      if (k === wanted && (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v)))) {
        out.push(Number(v));
      } else if (v && typeof v === 'object') {
        findNumbersDeep(v, wanted, out, depth + 1);
      }
    }
    return out;
  }

  /** 在任意深度收集同时具备 role 与 content 的对象，用于还原对话文本 */
  function findMessagesDeep(root, out, depth) {
    out = out || [];
    depth = depth || 0;
    if (!root || typeof root !== 'object' || depth > 12) return out;
    if (Array.isArray(root)) {
      for (var i = 0; i < root.length; i++) findMessagesDeep(root[i], out, depth + 1);
      return out;
    }
    if (typeof root.role === 'string') {
      var text = '';
      if (typeof root.content === 'string') {
        text = root.content;
      } else if (Array.isArray(root.content)) {
        for (var j = 0; j < root.content.length; j++) {
          var part = root.content[j];
          if (part && typeof part.text === 'string') text += part.text;
        }
      } else if (Array.isArray(root.fragments)) {
        // 新版把正文拆成 fragments 存放，思考片段要排除
        for (var k2 = 0; k2 < root.fragments.length; k2++) {
          var fr = root.fragments[k2];
          if (!fr || typeof fr.content !== 'string') continue;
          if (fr.type === 'THINK') continue;
          text += fr.content;
        }
      }
      var role = String(root.role).toLowerCase();
      if (text) out.push({ role: role, text: text });
    }
    for (var k in root) {
      if (!Object.prototype.hasOwnProperty.call(root, k)) continue;
      if (root[k] && typeof root[k] === 'object') findMessagesDeep(root[k], out, depth + 1);
    }
    return out;
  }

  function headersToObject(h) {
    var o = {};
    try {
      if (!h) return o;
      if (typeof h.forEach === 'function' && !Array.isArray(h)) {
        h.forEach(function (v, k) { o[k] = v; });
      } else if (Array.isArray(h)) {
        for (var i = 0; i < h.length; i++) o[h[i][0]] = h[i][1];
      } else {
        for (var k in h) o[k] = h[k];
      }
    } catch (e) { noteError('headers', e); }
    return o;
  }

  /** 在任意深度收集指定字段的全部命中 */
  function findByKeyDeep(root, wanted, out, depth) {
    out = out || [];
    depth = depth || 0;
    if (!root || typeof root !== 'object' || depth > 10) return out;
    if (Array.isArray(root)) {
      for (var i = 0; i < root.length; i++) findByKeyDeep(root[i], wanted, out, depth + 1);
      return out;
    }
    for (var k in root) {
      if (!Object.prototype.hasOwnProperty.call(root, k)) continue;
      var v = root[k];
      if (k === wanted) out.push(v);
      else if (v && typeof v === 'object') findByKeyDeep(v, wanted, out, depth + 1);
    }
    return out;
  }

  var TIME_KEYS = {
    created_at: 1, inserted_at: 1, create_time: 1, created_time: 1,
    updated_at: 1, mtime: 1, created: 1
  };

  /** 时间戳归一化为毫秒；兼容秒/毫秒/ISO 字符串 */
  function readTime(v) {
    if (typeof v === 'number') {
      if (!isFinite(v) || v <= 0) return null;
      return v < 100000000000 ? Math.round(v * 1000) : Math.round(v);
    }
    if (typeof v === 'string') {
      var n = Number(v);
      if (isFinite(n) && n > 0 && n < 100000000000000) {
        return n < 100000000000 ? Math.round(n * 1000) : Math.round(n);
      }
      var t = Date.parse(v);
      return isFinite(t) ? t : null;
    }
    return null;
  }

  function collectTimes(root, out, depth) {
    out = out || [];
    depth = depth || 0;
    if (!root || typeof root !== 'object' || depth > 8) return out;
    if (Array.isArray(root)) {
      for (var i = 0; i < root.length; i++) collectTimes(root[i], out, depth + 1);
      return out;
    }
    for (var k in root) {
      if (!Object.prototype.hasOwnProperty.call(root, k)) continue;
      var v = root[k];
      if (TIME_KEYS[k]) {
        var t = readTime(v);
        if (t) out.push({ key: k, at: t });
      } else if (v && typeof v === 'object') {
        collectTimes(v, out, depth + 1);
      }
    }
    return out;
  }

  /* --------------------------------------------------------- SSE 流解析 ---*/

  function createCompletionParser() {
    var fragTypes = [];
    var answer = '';
    var think = '';
    var local = { usage: 0, blocked: null };
    var lastPostAt = 0;
    var posted = 0;

    /** 生成过程中服务端可能连续上报增量，对 postMessage 做节流，避免每 token 一条消息 */
    function emitUsage(value, force) {
      var now = Date.now();
      if (!force && now - lastPostAt < 150) return;
      if (value <= posted) return;
      posted = value;
      lastPostAt = now;
      stats.usageHits++;
      stats.lastUsageSource = 'sse';
      post({ k: 'usage', value: value, source: 'sse' });
    }

    function flushText() {
      if (answer || think) {
        stats.answerChars += answer.length;
        stats.thinkChars += think.length;
        post({
          k: 'assistant',
          text: answer,
          think: think
        });
      }
      answer = '';
      think = '';
    }

    function handlePatch(p) {
      if (!p || typeof p !== 'object') return;

      // 记录正文类 patch 的真实结构，便于在接口变化时快速定位
      if (typeof p.p === 'string' && p.p.indexOf('content') !== -1) {
        var pathKey = p.p.replace(/\d+/g, 'N');
        if (stats.patchPaths.indexOf(pathKey) === -1 && stats.patchPaths.length < 12) {
          stats.patchPaths.push(pathKey);
        }
        stats.patchSamples = stats.patchSamples || [];
        if (stats.patchSamples.length < 12) {
          var sample = pathKey + ' | o=' + (p.o || '-') + ' | v=' + (typeof p.v) +
            (typeof p.v === 'string' ? '(' + p.v.length + ')' : '') +
            (p.v && typeof p.v === 'object' && !Array.isArray(p.v) ? '{' + Object.keys(p.v).join(',') + '}' : '');
          if (stats.patchSamples.indexOf(sample) === -1) stats.patchSamples.push(sample);
        }
      }

      // ① 用量：直接字段
      if (p.p === 'accumulated_token_usage' && p.v !== undefined) {
        var n = Number(p.v);
        if (isFinite(n) && n > local.usage) {
          local.usage = n;
          emitUsage(n, false);
        }
        return;
      }

      // ①b 整条 response 快照：部分场景只在末尾下发完整 fragments
      if (p.p === 'response' && p.v && typeof p.v === 'object' && Array.isArray(p.v.fragments)) {
        var fAns = '';
        var fThink = '';
        for (var sfi = 0; sfi < p.v.fragments.length; sfi++) {
          var sfr = p.v.fragments[sfi];
          if (!sfr || typeof sfr.content !== 'string') continue;
          if (sfr.type === 'THINK') fThink += sfr.content;
          else fAns += sfr.content;
        }
        if (fAns.length > answer.length) answer = fAns;
        if (fThink.length > think.length) think = fThink;
        return;
      }

      // ② 用量：BATCH 包裹（response -> [ {p,v}, ... ]）
      if (p.p === 'response' && Array.isArray(p.v)) {
        for (var i = 0; i < p.v.length; i++) handlePatch(p.v[i]);
        return;
      }

      // ③ 片段类型登记（用于区分「深度思考」与「正文」）
      if (p.p === 'response/fragments' && p.o === 'APPEND' && Array.isArray(p.v)) {
        for (var j = 0; j < p.v.length; j++) {
          var fr = p.v[j] || {};
          var t = fr.type || 'UNKNOWN';
          fragTypes.push(t);
          stats.fragmentTypes[t] = (stats.fragmentTypes[t] || 0) + 1;
          // 片段对象自带正文时直接取，这种情况很常见
          if (typeof fr.content === 'string' && fr.content) {
            if (t === 'THINK') think += fr.content;
            else answer += fr.content;
          }
        }
        return;
      }

      // ④ 片段正文：只要路径以 /content 结尾且值是字符串就接收，
      //    不再限定操作符（APPEND / SET / BATCH 都见过）
      if (typeof p.p === 'string' && /(^|\/)content$/.test(p.p)) {
        var rawVal = p.v;
        if (Array.isArray(rawVal) && typeof rawVal[0] === 'string') rawVal = rawVal.join('');
        else if (rawVal && typeof rawVal === 'object' && typeof rawVal.content === 'string') rawVal = rawVal.content;
        if (typeof rawVal !== 'string') return;
        var op = (p.o || 'APPEND').toUpperCase();
        var m = /fragments\/(-?\d+)\/content$/.exec(p.p);
        var isThink = false;
        if (m) {
          var idx = parseInt(m[1], 10);
          if (idx < 0) idx = fragTypes.length + idx;
          isThink = (fragTypes[idx] === 'THINK');
        }
        if (isThink) {
          think = (op === 'SET') ? rawVal : think + rawVal;
        } else {
          answer = (op === 'SET') ? rawVal : answer + rawVal;
        }
        return;
      }

      // ④b 片段类型：APPEND 之外的写法也要登记
      if (typeof p.p === 'string' && /(^|\/)fragments$/.test(p.p) && Array.isArray(p.v)) {
        for (var fi = 0; fi < p.v.length; fi++) {
          var fobj = p.v[fi] || {};
          var ft = fobj.type || 'UNKNOWN';
          fragTypes.push(ft);
          stats.fragmentTypes[ft] = (stats.fragmentTypes[ft] || 0) + 1;
          if (typeof fobj.content === 'string' && fobj.content) {
            if (ft === 'THINK') think += fobj.content;
            else answer += fobj.content;
          }
        }
        return;
      }

      // ⑤ 中断原因
      if (p.p === 'finish_reason' && typeof p.v === 'string' && p.v !== 'stop') {
        if (/context_length/i.test(p.v)) {
          local.blocked = 'context_length_exceeded';
        }
      }
      if (p.p === 'quasi_status' && /BLOCK|FILTER|ERROR/.test(String(p.v))) {
        local.blocked = String(p.v);
      }
    }

    function handleEventObject(ev, hasUsage) {
      if (!ev || typeof ev !== 'object') return;

      // 通用深扫：SSE 有多种帧形态（初始化 envelope / BATCH / 直接 patch），
      // 但只有原始行里出现该字段时才扫，避免每个事件都做一次全对象遍历。
      if (hasUsage) {
        var hits = findNumbersDeep(ev, 'accumulated_token_usage');
        if (hits.length) {
          var best = Math.max.apply(null, hits);
          if (best > local.usage) {
            local.usage = best;
            emitUsage(best, false);
          }
        }
      }

      if (Array.isArray(ev.v)) {
        for (var i = 0; i < ev.v.length; i++) handlePatch(ev.v[i]);
      }
      handlePatch(ev);
      if (ev.finish_reason && /context_length/i.test(String(ev.finish_reason))) {
        local.blocked = 'context_length_exceeded';
      }
    }

    var buffer = '';

    function processLine(rawLine) {
      var line = rawLine.trim();
      if (!line || line.charAt(0) === ':') return;
      if (line.indexOf('data:') === 0) line = line.slice(5).trim();
      if (!line || line === '[DONE]') return;
      if (line.charAt(0) !== '{' && line.charAt(0) !== '[') return;
      // 预过滤：正文增量之外的帧（心跳、状态、无关 patch）不解 JSON。
      // 长回复时这一步能省掉绝大部分解析开销。
      var hasUsage = line.indexOf('accumulated_token_usage') !== -1;
      var hasFrag = line.indexOf('fragments') !== -1;
      var hasStatus = line.indexOf('finish_reason') !== -1 || line.indexOf('quasi_status') !== -1;
      if (!hasUsage && !hasFrag && !hasStatus) return;

      stats.sseEvents++;
      try {
        handleEventObject(JSON.parse(line), hasUsage);
      } catch (e) {
        // 跨 chunk 截断的 JSON，交给下面的尾部正则兜底
      }
    }

    return {
      feed: function (text) {
        // 必须跨 chunk 维护缓冲：SSE 帧经常被切成任意长度，逐块切行会丢失半行
        buffer += text;
        var idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          processLine(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 1);
        }
        // 数字可能正好落在未闭合的尾部，对缓冲尾部再做一次正则扫描
        scanRaw(buffer.length > 512 ? buffer.slice(-512) : buffer, local, emitUsage);
      },
      finish: function () {
        if (buffer.trim()) processLine(buffer);
        buffer = '';
        flushText();
        if (local.usage > 0) emitUsage(local.usage, true);
        if (local.blocked) post({ k: 'blocked', reason: local.blocked });
      },
      get usage() { return local.usage; }
    };
  }

  /** 兜底：直接正则扫原始字节，防止 JSON 被切开时漏掉用量 */
  var RE_USAGE_DIRECT = /"accumulated_token_usage"\s*:\s*(\d+)/g;
  var RE_USAGE_PATCH = /"p"\s*:\s*"accumulated_token_usage"\s*,\s*"v"\s*:\s*(\d+)/g;

  function scanRaw(text, local, emit) {
    var best = 0;
    var m;
    RE_USAGE_DIRECT.lastIndex = 0;
    while ((m = RE_USAGE_DIRECT.exec(text))) {
      var v1 = Number(m[1]);
      if (v1 > best) best = v1;
    }
    RE_USAGE_PATCH.lastIndex = 0;
    while ((m = RE_USAGE_PATCH.exec(text))) {
      var v2 = Number(m[1]);
      if (v2 > best) best = v2;
    }
    if (best > local.usage) {
      local.usage = best;
      if (emit) emit(best, false);
    }
  }

  /* ------------------------------------------------------ 响应体读取器 ---*/

  function pumpStream(res, onChunk) {
    if (!res.body || typeof res.body.getReader !== 'function') return Promise.resolve();
    var reader = res.body.getReader();
    var decoder = new TextDecoder('utf-8');
    return (function loop() {
      return reader.read().then(function (r) {
        if (r.done) {
          var rest = decoder.decode();
          if (rest) onChunk(rest);
          return;
        }
        onChunk(decoder.decode(r.value, { stream: true }));
        return loop();
      });
    })().catch(function (e) { noteError('stream', e); });
  }

  function readJson(res) {
    return res.text().then(function (t) {
      try { return JSON.parse(t); } catch (e) { return null; }
    });
  }

  /* ------------------------------------------------------------ 请求拦截 ---*/

  function handleCompletionResponse(res) {
    var parser = createCompletionParser();
    return pumpStream(res, function (chunk) { parser.feed(chunk); })
      .then(function () { parser.finish(); });
  }

  /** 从会话列表 / 历史响应里抽出 { id, createdAt, updatedAt } */
  function collectSessionTimes(root, out, depth) {
    out = out || [];
    depth = depth || 0;
    if (!root || typeof root !== 'object' || depth > 10) return out;
    if (Array.isArray(root)) {
      for (var i = 0; i < root.length; i++) collectSessionTimes(root[i], out, depth + 1);
      return out;
    }
    var id = root.id || root.chat_session_id || root.session_id;
    if (typeof id === 'string' && id.length >= 8) {
      var created = readTime(root.created_at || root.inserted_at || root.create_time || root.created_time);
      var updated = readTime(root.updated_at || root.update_time || root.mtime);
      if (created || updated) out.push({ id: id, createdAt: created, updatedAt: updated });
    }
    for (var k in root) {
      if (!Object.prototype.hasOwnProperty.call(root, k)) continue;
      if (root[k] && typeof root[k] === 'object') collectSessionTimes(root[k], out, depth + 1);
    }
    return out;
  }

  function handleSessionListJson(json) {
    if (!json) return;
    var list = collectSessionTimes(json, []);
    var seen = {};
    var sent = 0;
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (seen[it.id]) continue;
      seen[it.id] = 1;
      var now = Date.now();
      if (!it.createdAt || it.createdAt < 1600000000000 || it.createdAt > now + 86400000) continue;
      post({ k: 'session-time', id: it.id, startedAt: it.createdAt, updatedAt: it.updatedAt || null });
      if (++sent >= 30) break;
    }
    stats.sessionTimes = (stats.sessionTimes || 0) + sent;
  }

  /** 只输出「键名(类型)」的树，用于排查字段改名；不含任何值 */
  function shapeOf(root, prefix, out, depth) {
    out = out || [];
    depth = depth || 0;
    if (!root || typeof root !== 'object' || depth > 4 || out.length > 46) return out;
    if (Array.isArray(root)) {
      if (root.length) shapeOf(root[0], prefix + '[]' + '.', out, depth + 1);
      return out;
    }
    for (var k in root) {
      if (!Object.prototype.hasOwnProperty.call(root, k)) continue;
      if (out.length > 46) break;
      var v = root[k];
      var t = v === null ? 'null' : (Array.isArray(v) ? 'array' : typeof v);
      out.push(prefix + k + ' : ' + t);
      if (v && typeof v === 'object') shapeOf(v, prefix + k + '.', out, depth + 1);
    }
    return out;
  }

  function handleSettingsJson(json, url) {
    if (!json) return;
    var scope = 'none';
    try {
      var ms = /[?&]scope=([a-z]+)/.exec(String(url || ''));
      if (ms) scope = ms[1];
    } catch (e) { /* ignore */ }
    var model = findNumbersDeep(json, 'token_limit');
    var thinking = findNumbersDeep(json, 'token_limit_with_thinking');
    var hist = findNumbersDeep(json, 'normal_history_and_file_token_limit');
    var maxModel = model.length ? Math.max.apply(null, model) : 0;
    var maxThinking = thinking.length ? Math.max.apply(null, thinking) : 0;
    var maxHist = hist.length ? Math.max.apply(null, hist) : 0;
    if (maxModel || maxHist || maxThinking) {
      post({
        k: 'limit',
        tokenLimit: maxModel,
        thinkingLimit: maxThinking,
        historyLimit: maxHist,
        source: 'settings'
      });
    } else {
      stats.settingsEmpty = (stats.settingsEmpty || 0) + 1;
      stats.settingsShapes = stats.settingsShapes || [];
      var hasScope = false;
      for (var si = 0; si < stats.settingsShapes.length; si++) {
        if (stats.settingsShapes[si].scope === scope) hasScope = true;
      }
      if (!hasScope && stats.settingsShapes.length < 4) {
        stats.settingsShapes.push({ scope: scope, keys: shapeOf(json, '', [], 0) });
      }
    }
  }

  function handleSettingsResponse(res, url) {
    return readJson(res).then(function (json) { handleSettingsJson(json, url); });
  }

  function handleHistoryJson(json, reqInfo) {
    (function () {
      if (!json) return;
      var vals = findNumbersDeep(json, 'accumulated_token_usage');
      var cacheControl = null;
      try {
        var biz = json && json.data && json.data.biz_data;
        cacheControl = (biz && biz.cache_control) || (json.data && json.data.cache_control) || null;
      } catch (e) { /* ignore */ }
      var messages = findMessagesDeep(json);
      stats.historyCache = cacheControl || stats.historyCache || 'none';
      if (!messages.length && !stats.shapeHistory) {
        stats.shapeHistory = shapeOf(json, '', [], 0);
      }

      if (vals.length) {
        stats.historyHits++;
        stats.lastUsageSource = 'history';
        post({ k: 'usage', value: Math.max.apply(null, vals), source: 'history' });
      } else if (reqInfo && config.autoCalibrate) {
        // 客户端缓存命中（MERGE）时服务端只回增量，用量字段缺失 → 回放一次原始请求
        maybeReplayHistory(reqInfo, reqInfo.sessionKey);
      }

      // 只给了增量、没给正文时也要补数，否则摘要与交叉验证都没有原料
      if (!messages.length && reqInfo && config.autoCalibrate) {
        maybeReplayHistory(reqInfo, reqInfo.sessionKey);
      }

      if (messages.length) {
        post({ k: 'history-messages', messages: messages.slice(-200), cacheControl: cacheControl || null });
      }

      // 会话起点：优先从 chat_session / chat_messages 里的时间字段推断
      try {
        var scope = [];
        findByKeyDeep(json, 'chat_session').forEach(function (v) {
          if (v && typeof v === 'object') scope.push(v);
        });
        findByKeyDeep(json, 'chat_messages').forEach(function (v) {
          if (Array.isArray(v)) scope.push(v);
        });
        var times = collectTimes(scope.length ? scope : json, []);
        if (times.length) {
          var minT = Infinity;
          var maxT = 0;
          for (var ti = 0; ti < times.length; ti++) {
            if (times[ti].at < minT) minT = times[ti].at;
            if (times[ti].at > maxT) maxT = times[ti].at;
          }
          var nowTs = Date.now();
          // 只接受合理区间：不早于 2020，不晚于现在一天
          if (minT > 1600000000000 && minT < nowTs + 86400000) {
            post({ k: 'session-meta', startedAt: minT, lastAt: maxT });
          }
        }
      } catch (e) {
        noteError('time', e);
      }
    })();
  }

  function handleHistoryResponse(res, reqInfo) {
    return readJson(res).then(function (json) { handleHistoryJson(json, reqInfo); });
  }

  /**
   * 历史补数：回放页面自己刚刚发过的同一个请求，仅剔除缓存控制字段。
   * 只读、只针对该会话、每个会话最多一次。失败即放弃，绝不重试。
   */
  function maybeReplayHistory(reqInfo, sessionKey) {
    if (!reqInfo || !reqInfo.url) return;
    if (!config.autoCalibrate) return;
    if (replayedSessions[sessionKey]) return;
    replayedSessions[sessionKey] = true;

    var method = reqInfo.method || 'POST';
    var url = reqInfo.url;
    var body = reqInfo.body;

    if (typeof body === 'string') {
      try {
        var parsed = JSON.parse(body);
        var stripped = false;
        ['cache_version', 'cache_reset_at'].forEach(function (key) {
          if (key in parsed) { delete parsed[key]; stripped = true; }
        });
        body = stripped ? JSON.stringify(parsed) : null;
      } catch (e) { body = null; }
    } else {
      body = null;
    }

    // GET 请求：缓存控制参数在 query 上，剔除后重发一次
    if (!body && method.toUpperCase() === 'GET') {
      var cleaned = url
        .replace(/([?&])(cache_version|cache_reset_at)=[^&]*/g, '$1')
        .replace(/[?&]+&/g, '&')
        .replace(/([?&])&/g, '$1')
        .replace(/[?&]$/, '')
        .replace(/\?&/, '?');
      if (cleaned === url) return;
      url = cleaned;
    } else if (!body) {
      return;   // POST 但原始请求没带缓存字段，回放没有意义
    }

    stats.replays++;
    var init = {
      method: method,
      headers: reqInfo.headers,
      credentials: 'include'
    };
    if (body) init.body = body;

    nativeFetch.call(window, url, init).then(function (r) {
      if (!r || !r.ok) return;
      return readJson(r).then(function (json) {
        stats.replayOk = (stats.replayOk || 0) + 1;
        // 补数的目的就是拿全量历史：用量、正文、时间一起解析
        handleHistoryJson(json, null);
      });
    }).catch(function (e) { noteError('replay', e); });
  }

  /* ------------------------------------------------------------ fetch ---*/

  var RE_COMPLETION = /\/chat\/completion/;
  var RE_HISTORY = /\/chat\/history_messages/;
  var RE_SETTINGS = /\/client\/settings/;
  var RE_SHARE = /\/share\/content/;
  var RE_CHATLIST = /chat_session\/fetch_page|chat_session\/create/;

  function sessionKeyFromUrl() {
    var m = /\/chat\/s\/([A-Za-z0-9_-]+)/.exec(location.pathname);
    if (m) return m[1];
    m = /\/share\/([A-Za-z0-9_-]+)/.exec(location.pathname);
    if (m) return 'share:' + m[1];
    return 'new';
  }

  function captureRequest(url, init, input) {
    if (!RE_HISTORY.test(url)) return null;
    var info = {
      url: url,
      method: (init && init.method) || 'POST',
      headers: headersToObject(init && init.headers),
      body: null,
      sessionKey: sessionKeyFromUrl()
    };
    if (init && typeof init.body === 'string') {
      info.body = init.body;
    } else if (input && typeof input.clone === 'function') {
      try {
        input.clone().text().then(function (t) { info.body = t; }).catch(function () {});
      } catch (e) { /* ignore */ }
    }
    lastHistoryRequest = info;
    return info;
  }

  window.fetch = function (input, init) {
    var url = urlOf(input);
    var reqInfo = null;
    stats.fetchSeen++;
    if (url) logReq((init && init.method) || 'GET', url);

    if (url && RE_HISTORY.test(url)) {
      reqInfo = captureRequest(url, init, input);
    }
    if (url && RE_COMPLETION.test(url)) {
      captureUserPrompt(url, init, input);
    }

    var promise = nativeFetch.apply(window, arguments);

    if (!url) return promise;

    var isRelevant = RE_COMPLETION.test(url) || RE_HISTORY.test(url) || RE_SETTINGS.test(url) ||
      RE_SHARE.test(url) || RE_CHATLIST.test(url);
    if (!isRelevant) return promise;

    promise.then(function (res) {
      try {
        var copy = res.clone();
        if (RE_COMPLETION.test(url)) handleCompletionResponse(copy);
        else if (RE_SETTINGS.test(url)) handleSettingsResponse(copy, url);
        else if (RE_CHATLIST.test(url)) {
          readJson(copy).then(handleSessionListJson).catch(function () {});
        }
        else if (RE_HISTORY.test(url)) {
          handleHistoryResponse(copy, reqInfo || lastHistoryRequest);
        } else if (RE_SHARE.test(url)) {
          handleHistoryResponse(copy, null);
        }
      } catch (e) {
        noteError('clone', e);
      }
    }).catch(function () { /* 页面自己的错误，忽略 */ });

    return promise;
  };

  /** 解析 completion 请求体，取出本轮用户输入（用于交接摘要） */
  function handlePromptBody(bodyText) {
    if (!bodyText) return;
    try {
      var json = JSON.parse(bodyText);
      var prompt = json && (json.prompt || json.content || json.query);
      if (typeof prompt === 'string' && prompt.trim()) {
        post({ k: 'user', text: prompt });
      }
      if (json && 'thinking_enabled' in json) {
        post({ k: 'thinking', enabled: !!json.thinking_enabled });
      }
    } catch (e) { /* ignore */ }
  }

  function captureUserPrompt(url, init, input) {
    var handleBody = handlePromptBody;
    if (init && typeof init.body === 'string') handleBody(init.body);
    else if (input && typeof input.clone === 'function') {
      try { input.clone().text().then(handleBody).catch(function () {}); } catch (e) { /* ignore */ }
    }
  }

  /* -------------------------------------------------------------- XHR ---*/

  function patchXHR() {
    if (!nativeXHR || !nativeXHR.prototype) return;
    stats.xhrPatched = true;

    var origOpen = nativeXHR.prototype.open;
    var origSend = nativeXHR.prototype.send;
    var origSetHeader = nativeXHR.prototype.setRequestHeader;

    nativeXHR.prototype.open = function (method, url) {
      try {
        this.__dsUrl = String(url);
        this.__dsMethod = method || 'GET';
        this.__dsHeaders = {};
        stats.xhrSeen++;
        logReq(method || 'GET', url);
      } catch (e) { /* ignore */ }
      return origOpen.apply(this, arguments);
    };

    if (origSetHeader) {
      nativeXHR.prototype.setRequestHeader = function (k, v) {
        try {
          this.__dsHeaders = this.__dsHeaders || {};
          this.__dsHeaders[k] = v;
        } catch (e) { /* ignore */ }
        return origSetHeader.apply(this, arguments);
      };
    }

    nativeXHR.prototype.send = function (body) {
      var self = this;
      try {
        var url = self.__dsUrl || '';
        self.__dsBody = typeof body === 'string' ? body : null;

        if (url && RE_COMPLETION.test(url)) {
          if (self.__dsBody) handlePromptBody(self.__dsBody);

          /* XHR 的流式响应在 readyState 3 时 responseText 会持续增长，
             这里只解析新增的那一段，做到与 fetch 路径同样的实时性。 */
          var parser = createCompletionParser();
          var consumed = 0;
          var pump = function () {
            try {
              var text = self.responseText || '';
              if (text.length > consumed) {
                parser.feed(text.slice(consumed));
                consumed = text.length;
              }
            } catch (e) {
              noteError('xhr-pump', e);
            }
          };
          self.addEventListener('readystatechange', function () {
            if (self.readyState === 3) pump();
            else if (self.readyState === 4) { pump(); parser.finish(); }
          });
        } else if (url && (RE_HISTORY.test(url) || RE_SHARE.test(url))) {
          var reqInfo = {
            url: url,
            method: self.__dsMethod || 'POST',
            headers: self.__dsHeaders || {},
            body: self.__dsBody,
            sessionKey: sessionKeyFromUrl()
          };
          lastHistoryRequest = reqInfo;
          self.addEventListener('load', function () {
            try {
              handleHistoryJson(JSON.parse(self.responseText || 'null'), reqInfo);
            } catch (e) {
              noteError('xhr-history', e);
            }
          });
        } else if (url && RE_SETTINGS.test(url)) {
          self.addEventListener('load', function () {
            try {
              handleSettingsJson(JSON.parse(self.responseText || 'null'), url);
            } catch (e) {
              noteError('xhr-settings', e);
            }
          });
        } else if (url && RE_CHATLIST.test(url)) {
          self.addEventListener('load', function () {
            try {
              handleSessionListJson(JSON.parse(self.responseText || 'null'));
            } catch (e) {
              noteError('xhr-chatlist', e);
            }
          });
        }
      } catch (e) { /* ignore */ }
      return origSend.apply(this, arguments);
    };
  }

  patchXHR();

  /* ------------------------------------------------------------ 自检 ---*/

  stats.fetchPatched = (window.fetch !== nativeFetch);

  if (!stats.fetchPatched) {
    post({ k: 'fatal', message: 'window.fetch 未能接管，可能被页面提前锁定' });
  }

  /* ------------------------------------------------------------ 就绪 ---*/

  post({ k: 'ready', href: location.href, sessionKey: sessionKeyFromUrl(), inFrame: stats.inFrame });

  // 路由变化时告知 content 层切换会话
  var lastHref = location.href;
  setInterval(function () {
    if (location.href !== lastHref) {
      lastHref = location.href;
      post({ k: 'navigate', href: lastHref, sessionKey: sessionKeyFromUrl() });
    }
  }, 800);
})();
