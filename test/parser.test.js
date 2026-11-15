/* 解析器回测：用真实 SSE 帧格式驱动 main-world.js，检查解析结果
 * 运行：node test/parser.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'src', 'main-world.js'), 'utf8');

/* 构造一个分块返回的假响应 */
function makeRes(text, chunkSize) {
  function makeReader() {
    let i = 0;
    return {
      read() {
        if (i >= text.length) return Promise.resolve({ done: true, value: undefined });
        const piece = text.slice(i, i + (chunkSize || text.length));
        i += piece.length;
        return Promise.resolve({ done: false, value: Buffer.from(piece, 'utf8') });
      }
    };
  }
  return {
    ok: true,
    body: { getReader: makeReader },
    clone() { return makeRes(text, chunkSize); },
    text() { return Promise.resolve(text); },
    getReader() { return makeReader(); }
  };
}

function buildEnv(routes) {
  const posted = [];
  const win = {
    __dsHudHooked: false,
    addEventListener() {},
    postMessage(m) { posted.push(m); },
    fetch: function (url) {
      const key = Object.keys(routes).find(function (k) { return String(url).indexOf(k) !== -1; });
      return Promise.resolve(routes[key] ? routes[key]() : makeRes('{}'));
    }
  };
  win.window = win;

  const ctx = {
    window: win,
    location: { pathname: '/chat/s/abc123', href: 'https://chat.deepseek.com/chat/s/abc123', origin: 'https://chat.deepseek.com' },
    console,
    TextDecoder,
    Buffer,
    Promise,
    JSON,
    Object,
    Array,
    Number,
    String,
    RegExp,
    Math,
    Date,
    isFinite,
    parseInt,
    setInterval: function () { return 0; },
    setTimeout,
    clearTimeout
  };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx, { filename: 'main-world.js' });
  return { win, posted };
}

const SSE_FULL = [
  'data: {"v":{"response":{"accumulated_token_usage":120,"status":"WIP"}}}',
  'data: {"p":"response/fragments","o":"APPEND","v":[{"id":"1","type":"THINK"}]}',
  'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"先看堆直方图，" }',
  'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"再判断是否泄漏。"}',
  'data: {"p":"response/fragments","o":"APPEND","v":[{"id":"2","type":"RESPONSE"}]}',
  'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"根因是缓存没有 TTL。"}',
  'data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":211},{"p":"quasi_status","v":"FINISHED"}]}',
  'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
  'data: [DONE]',
  ''
].join('\n');

const SSE_BLOCKED = [
  'data: {"v":{"response":{"accumulated_token_usage":960100}}}',
  'data: {"p":"response","o":"BATCH","v":[{"p":"finish_reason","v":"context_length_exceeded"}]}',
  'data: [DONE]',
  ''
].join('\n');

const HISTORY_JSON = JSON.stringify({
  code: 0,
  data: {
    biz_data: {
      chat_session: { id: 'abc123', accumulated_token_usage: 462318, created_at: 1762000000000 },
      cache_control: 'MERGE',
      chat_messages: [
        { message_id: 1, role: 'USER', content: '帮我排查 OOM' },
        { message_id: 2, role: 'ASSISTANT', content: '根因是缓存没有 TTL' }
      ]
    }
  }
});

const SETTINGS_JSON = JSON.stringify({
  code: 0,
  data: {
    biz_data: {
      file_feature: { token_limit: 100000 },
      normal_history_and_file_token_limit: 890880
    }
  }
});

function pick(posted, k) {
  return posted.filter(function (m) { return m.k === k; });
}

let pass = 0;
function ok(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '  →  ' + e.message); process.exitCode = 1; }
}

/* ---------------------------------------------------------------- 用例 ---*/

console.log('\n[1] 完整 SSE：用量、思考/正文分离');

