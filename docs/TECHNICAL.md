# 技术说明

面向想改代码或理解数据来源的人。这里记录的是**实测结论**，不是推测——每条都标注了是怎么得到的。

---

## 一、数据从哪来

DeepSeek 网页端是 SPA，DOM 上没有 token 数字，数据全在请求里。核心事实：

**主通道是 XHR，不是 fetch。** 实测一次页面加载：`fetch 调用 3 / XHR 调用 31`。只做 fetch 路径的结果是"统计能回传、抓取全是 0"。

两条通道现在等价：

| 能力 | fetch 路径 | XHR 路径 |
|---|---|---|
| 正文增量 | `res.clone()` + 读流 | `readystatechange` 在 `readyState 3` 读 `responseText` 增量 |
| 用量 | 同上 | 同上 |
| settings | 解析 JSON | 解析 JSON |
| history | 解析 JSON + 请求体回放 | 解析 JSON + 捕获请求体/头部 |
| 会话列表 | `chat_session/fetch_page` | 同 |

### 用到的接口

| 接口 | 拿什么 |
|---|---|
| `POST /api/v0/chat/completion` | SSE 流：用量、正文、思考、工具片段、拦截原因 |
| `GET /api/v0/chat/history_messages` | 会话累计用量、消息、时间戳 |
| `GET /api/v0/chat_session/fetch_page` | 会话创建时间（最可信的「对话起点」来源） |
| `GET /api/v0/client/settings` | 功能开关（**不含配额**，详见第三节） |

### 注入方式

`manifest.json` 里声明两段 content script，其中抓取那段用 `"world": "MAIN"`：

```json
{ "matches": ["https://chat.deepseek.com/*"], "js": ["src/main-world.js"],
  "world": "MAIN", "run_at": "document_start", "all_frames": true }
```

好处是**不需要 `webRequest`**。`webRequest` 在 MV3 里读不到响应体，加了也没用；而 MAIN world 在页面同一 JS 上下文里，可以直接接管 `window.fetch` 和 `XMLHttpRequest.prototype`。

---

## 二、SSE 结构

响应是 `data: {...}` 逐行下发，载荷有多种形态：

```jsonc
// 初始化 envelope
{"v":{"response":{"accumulated_token_usage":120,"status":"WIP"}}}
// 片段类型登记
{"p":"response/fragments","o":"APPEND","v":[{"type":"THINK"}]}
// 正文增量
{"p":"response/fragments/-1/content","o":"APPEND","v":"..."}
// 批量 patch（用量在这里）
{"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":211}]}
```

解析要点：

1. **必须跨 chunk 维护缓冲**。SSE 帧会被切成任意长度，按块切行会丢掉半行，表现为"有时有数、有时没数"。
2. **初始化 envelope 要能深扫**。`{"v":{"response":{...}}}` 这种多包一层，逐字段判断会漏。
3. **正文可能一次性下发**。实测一轮回复里 `RESPONSE` 片段只有 1 个，正文往往整体到达，靠"逐 patch 累积"会漏——必须同时支持片段对象内联 `content`。
4. **用量对 `postMessage` 做节流**（150ms）并保证 finish 时强制推一次终值。

### 片段类型实测

一轮带联网搜索的回复：

```
{"THINK":34, "TOOL_SEARCH":18, "TOOL_OPEN":72, "RESPONSE":1}
正文 357 字 / 思考 3638 字
```

三个结论：

- **思考比正文贵一个数量级**。3638 字推理 vs 357 字正文，这是"上下文为什么掉得这么快"的主要答案。
- **联网搜索额外吃 token**。90 个工具片段不进入正文，但计入上下文。
- **RESPONSE 少不代表内容少**，见上面第 3 点。

---

## 三、关于「上限」的更正

早期版本按第三方脚本的经验，从 `settings` 读 `token_limit` / `normal_history_and_file_token_limit` 当分母。抓了真实响应后确认这条路是错的：

**1. `normal_history_and_file_token_limit` 已不存在**

新版前端包里搜不到这个字段，settings 响应里也没有。

**2. `token_limit` 不是上下文窗口**

前端代码原文：

```js
uh = (e) => {
  let { thinking: r, modelType: s } = e;
  return s === null ? 61440
    : (n = modelOf(s)?.file_feature)
        ? (r ? n.token_limit_with_thinking : n.token_limit)
        : 61440
}
```

