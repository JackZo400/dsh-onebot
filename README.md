# dsh-onebot

给 [DeepSeek Harness](https://github.com/deepseek-ai)（dsh）用的 **QQ 通道**：一个标准的
[OneBot 11](https://github.com/botuniverse/onebot-11) 客户端 —— 连上你自己跑的那个 OneBot 实现，
把你的 dsh Agent 接进 QQ 群和私聊。

零依赖：只用 Node 内置的东西（`fetch` / `WebSocket` / `node:crypto`），没有 npm 包要装。

---

## 为什么是 OneBot 11

因为**换实现不用换插件**。

中文社区的 QQ 机器人实现（go-cqhttp、Lagrange、NapCat、LLOneBot…）几乎都实现了 OneBot 11。
如果这个插件是「某某框架的适配器」，那你换一个实现就得换一套代码；而按协议写，
你那边跑着哪个都行 —— 配置文件里改一行地址就完事。

所以这里做的事很窄：**把协议接进来，把消息交给 dsh 的 agent**。
人设、记忆、内容策略、日结、表情包那些，都属于「接上之后怎么用」，应该由你自己的插件或系统提示决定，
不该塞进一个通道插件里（塞进来的东西，别人没法关）。

## 它做什么

```
QQ 用户 ──> 你的 OneBot 实现 ──ws──> [dsh-onebot] ──> dsh agent（一个会话一个 session）
                                          │
QQ 用户 <── 你的 OneBot 实现 <──API───────┘
```

- **收**：正向 WebSocket 上的 `message` 事件（群 / 私聊）。CQ 码字符串和 segment 数组两种长相都认。
- **发**：`send_group_msg` / `send_private_msg`，消息段支持 `text` / `at` / `image` / `record` / `reply` / `face`。
- **会话**：群 `group:<群号>`、私聊 `private:<QQ号>`，一个 key 一个 dsh 会话，互不串线；
  同一个会话里的消息**串行**处理，一条消息换一条回复。
- **上下文**：给模型看的是「谁、在哪、什么时候说的 + 被回复的那句原文」的信封（见下面示例）。
- **细节**：自己的回声过滤、CQ 转义、引用展开（本地缓存 + `get_msg` 兜底）、
  群成员名册（`@123456789` → `@爱丽丝`）、断线指数退避重连、日志收敛。

## 消息在 dsh 这边长什么样

群里有人 @ 机器人：

```
【群987654321 · 22:15】爱丽丝(QQ 111222333)
↩ 回复 bob(QQ 444555666)：「（图）」
[在 @ 你] 这图啥意思
```

行头是「在哪 · 几点」，第二行是被回复的那句（人话化过的），最后是正文。
被回复的那条本地没留到就用 `get_msg` 去捞；捞不到会写「原文我这边没拿到」，
模型就知道别硬编 —— 而不是收到一句孤零零的「这个什么意思」。

---

## 装

```bash
dsh plugin --profile web add github:JackZo400/dsh-onebot
```

或者 clone 到本地，在 bundle patch 里 insert（`cordis.patch.yml` 里那份示例可以直接抄）。

**环境**：Node **18+**（HTTP 那半边够用）。要**收消息**需要 WebSocket：
Node **22+** 自带全局 `WebSocket`；Node 18/20 请在配置里注入（`WebSocketImpl`）或者
先用 HTTP 半通（能发不能收）。插件本体不依赖任何 npm 包。

## 从零接入（照这个顺序做）

### 第一步：先把 OneBot 实现跑起来

随便选一个（go-cqhttp / Lagrange / NapCat / LLOneBot 都行），把 QQ 登上去，然后
**在它的配置里开「正向 WebSocket 服务」**（有的叫 "WebSocket 服务" / "正向 WS" / "ws server"），
记下：

- 监听地址和端口（默认常见是 `3001`）
- 路径（多数实现是 `/`，NapCat 常见是 `/onebot/v11/ws`）
- 有没有设 access_token

⚠️ 两个容易踩的：**端口别和别的东西撞**；**一个 QQ 不要被两个实现同时登**（会互相踢）。

先不急着装 dsh 插件，用 Node 自带的能力空手验一次（Node 22+）：

```bash
node -e "const ws=new WebSocket('ws://127.0.0.1:3001');
ws.onopen=()=>{console.log('连上了');ws.send(JSON.stringify({action:'get_login_info',params:{},echo:1}))};
ws.onerror=(e)=>console.log('连不上：',e.message||e);
ws.onmessage=(e)=>console.log('回包：',e.data)"
```

看到 `连上了` 和一条 `{"status":"ok","retcode":0,"data":{"user_id":...,"nickname":...}}`
就说明地址、token、路径都对；这一步不通的话，后面不用试了 —— 问题在实现那边。
（设了 token 就换成 `ws://127.0.0.1:3001?access_token=你的token`。）

### 第二步：填配置

改你的 profile patch（`cordis.patch.yml` 里那份抄过去改）：

```yaml
- insert:
    - id: onebot
      name: dsh-onebot
      config:
        ws: ws://127.0.0.1:3001     # 第一步验通过的那个地址
        accessToken: ''             # 实现那边设了才填
        selfId: ''                  # 留空就行（用事件里的 self_id）
        groups: []                  # 留空 = 所有群；想限定就写群号
        private: false              # 私聊默认关（要开就 true，并考虑填 users 白名单）
        requireMention: true        # 群里只有 @ 我才花模型的钱
```

### 第三步：验证通了没有

重启那个 profile，然后在日志里找 `[dsh-onebot]`（插件直接写 stderr）：

```bash
dsh ... 2>&1 | grep '\[dsh-onebot\]'
```

应该依次看到这几行：

```
[dsh-onebot] 就绪：ws=ws://127.0.0.1:3001 群=不限 私聊=关 群内需@=是
[dsh-onebot] 已暴露 onebot 服务（别的插件可以调 send / call）
[dsh-onebot] 已连上 OneBot 服务
[dsh-onebot] 已登录：你的昵称（123456789）
```

`已连上` + `已登录` 就是通了。接下来在群里 **@ 一下机器人**说句话，
日志里会出现 `收到 group group:<群号> "…" @我 · 谁`、`新建会话 …`、`已回复 group:… N 字`。

### 排错对照表

| 现象 | 大概是什么 | 怎么办 |
| --- | --- | --- |
| 日志里根本没有 `[dsh-onebot]` | 插件没加载，或 patch 没生效 | 查 profile 的 patch 路径；插件名要写 `dsh-onebot` |
| 一直 `建连接失败` / `连接断开` | 地址/端口/路径不对，或实现没开正向 WS | 回到第一步用那段 `node -e` 验 |
| `已连上` 但取不到登录信息 | 有的实现没开 `get_login_info` | 不影响收发（`self_id` 用事件里的），日志里会说明 |
| 收不到任何消息 | 只配了 `http` 没配 `ws` | OneBot 的 HTTP API 不推事件；配 ws |
| 私聊不理 | `private: false`（默认） | 改 `true`；想只理自己就把 `users` 填上 |
| 群里 @ 了它不理 | 群不在 `groups` 里 / `requireMention` / 实现没给 at 段 | 打开 `debug: true` 看日志里的 `不派发：<原因>` |
| 它自己跟自己说话（循环） | 那个实现的回声形态没见过 | 提 issue，把 `debug` 日志里那条事件贴上来 |
| `回复失败：… retcode=xxx` | 被实现/风控拒了 | 看日志里的 `wording`；短消息能发、长消息发不出通常是长度上限 |
| 回复能发出去但内容缺图 | 图那部分这一版不搬（见下） | 开 `imageLinks: true` 把直链给模型 |

---

## 支持的 / 不支持的

**支持**

- 正向 WebSocket（收事件 + 调 API）；HTTP API 发送；两者可同时配（ws 收 + http 发）
- 事件：`post_type=message` 的群/私聊消息；`message` 字段两种形态（CQ 码串 / 段数组）
- 发送段：`text` / `at` / `image` / `record` / `reply` / `face`
- API：`send_group_msg`、`send_private_msg`、`get_msg`、`get_group_member_list`、
  `get_group_member_info`、`get_group_info`、`get_login_info`
- 回声过滤（`message_sent` 与 `user_id == self_id` 两种）、`self_id` 自动识别
- CQ 码转义/反转义、`@数字` → 真 at 段、人话化（`（图）`/`[语音]`/`[卡片]`…）
- 引用展开：本地最近 60 条 + `get_msg` 兜底（同一条 5 分钟内只捞一次）
- 成员名册（TTL 6 小时，后台刷新，失败不清空旧数据）
- 每会话串行队列（队列上限、单条超时、一条消息一条回复）
- 断线重连：指数退避 + 抖动 + 日志收敛；连稳 30 秒后才清零退避
- 群/私聊白名单、`requireMention`、`quoteReply`、`format`、`imageLinks` 等开关

**不支持（有意不做，或这一版没做）**

- **反向 WebSocket / HTTP 事件上报**：那需要插件自己起一个 HTTP 服务，这一版没做。
  如果你的实现只能反向上报，现在接不上（issue 里说一声，这是最值得加的下一块）。
- **图片/语音/视频的内容**：`[CQ:image]` 只变成「（图）」，语音只变成「[语音]」。
  想让它真看得见图，给 dsh 配一个能取图的工具，再打开 `imageLinks: true` 把直链写进正文。
- **合并转发聊天记录**（`forward` 段）：只有「[合并转发]」占位，没有展开。
- **主动发消息**：插件自己不排程、不定时；但暴露了 `onebot` 服务（见下），别的插件可以用。
- **notice / request 事件**：戳一戳、进退群、加好友请求，只忽略、不处理。
- **流式/分段**：QQ 没有流式，回复是攒完一次发；超长回复也不分段（会被实现按长度上限拒绝，日志有 retcode）。
- **多账号同时接**：一份配置对一个账号。多账号理论上可以插多个实例、各自 `selfId`，但没测过。
- **设置界面**：没有 UI，全在配置里。

## 给别的插件用的服务

插件 `ctx.provide('onebot', …)`，别的插件（比如定时任务、主动推送）可以直接用：

```js
const onebot = ctx.get('onebot')
await onebot.send('group:987654321', '开会了', { replyTo: undefined })
await onebot.sendGroupMsg(987654321, [{ text: '嗨 ' }, { at: '111222333' }, { image: '/tmp/a.png' }])
const stats = onebot.stats()   // { events, messages, dispatched, replied, skipped, errors, sessions, connected, pending, attempts }
```

## 自检

两条都是**离线**的：假 WebSocket、假 `fetch`、假事件 JSON、假 ctx，不需要网络也不需要 dsh。

```bash
node test/selftest.mjs          # 协议层（纯函数）：CQ 编解码 / 事件解析 / 发送构造 / API 错误 / 退避
node test/plugin-selftest.mjs   # 插件层：拿假 ctx 把 apply() 真跑起来，灌事件看它有没有真的收发
```

覆盖的关键点（都是踩过坑才写的）：

1. CQ 码字符串与 segment 数组解析出**同样的**结果
2. CQ 转义/反转义往返一致（含 `&` 的还原顺序）
3. `@ 我` 的判定（`[CQ:at,qq=<self_id>]` 与 segment 形式的 at；`@全体` 不算）
4. 自己发出去的消息（`user_id == self_id` / `message_sent`）**不会**被派给 agent
5. 引用（`reply` 段）能取到被引用那条的内容（本地缓存 + `get_msg` 兜底）
6. 发送时 `text + at + image` 混合会构造成正确的消息段（`reply` 段永远在最前）
7. HTTP 调用失败 / 超时 / `retcode≠0` 的错误路径
8. 断线重连退避递增、且测试里一秒都不真等（时间可注入）

这两份自检是**会失败**的：把 `escapeCq` 里的逗号删掉、把回声过滤去掉、把退避改成常数，
自检分别报错并以非 0 退出（这也是我们验证"测试不是摆设"的办法）。

## 这一版是从哪来的

它是把一条**真在跑**的私有 QQ 通道重写成标准协议实现的：协议解析（CQ 码、@ 判定、引用、
回声、消息段构造）、会话调度（一会话一 agent、串行队列、碎话切割）、
名册与缓存、重连退避这些**踩过坑的部分**都搬过来了。

刻意**没有**搬的是原来那套部署策略：私有平台的登录/事件流、人设与记忆分级、
内容门禁、消息攒批与日结、表情包库、语音转写、主人指令 —— 那些跟协议无关，
在一个通用插件里只会变成"别人关不掉的行为"。

## 许可

MIT，见 `LICENSE`。
