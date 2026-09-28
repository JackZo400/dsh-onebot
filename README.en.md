# dsh-onebot

[简体中文](README.md) | English

A **QQ channel** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): a standard
[OneBot 11](https://github.com/botuniverse/onebot-11) client — it connects to the OneBot implementation you
run yourself and brings your dsh agent into QQ groups and private chats.

Zero dependencies: only Node built-ins (`fetch` / `WebSocket` / `node:crypto`); there is no npm package to
install.

> **More mature options in the same space**: for one codebase that connects several platforms at once
> (WeChat / Feishu / DingTalk / WeCom / Slack / Telegram / Discord / QQ ...) through each platform's
> official bot credentials, use [xmanrui/dsh-im](https://github.com/xmanrui/dsh-im); for QQ only there are
> [cheesehaqi/dsh-qq-onebot-bridge](https://github.com/cheesehaqi/dsh-qq-onebot-bridge) and
> [Hoshino-Yumetsuki/dsh-onebot](https://github.com/Hoshino-Yumetsuki/dsh-onebot).
> Why we keep this one: it is a **standard OneBot 11 channel with zero dependencies** — the version our own
> production machine runs (the personal-account route); written against the protocol, switching OneBot
> implementations does not mean switching plugins.
> Install one of the above first; they cover more ground than this one does.

---

## Why OneBot 11

Because **switching implementations does not mean switching plugins**.

Almost every QQ bot implementation in the Chinese community (go-cqhttp, Lagrange, NapCat, LLOneBot, ...)
implements OneBot 11. If this plugin were "an adapter for some framework", then switching implementations
would mean switching a whole codebase; written against the protocol instead, it does not matter which one
you are running — change one line of the address in the config file and you are done.

So what it does here is narrow: **take the protocol in, hand the messages to the dsh agent**. Persona,
memory, content policy, daily digests and sticker collections all belong to "how you use it once you are
connected" and should be decided by your own plugins or system prompt; they should not be stuffed into a
channel plugin (whatever gets stuffed in, nobody else can turn it off).

## What it does

```
QQ 用户 ──> 你的 OneBot 实现 ──ws──> [dsh-onebot] ──> dsh agent（一个会话一个 session）
                                          │
QQ 用户 <── 你的 OneBot 实现 <──API───────┘
```

- **In**: `message` events (group / private) over a forward WebSocket. Both shapes are accepted: CQ-code
  strings and segment arrays.
- **Out**: `send_group_msg` / `send_private_msg`; message segments support `text` / `at` / `image` /
  `record` / `reply` / `face`.
- **Sessions**: `group:<group id>` for groups and `private:<QQ number>` for private chats; one key is one
  dsh session, and nothing crosses over. Messages in the same session are handled **serially**: one
  message in, one reply out.
- **Context**: what the model sees is an envelope of "who, where, when + the original text of the message
  being replied to" (see the example below).
- **Details**: filtering its own echo, CQ escaping, quote expansion (local cache + `get_msg` fallback), the
  group member roster (`@123456789` → `@Alice`), exponential-backoff reconnect, log throttling.

## What a message looks like on the dsh side

Someone in a group @-s the bot:

```
【群987654321 · 22:15】爱丽丝(QQ 111222333)
↩ 回复 bob(QQ 444555666)：「（图）」
[在 @ 你] 这图啥意思
```

The header line is "where · what time"; the second line is the message being replied to (humanized); the
last line is the body. If the replied-to message was not kept locally, it is fetched with `get_msg`; if
that fails too, the envelope says that the original text was not available on our side, so the model knows
not to make it up — instead of receiving a lonely "what does this mean".

---

## Install

```bash
dsh plugin --profile web add github:JackZo400/dsh-onebot
```

Or clone it locally and insert it in your bundle patch (you can copy the example in `cordis.patch.yml` as
is).

**Environment**: Node **18+** (enough for the HTTP half). **Receiving messages** needs WebSocket: Node
**22+** ships a global `WebSocket`; on Node 18/20 inject one in the config (`WebSocketImpl`) or start with
the HTTP half only (can send, cannot receive). The plugin itself depends on no npm package.

## Getting connected from scratch (in this order)

### Step 1: get your OneBot implementation running first

Pick any one (go-cqhttp / Lagrange / NapCat / LLOneBot will all do), log the QQ account in, then **turn on
"forward WebSocket service" in its config** (some call it "WebSocket service" / "forward WS" / "ws
server"), and write down:

- the listen address and port (the common default is `3001`)
- the path (most implementations use `/`, NapCat commonly uses `/onebot/v11/ws`)
- whether an access_token is set

⚠️ Two easy traps: **do not let the port collide with anything else**; **do not log one QQ account into
two implementations at the same time** (they will kick each other off).

Do not install the dsh plugin yet; first verify by hand with what Node gives you (Node 22+):

```bash
node -e "const ws=new WebSocket('ws://127.0.0.1:3001');
ws.onopen=()=>{console.log('连上了');ws.send(JSON.stringify({action:'get_login_info',params:{},echo:1}))};
ws.onerror=(e)=>console.log('连不上：',e.message||e);
ws.onmessage=(e)=>console.log('回包：',e.data)"
```

The plugin logs in Chinese; the two console strings above mean "connected" and "reply". If you see the
first one and a `{"status":"ok","retcode":0,"data":{"user_id":...,"nickname":...}}` line, then the
address, token and path are all correct; if this step does not work, do not bother with the rest — the
problem is on the implementation side. (If a token is set, use
`ws://127.0.0.1:3001?access_token=your-token` instead.)

### Step 2: fill in the config

Edit your profile patch (copy the one in `cordis.patch.yml` and change it):

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

### Step 3: verify that it is connected

Restart that profile, then look for `[dsh-onebot]` in the log (the plugin writes straight to stderr):

```bash
dsh ... 2>&1 | grep '\[dsh-onebot\]'
```

You should see these lines in order:

```
[dsh-onebot] 就绪：ws=ws://127.0.0.1:3001 群=不限 私聊=关 群内需@=是
[dsh-onebot] 已暴露 onebot 服务（别的插件可以调 send / call）
[dsh-onebot] 已连上 OneBot 服务
[dsh-onebot] 已登录：你的昵称（123456789）
```

The plugin prints these lines in Chinese; the third line means "connected to the OneBot service" and the
fourth means "logged in as your nickname", and those two mean you are through. Next, **@ the bot** in a
group and say something: the log will then show the received group message (session key, whether you were
@-ed, who sent it), a line for the new session, and a line for the reply with its character count.

### Troubleshooting table

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| no `[dsh-onebot]` line in the log at all | the plugin was not loaded, or the patch did not take effect | check the profile's patch path; the plugin name must be `dsh-onebot` |
| it keeps logging connect failures / disconnects | wrong address / port / path, or forward WS is not enabled | go back to step 1 and verify with that `node -e` snippet |
| connected, but no login info can be fetched | some implementations do not enable `get_login_info` | does not affect sending/receiving (`self_id` comes from the event), and the log will say so |
| no messages arrive at all | only `http` is configured, not `ws` | OneBot's HTTP API does not push events; configure ws |
| private chats are ignored | `private: false` (the default) | set it to `true`; to only answer yourself, fill in `users` |
| @-ing it in a group gets no answer | the group is not in `groups` / `requireMention` / the implementation sent no at segment | turn on `debug: true` and read the "not dispatching: <reason>" line in the log |
| it talks to itself (a loop) | that implementation's echo shape has not been seen before | open an issue and paste that event from the `debug` log |
| the log shows a reply failure with `retcode=xxx` | rejected by the implementation or by risk control | read `wording` in the log; short messages going out while long ones do not is usually a length limit |
| the reply is sent but images are missing | images are not carried over in this version (see below) | turn on `imageLinks: true` to give the model the direct links |

---

## The service for other plugins

The plugin calls `ctx.provide('onebot', …)`, so other plugins (scheduled jobs, proactive pushes, for
example) can use it directly:

```js
const onebot = ctx.get('onebot')
await onebot.send('group:987654321', '开会了', { replyTo: undefined })
await onebot.sendGroupMsg(987654321, [{ text: '嗨 ' }, { at: '111222333' }, { image: '/tmp/a.png' }])
const stats = onebot.stats()   // { events, messages, dispatched, replied, skipped, errors, sessions, connected, pending, attempts }
```

## Tests

Both of them are **offline**: a fake WebSocket, a fake `fetch`, fake event JSON and a fake ctx; no network
and no dsh needed.

```bash
node test/selftest.mjs          # 协议层（纯函数）：CQ 编解码 / 事件解析 / 发送构造 / API 错误 / 退避
node test/plugin-selftest.mjs   # 插件层：拿假 ctx 把 apply() 真跑起来，灌事件看它有没有真的收发
```

The key points covered (every one of them was written after stepping on that bug):

1. CQ-code strings and segment arrays parse to **the same** result
2. CQ escaping/unescaping round-trips consistently (including the order in which `&` is restored)
3. the `@ me` decision (`[CQ:at,qq=<self_id>]` and at in segment form; `@all` does not count)
4. messages the bot sent itself (`user_id == self_id` / `message_sent`) are **not** dispatched to the agent
5. quotes (the `reply` segment) can resolve the content of the quoted message (local cache + `get_msg`
   fallback)
6. when sending, a mix of `text + at + image` is built into the correct message segments (the `reply`
   segment is always first)
7. the HTTP call failure / timeout / `retcode≠0` error paths
8. the reconnect backoff grows, and the tests do not really wait a single second (time is injectable)

These two self-tests **can fail**: delete the comma inside `escapeCq`, remove the echo filter, or change
the backoff to a constant, and they report an error and exit non-zero (which is also how we verify that
"the tests are not just decoration").

## Known limitations (supported / not supported)

**Supported**

- forward WebSocket (receive events + call the API); sending over the HTTP API; the two can be configured
  at the same time (ws in + http out)
- events: group/private messages with `post_type=message`; both shapes of the `message` field (CQ-code
  string / segment array)
- send segments: `text` / `at` / `image` / `record` / `reply` / `face`
- API: `send_group_msg`, `send_private_msg`, `get_msg`, `get_group_member_list`,
  `get_group_member_info`, `get_group_info`, `get_login_info`
- echo filtering (both `message_sent` and `user_id == self_id`), automatic `self_id` detection
- CQ escaping/unescaping, `@number` → a real at segment, humanization (`(image)` / `[voice]` / `[card]`…)
- quote expansion: the last 60 messages locally + `get_msg` as a fallback (the same message is fetched
  only once per 5 minutes)
- member roster (TTL 6 hours, refreshed in the background, a failure does not wipe the old data)
- a serial queue per session (queue cap, per-message timeout, one message one reply)
- reconnect: exponential backoff + jitter + log throttling; the backoff is only reset after 30 seconds of
  a stable connection
- group/private allowlists and switches such as `requireMention`, `quoteReply`, `format`, `imageLinks`

**Not supported (deliberately not done, or not done in this version)**

- **Reverse WebSocket / HTTP event reporting**: that would need the plugin to start an HTTP server of its
  own, and this version does not do it. If your implementation can only report in reverse, it cannot be
  connected yet (say so in an issue; this is the next piece most worth adding).
- **The content of images/voice/video**: `[CQ:image]` only turns into the "(image)" placeholder, and voice
  only turns into "[voice]". If you want it to really see pictures, give dsh a tool that can fetch images,
  then turn on `imageLinks: true` to put the direct links into the body.
- **Merged forward chat records** (the `forward` segment): only a "[merged forward]" placeholder, never
  expanded.
- **Sending proactively**: the plugin itself does not schedule anything and uses no timer; but it exposes
  the `onebot` service (below), so other plugins can.
- **notice / request events**: pokes, joins/leaves and friend requests are only ignored, never handled.
- **Streaming/splitting**: QQ has no streaming, so a reply is accumulated and sent in one go; an over-long
  reply is not split either (the implementation rejects it at its length limit, and the log has the
  retcode).
- **Several accounts at once**: one config is one account. Several accounts could in theory be several
  plugin instances with their own `selfId`, but that has not been tested.
- **A settings UI**: there is no UI; everything is in the config.

## Where this version came from

It is a rewrite of a **private QQ channel that was really running** into a standard-protocol
implementation: all the **parts that had been paid for in bugs** were carried over — protocol parsing
(CQ codes, @ detection, quotes, echo, message segment construction), session scheduling (one agent per
session, serial queue, splitting long messages), the roster and the caches, and reconnect backoff.

What was deliberately **not** carried over is the old deployment policy: the private platform's
login/event stream, persona and memory tiers, content gating, message batching and daily digests, the
sticker library, voice transcription, owner commands — none of that has anything to do with the protocol,
and inside a general-purpose plugin it would only turn into "behaviour that other people cannot turn off".

## License

MIT, see `LICENSE`.