(async function () {
  const env = buildEnv({ '/chat/completion': () => makeRes(SSE_FULL) });
  env.win.fetch('https://chat.deepseek.com/api/v0/chat/completion', { method: 'POST', body: '{"prompt":"测试"}' });
  await new Promise(r => setTimeout(r, 60));

  const usages = pick(env.posted, 'usage').map(m => m.value);
  ok('抓到 120 与 211 两个用量点', () => {
    assert(usages.indexOf(120) >= 0, '缺少 120，实际：' + usages.join(','));
    assert(usages.indexOf(211) >= 0, '缺少 211，实际：' + usages.join(','));
  });
  ok('用量单调不减', () => {
    for (let i = 1; i < usages.length; i++) assert(usages[i] >= usages[i - 1], '出现回退：' + usages.join(','));
  });

  const asst = pick(env.posted, 'assistant');
  ok('正文与思考被正确分离', () => {
    assert(asst.length === 1, 'assistant 事件数量应为 1，实际 ' + asst.length);
    assert.strictEqual(asst[0].think, '先看堆直方图，再判断是否泄漏。');
    assert.strictEqual(asst[0].text, '根因是缓存没有 TTL。');
  });

  const user = pick(env.posted, 'user');
  ok('从请求体取到本轮用户输入', () => {
    assert(user.length === 1 && user[0].text === '测试');
  });

  /* ------------------------------------------------------------ 用例 2 ---*/
  console.log('\n[2] 分片到达（每 7 字节一刀）：JSON 被切断时的兜底');

  const env2 = buildEnv({ '/chat/completion': () => makeRes(SSE_FULL, 7) });
  env2.win.fetch('https://chat.deepseek.com/api/v0/chat/completion', { method: 'POST', body: '{"prompt":"x"}' });
  await new Promise(r => setTimeout(r, 200));

  const usages2 = pick(env2.posted, 'usage').map(m => m.value);
  ok('分片后仍拿到最终值 211', () => {
    assert(usages2.indexOf(211) >= 0, '实际：' + usages2.join(','));
  });

  /* ------------------------------------------------------------ 用例 3 ---*/
  console.log('\n[3] 被上下文拦截的识别');

  const env3 = buildEnv({ '/chat/completion': () => makeRes(SSE_BLOCKED) });
  env3.win.fetch('https://chat.deepseek.com/api/v0/chat/completion', { method: 'POST', body: '{"prompt":"x"}' });
  await new Promise(r => setTimeout(r, 60));

  ok('识别出 context_length_exceeded', () => {
    const b = pick(env3.posted, 'blocked');
    assert(b.length === 1, 'blocked 事件数：' + b.length);
    assert.strictEqual(b[0].reason, 'context_length_exceeded');
  });
  ok('拦截时仍拿到已用量', () => {
    const u = pick(env3.posted, 'usage').map(m => m.value);
    assert(u.indexOf(960100) >= 0, '实际：' + u.join(','));
  });

  /* ------------------------------------------------------------ 用例 4 ---*/
  console.log('\n[4] 历史接口：嵌套结构里的用量与消息');

  const env4 = buildEnv({ '/chat/history_messages': () => makeRes(HISTORY_JSON) });
  env4.win.fetch('https://chat.deepseek.com/api/v0/chat/history_messages', { method: 'POST', body: '{}' });
  await new Promise(r => setTimeout(r, 60));

  ok('从深层结构找到 accumulated_token_usage', () => {
    const u = pick(env4.posted, 'usage');
    assert(u.length >= 1, '未收到用量');
    assert.strictEqual(u[0].value, 462318);
    assert.strictEqual(u[0].source, 'history');
  });
  ok('还原出对话消息（role + content）', () => {
    const h = pick(env4.posted, 'history-messages');
    assert(h.length === 1, '数量：' + h.length);
    assert.strictEqual(h[0].messages.length, 2);
    assert.strictEqual(h[0].messages[1].text, '根因是缓存没有 TTL');
  });

  ok('推断出会话起点时间', () => {
    const meta = pick(env4.posted, 'session-meta');
    assert(meta.length === 1, 'session-meta 数量：' + meta.length);
    assert.strictEqual(meta[0].startedAt, 1762000000000);
  });

  /* ------------------------------------------------------------ 用例 5 ---*/
  console.log('\n[5] settings：分母候选值');

  const env5 = buildEnv({ '/client/settings': () => makeRes(SETTINGS_JSON) });
  env5.win.fetch('https://chat.deepseek.com/api/v0/client/settings?scope=model', { method: 'GET' });
  await new Promise(r => setTimeout(r, 60));

  ok('读到历史/文件上限与单文件上限', () => {
    const l = pick(env5.posted, 'limit');
    assert(l.length === 1, 'limit 事件数：' + l.length);
    assert.strictEqual(l[0].historyLimit, 890880);
    assert.strictEqual(l[0].tokenLimit, 100000);
  });

  /* ------------------------------------------------------------ 用例 6 ---*/
  console.log('\n[6] 噪声容错');

  const NOISE = [
    ': keep-alive',
    '',
    'data: not-json{{{',
    'data: {"v":"普通文本增量"}',
    'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"无片段登记时的正文"}',
    'data: {"p":"unrelated/path","o":"SET","v":1}',
    'data: [DONE]',
    ''
  ].join('\n');

  const env6 = buildEnv({ '/chat/completion': () => makeRes(NOISE) });
  ok('异常帧不抛错', () => {
    assert.doesNotThrow(() => {
      env6.win.fetch('https://chat.deepseek.com/api/v0/chat/completion', { method: 'POST', body: '{}' });
    });
  });
  await new Promise(r => setTimeout(r, 60));
  ok('无用量时不误报', () => {
    assert.strictEqual(pick(env6.posted, 'usage').length, 0);
  });

  console.log('\n' + (process.exitCode ? '有失败用例' : '全部通过：' + pass + ' 项'));
})();