它挂在 `file_feature` 下，语义是**单个文件 / 单次粘贴的内容上限**，默认 61440（≈60K）。跟 1M 的上下文窗口无关。

**3. settings 返回的是功能开关**

实测结构：

```
data.biz_data.settings.silent_refresh.value      : boolean
data.biz_data.settings.show_refresh_prompt.value : boolean
data.biz_data.settings.force_refresh.value       : boolean
```

### 结论：上下文窗口只在服务端

前端拿不到，接口不下发。可用信息只有三档：

| 来源 | 数值 | 可信度 |
|---|---|---|
| 官方公告「1M 是所有官方服务标配」 | 1,000,000 | 高，但是模型窗口 |
| 第三方实测拦截线 | ≈962,000 | 中，非官方 |
| 自己撞墙实测 | 未知 | 最高 |

代码取舍：默认 962,000 并标「经验值（未校准）」；被拦截时立即切到实测值并标「被拦截后实测」。**不拿 61440 这种无关数字冒充分母。**

---

## 四、会话起点

优先级：

1. `chat_session/fetch_page` 或 `chat_session/create` 返回的 `created_at`
2. `history_messages` 里 `chat_session.inserted_at` / `chat_messages[].created_at`
3. 以上都没有时，退回「首次发言时刻」，界面标注**「按首次发言估算，可能晚于真实起点」**

时间戳兼容秒 / 毫秒 / ISO 字符串；早于 2020 或晚于现在一天的，一律丢弃。

72 小时进度按「创建至今」计算。若官方实际按「活跃时长」计算，我们的读数会偏大（更早告警）。

---

## 五、交叉验证的口径

早期版本拿「会话累计 token ÷ 本次捕获字符」做校验，得出过 259 倍这种荒谬数字。原因是**历史正文在服务端，本地拿不到**，用总量比局部必然失真。

正确口径是**单轮**：

```
本轮新增 token ÷ (正文折算 + 思考折算) → 期望落在 0.5 ~ 2.5
```

实测验证：`2675 ÷ (214 + 2001) = 1.21`，合理。

比值 > 2.5 通常意味着该轮包含联网搜索、网页抓取或附件——这部分 token 不进入正文。

---

## 六、性能设计

流式输出时 DOM 每秒变动上千次，任何"每次变动都干活"的实现都会把页面拖死。三道闸：

| 动作 | 错误做法 | 现在的做法 |
|---|---|---|
| 跟随输入框定位 | 每次 DOM 变动 → `querySelectorAll` + `getBoundingClientRect` → 强制重排 | 缓存元素；只在脱离文档时重查；位置未变不写 style；触发点走 rAF 合并 |
| DOM 监听 | `subtree:true` 直接回调定位 | 300ms 限流，且只在「输入框丢了」时定位；尺寸变化交给 ResizeObserver |
| 主题/位置兜底 | 每 2 秒 `getComputedStyle` + 重定位 | 每 20 秒一次，页面隐藏时跳过 |
| 重绘 | 每条数据都重建 SVG、重排面板 | rAF 合并；环形图百分比与等级未变就不重建 |
| SSE 解析 | 每个事件都做全对象深扫 + `JSON.parse` | 先用字符串预过滤，无关帧不解析 |

---

## 七、排查用的内置探针

接口会变。为了不靠猜，诊断面板内置：

- `接管状态`：fetch / XHR 是否成功接管
- `fetch 调用 / XHR 调用`：请求计数，判断页面走哪条通道
- `抓到的接口`：实际命中的 API 路径清单
- `正文 patch 路径` + `patch 形态采样`：`路径 | 操作符 | 值类型(长度)`，**不含内容**
- `settings 结构`：按 scope 分组的**键名与类型**，不含值
- `交叉验证`：单轮比值，判断抓取是否完整

这些全部只输出结构信息，可以安全地贴进 issue。

---

## 八、回测

```bash
node test/parser.test.js
```

13 项用例，覆盖用量提取、思考/正文分离、**跨 chunk 分片**、拦截识别、历史接口深嵌套、settings 解析、异常帧容错。

这套用例抓到过两个真实缺陷：

- SSE 帧被切成任意长度时丢半行
- 初始化 envelope 形态漏读

两个都会表现成「看着能用，一上新对话就没数」。
