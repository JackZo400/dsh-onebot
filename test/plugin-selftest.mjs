/**
 * 插件级自检 —— **不需要 dsh**：拿一个假 ctx（假的 agents / 事件总线 / effect）把
 * `apply()` 跑起来，再用一个假 WebSocket 把真实形态的 OneBot 事件灌进去，
 * 看它有没有真的建会话、有没有真的把回复发出去、该拦的有没有拦。
 *
 * 跑：`node test/plugin-selftest.mjs`
 *
 * 全都是离线的：没有网络、没有模型、没有 QQ。时间也是注入的（重连的等待用假 sleep，
 * 所以一秒都不真等）。
 */
import { apply, DEFAULTS, inject, name as pluginName } from '../index.js'

let pass = 0
const fails = []
const ok = (label, cond, extra) => {
  if (cond) {
    pass++
    console.log(`✓ ${label}`)
  } else {
    fails.push(`${label}${extra ? `  → ${extra}` : ''}`)
  }
}
const eq = (label, got, want) => ok(label, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)
const jok = (label, got, want) => eq(label, JSON.stringify(got), JSON.stringify(want))
const tick = () => new Promise((r) => setTimeout(r, 0))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 等一个条件成立（最多等 1 秒），避免用固定 sleep 猜时间 */
async function until(cond, label) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return true
    await sleep(5)
  }
  ok(`等待超时：${label || '条件'}`, false)
  return false
}

const SELF = '123456789'
const GROUP = '987654321'
const ALICE = '111222333'
const BOB = '444555666'

// ---------------------------------------------------------------------
// 假 WebSocket：只实现 transport 真的用到的那几个方法
// ---------------------------------------------------------------------
const sockets = []
const responses = {}
let autoReply = true

class FakeSocket {
  constructor(url, protocols, options) {
    this.url = url
    this.options = options
    this.sent = []
    this.listeners = new Map()
    this.closedByUs = false
    sockets.push(this)
  }
  addEventListener(ev, fn) {
    const arr = this.listeners.get(ev) ?? []
    arr.push(fn)
    this.listeners.set(ev, arr)
  }
  emit(ev, payload) {
    for (const fn of this.listeners.get(ev) ?? []) fn(payload)
  }
  send(text) {
    const frame = JSON.parse(text)
    this.sent.push(frame)
    if (!autoReply) return
    const handler = responses[frame.action]
    const body = typeof handler === 'function' ? handler(frame.params) : { status: 'ok', retcode: 0, data: {} }
    // 回包是异步到的（真实世界也是），所以放进微任务队列
    queueMicrotask(() => this.emit('message', { data: JSON.stringify({ ...body, echo: frame.echo }) }))
  }
  close() {
    this.closedByUs = true
    this.emit('close', { code: 1000 })
  }
  /** 所有发出去的调用（跨所有连接） */
  static calls() {
    return sockets.flatMap((s) => s.sent)
  }
  static callsOf(action) {
    return FakeSocket.calls().filter((c) => c.action === action)
  }
  static last() {
    return sockets[sockets.length - 1]
  }
}

// ---------------------------------------------------------------------
// 假 ctx：agents / 事件总线 / effect / provide
// ---------------------------------------------------------------------
/** 助手这一轮会流出什么：先一句自言自语，再调一次工具（那句碎话要被切掉），最后是回复 */
const ASSISTANT_SCRIPT = [
  { type: 'chunk', chunk: { type: 'text-delta', text: '我先看看…' } },
  { type: 'chunk', chunk: { type: 'tool-call-delta', id: 'tool-1', name: 'some_tool' } },
  { type: 'chunk', chunk: { type: 'text-delta', text: '收到啦～' } },
]

function makeCtx() {
  const listeners = new Map()
  const cleanups = []
  const created = []
  const provided = {}

  const emit = (ev, payload) => {
    for (const fn of listeners.get(ev) ?? []) fn(payload)
  }

  const ctx = {
    agents: {
      async create(options) {
        const sessionId = options.sessionId
        const agent = {
          id: sessionId,
          sessionId,
          inbox: { nextTurn: [], nextStep: [] },
          messages: [],
          disposed: false,
          followup(message) {
            agent.messages.push(message)
            // 模拟助手流式输出（同步发，测试才好判断时序）
            for (const frame of ASSISTANT_SCRIPT) emit('agent/assistant-stream', { agent, frame })
          },
          async whenIdle() {
            await tick()
          },
        }
        const handle = {
          agent,
          async dispose() {
            agent.disposed = true
          },
        }
        created.push({ options, agent, handle })
        return handle
      },
    },
    on(ev, fn) {
      const arr = listeners.get(ev) ?? []
      arr.push(fn)
      listeners.set(ev, arr)
      return () => {}
    },
    get() {
      return undefined
    },
    provide(key, value) {
      provided[key] = value
    },
    effect(cb) {
      const disposer = cb()
      if (typeof disposer === 'function') cleanups.push(disposer)
      return () => {
        disposer?.()
      }
    },
  }
  return { ctx, created, provided, cleanups, emit }
}

// 日志是往 stderr 直接写的（不走 ctx.logger），这里临时接管一下，好在测试里断言
const logs = []
const realWrite = process.stderr.write.bind(process.stderr)
process.stderr.write = (chunk) => {
  logs.push(String(chunk))
  return true
}
const logged = (re) => logs.some((line) => re.test(line))

const sleeps = []
const harness = makeCtx()

// 登录信息要在连接建立之前就准备好 —— 插件连上之后会立刻问一次
responses.get_login_info = () => ({ status: 'ok', retcode: 0, data: { user_id: 123456789, nickname: 'demo-bot' } })

try {
  apply(harness.ctx, {
    ws: 'ws://127.0.0.1:3001',
    accessToken: 'demo-token',
    selfId: SELF,
    groups: [],
    private: true,
    users: [ALICE],
    requireMention: true,
    quoteReply: true,
    reconnect: { enabled: true, baseMs: 100, maxMs: 800, factor: 2, jitter: 0, quietAfter: 3 },
    timeouts: { callMs: 300, readyMs: 300 },
    queue: { max: 5, timeoutMs: 5000 },
    WebSocket: FakeSocket,
    // 重连的等待走假 sleep：一秒都不真等
    sleep: (ms) => {
      sleeps.push(ms)
      return Promise.resolve()
    },
  })
} catch (e) {
  ok('apply() 不该抛异常', false, `${e?.stack ?? e}`)
}

// ---------------------------------------------------------------------
console.log('\n— 插件接线 —')
eq('插件名', pluginName, 'dsh-onebot')
jok('要 agents 能力', inject, ['agents'])
eq('默认不响应私聊（私聊是最容易被白嫖的口子）', DEFAULTS.private, false)
eq('默认群里必须 @ 我', DEFAULTS.requireMention, true)
eq('默认发送用消息段数组', DEFAULTS.format, 'array')

eq('apply 之后建了一根连接', sockets.length, 1)
eq('连接地址带 access_token', sockets[0].url, 'ws://127.0.0.1:3001?access_token=demo-token')
sockets[0].emit('open')

// 连上之后应该问一次「我是谁」
await until(() => FakeSocket.callsOf('get_login_info').length === 1, 'get_login_info')
await tick()
ok('连上之后会问登录信息', FakeSocket.callsOf('get_login_info').length === 1)
ok('登录信息被打进日志（连的是哪个号看得见）', logged(/已登录：demo-bot（123456789）/), logs.join(''))
ok('暴露了 onebot 服务（别的插件能用）', Boolean(harness.provided.onebot?.sendGroupMsg))
ok('服务里有 stats', typeof harness.provided.onebot.stats === 'function')

// ---------------------------------------------------------------------
console.log('\n— 群消息：@ 我 → 一轮对话 → 带引用的回复 —')
responses.send_group_msg = () => ({ status: 'ok', retcode: 0, data: { message_id: 5001 } })
responses.get_group_member_list = () => ({
  status: 'ok',
  retcode: 0,
  data: [{ user_id: ALICE, nickname: 'alice', card: '爱丽丝', role: 'member' }, { user_id: BOB, nickname: 'bob', role: 'member' }],
})

const groupAt = {
  time: 1712345678,
  self_id: 123456789,
  post_type: 'message',
  message_type: 'group',
  sub_type: 'normal',
  message_id: 1001,
  group_id: 987654321,
  user_id: 111222333,
  raw_message: '[CQ:at,qq=123456789] 早上好',
  message: [{ type: 'at', data: { qq: '123456789' } }, { type: 'text', data: { text: ' 早上好' } }],
  sender: { user_id: 111222333, nickname: 'alice', card: '爱丽丝', role: 'member' },
}
sockets[0].emit('message', { data: JSON.stringify(groupAt) })
await until(() => FakeSocket.callsOf('send_group_msg').length === 1, '第一条回复')

eq('建了一个会话', harness.created.length, 1)
eq('这一轮投了一条给 agent', harness.created[0].agent.messages.length, 1)
ok('投出去的是 user 消息', harness.created[0].agent.messages[0].role === 'user')
const delivered = harness.created[0].agent.messages[0]
ok('投给 agent 的是文字块', delivered.content[0].type === 'text', JSON.stringify(delivered.content))
ok('信封里有群、时间、谁', /^【群987654321 · \d\d:\d\d】爱丽丝\(QQ 111222333\)$/m.test(delivered.content[0].text), delivered.content[0].text)
ok('信封里有正文', delivered.content[0].text.includes('早上好'), delivered.content[0].text)
ok('@ 我的码变成了人话', delivered.content[0].text.includes('[在 @ 你]'), delivered.content[0].text)

const sentParams = FakeSocket.callsOf('send_group_msg')[0].params
eq('发给的是那个群', sentParams.group_id, Number(GROUP))
ok('message 是消息段数组', Array.isArray(sentParams.message), JSON.stringify(sentParams.message))
jok('第一段是引用（引用触发它的那条）', sentParams.message[0], { type: 'reply', data: { id: '1001' } })
eq(
  '正文是助手最后那段（工具调用之前的碎话被切掉了）',
  sentParams.message
    .filter((s) => s.type === 'text')
    .map((s) => s.data.text)
    .join(''),
  '收到啦～',
)
ok('日志里写着已回复', logged(/已回复 group:987654321/))

// ---------------------------------------------------------------------
console.log('\n— 该拦的必须拦：回声 / 没 @ 我 / 陌生私聊 —')
const sentBefore = FakeSocket.callsOf('send_group_msg').length
const sessionsBefore = harness.created.length

// ① 自己发出去的消息被回推（user_id == self_id）
sockets[0].emit('message', { data: JSON.stringify({ ...groupAt, message_id: 1002, user_id: 123456789, sender: { user_id: 123456789, nickname: 'bot' } }) })
// ② post_type=message_sent（另一种回声长相）
sockets[0].emit('message', { data: JSON.stringify({ ...groupAt, message_id: 1003, post_type: 'message_sent', user_id: 123456789 }) })
// ③ 群里没 @ 我
sockets[0].emit('message', { data: JSON.stringify({ ...groupAt, message_id: 1004, message: '[CQ:at,qq=444555666] 你看看', raw_message: '[CQ:at,qq=444555666] 你看看' }) })
// ④ 私聊白名单外的人（users: [ALICE]，这条是 BOB）
sockets[0].emit('message', { data: JSON.stringify({ post_type: 'message', message_type: 'private', message_id: 1005, user_id: 444555666, self_id: 123456789, message: '在吗', raw_message: '在吗', sender: { user_id: 444555666, nickname: 'bob' } }) })
// ⑤ @ 全体（不是 @ 我）
sockets[0].emit('message', { data: JSON.stringify({ ...groupAt, message_id: 1006, message: '[CQ:at,qq=all] 都来看看', raw_message: '[CQ:at,qq=all] 都来看看' }) })
await sleep(80)

eq('回声/没@我/陌生私聊 都没有新建会话', harness.created.length, sessionsBefore)
eq('也没有发出去任何消息', FakeSocket.callsOf('send_group_msg').length, sentBefore)
ok('日志里说清了回声不派发', logged(/不派发： 自己发出去的消息（回声）/), logs.join(''))
ok('stats 记下了被跳过的那几条', harness.provided.onebot.stats().skipped >= 4, JSON.stringify(harness.provided.onebot.stats()))

// 私聊（白名单里那位）→ 要派发，而且和群是两个不同的会话
sockets[0].emit('message', { data: JSON.stringify({ post_type: 'message', message_type: 'private', message_id: 2001, user_id: 111222333, self_id: 123456789, message: '在吗', raw_message: '在吗', sender: { user_id: 111222333, nickname: 'alice' } }) })
await until(() => FakeSocket.callsOf('send_private_msg').length === 1, '私聊回复')
eq('私聊回了白名单里的人', FakeSocket.callsOf('send_private_msg')[0].params.user_id, Number(ALICE))
eq('私聊用了另一个会话（同一个 key 才复用）', harness.created.length, sessionsBefore + 1)

// ---------------------------------------------------------------------
console.log('\n— 引用展开：本地没有就 get_msg 捞 —')
let getMsgAsked = 0
responses.get_msg = () => {
  getMsgAsked += 1
  return {
    status: 'ok',
    retcode: 0,
    data: {
      message_id: 8001,
      user_id: 444555666,
      time: 1712345000,
      sender: { user_id: 444555666, nickname: 'bob' },
      message: [{ type: 'image', data: { file: 'c.png' } }],
    },
  }
}
sockets[0].emit('message', {
  data: JSON.stringify({
    ...groupAt,
    message_id: 1007,
    message: [{ type: 'reply', data: { id: '8001' } }, { type: 'at', data: { qq: '123456789' } }, { type: 'text', data: { text: ' 这图啥意思' } }],
    raw_message: '[CQ:reply,id=8001][CQ:at,qq=123456789] 这图啥意思',
  }),
})
await until(() => harness.created[0].agent.messages.length === 2, '第二条投递')
ok('本地没有那条 → 调了 get_msg', getMsgAsked === 1, `asked=${getMsgAsked}`)
const secondText = harness.created[0].agent.messages[1].content[0].text
ok('信封里贴出了被引用的那条（人话化的）', secondText.includes('↩ 回复 bob(QQ 444555666)：「（图）」'), secondText)
ok('引用那行不是 CQ 码', !secondText.includes('[CQ:'), secondText)

// ---------------------------------------------------------------------
console.log('\n— 发送失败（retcode≠0）不能把插件弄死 —')
responses.send_group_msg = () => ({ status: 'failed', retcode: 100, wording: 'SEND_MSG_API_ERROR' })
const errorsBefore = harness.provided.onebot.stats().errors
sockets[0].emit('message', { data: JSON.stringify({ ...groupAt, message_id: 1008 }) })
await until(() => harness.provided.onebot.stats().errors > errorsBefore, '记下发送失败')
ok('发送失败记进了 errors', harness.provided.onebot.stats().errors > errorsBefore)
ok('日志里写明了 retcode', logged(/回复失败：.*retcode=100/))

responses.send_group_msg = () => ({ status: 'ok', retcode: 0, data: { message_id: 5002 } })
const okBefore = FakeSocket.callsOf('send_group_msg').length
sockets[0].emit('message', { data: JSON.stringify({ ...groupAt, message_id: 1009 }) })
await until(() => FakeSocket.callsOf('send_group_msg').length > okBefore, '失败之后还能发')
ok('失败之后照样能继续收发', FakeSocket.callsOf('send_group_msg').length > okBefore)

// ---------------------------------------------------------------------
console.log('\n— 同会话两条消息 → 两条回复（串行队列）—')
const before = FakeSocket.callsOf('send_group_msg').length
const followupsBefore = harness.created[0].agent.messages.length
sockets[0].emit('message', { data: JSON.stringify({ ...groupAt, message_id: 1101 }) })
sockets[0].emit('message', { data: JSON.stringify({ ...groupAt, message_id: 1102, user_id: 444555666, sender: { user_id: 444555666, nickname: 'bob' } }) })
await until(() => FakeSocket.callsOf('send_group_msg').length >= before + 2, '两条回复')
eq('两条消息各得一条回复（不会合成一条）', FakeSocket.callsOf('send_group_msg').length, before + 2)
eq('两条都投给了同一个会话', harness.created[0].agent.messages.length, followupsBefore + 2)
jok(
  '每条回复引用的是它自己触发的那条',
  FakeSocket.callsOf('send_group_msg')
    .slice(-2)
    .map((c) => c.params.message[0].data.id),
  ['1101', '1102'],
)

// ---------------------------------------------------------------------
console.log('\n— 断线重连（时间注入，不真等）—')
const socketsBefore = sockets.length
const sleepsBefore = sleeps.length
FakeSocket.last().emit('open')
await tick()
FakeSocket.last().emit('close', { code: 1006 })
await sleep(30)
eq('断线之后按退避重连了一次', sockets.length, socketsBefore + 1)
jok('第一次重连等了 baseMs', sleeps.slice(sleepsBefore), [100])
ok('日志里写了重连', logged(/后重连（第 1 次）/))

// 再抖一次：延迟应该翻倍
FakeSocket.last().emit('open')
await tick()
FakeSocket.last().emit('close', { code: 1006 })
await sleep(30)
jok('第二次重连翻倍（退避递增）', sleeps.slice(sleepsBefore), [100, 200])

// 重连之后照样能收发
FakeSocket.last().emit('open')
await tick()
const afterReconnect = FakeSocket.callsOf('send_group_msg').length
FakeSocket.last().emit('message', { data: JSON.stringify({ ...groupAt, message_id: 1201 }) })
await until(() => FakeSocket.callsOf('send_group_msg').length > afterReconnect, '重连后再回一条')
ok('重连之后还能正常回复', FakeSocket.callsOf('send_group_msg').length > afterReconnect)

// 日志收敛：抖很多次之后不该每次都打（服务端挂半小时不能把日志刷爆）
const logCountBefore = logs.filter((l) => /后重连/.test(l)).length
for (let i = 0; i < 6; i++) {
  FakeSocket.last().emit('close', { code: 1006 })
  await sleep(20)
}
const newReconnectLogs = logs.filter((l) => /后重连/.test(l)).length - logCountBefore
ok('连续抖动时日志被收敛（不是每次都打）', newReconnectLogs < 6, `打了 ${newReconnectLogs} 行`)

// ---------------------------------------------------------------------
console.log('\n— 只配 http（能发不能收）也要能起来 —')
const socketsBeforeHttp = sockets.length
const httpCalls = []
const fakeFetch = async (url, init) => {
  httpCalls.push({ url, init })
  return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 6001 } }) }
}
const httpHarness = makeCtx()
apply(httpHarness.ctx, {
  http: 'http://127.0.0.1:3000',
  accessToken: 'demo-token',
  fetch: fakeFetch,
  selfId: SELF,
})
eq('只配 http 时不建 WebSocket', sockets.length, socketsBeforeHttp)
ok('日志里说清了「能发不能收」', logged(/只配了 http：能发不能收/), logs.join(''))
ok('照样暴露 onebot 服务', Boolean(httpHarness.provided.onebot?.sendGroupMsg))
const httpMsgId = await httpHarness.provided.onebot.sendGroupMsg(GROUP, [{ text: '嗨 ' }, { at: ALICE }])
eq('HTTP 通道真的发出了消息', httpMsgId, '6001')
eq('打的是 /send_group_msg', httpCalls[0].url, 'http://127.0.0.1:3000/send_group_msg')
eq('带上了 Bearer token', httpCalls[0].init.headers.Authorization, 'Bearer demo-token')
jok('消息段构造正确', JSON.parse(httpCalls[0].init.body).message, [
  { type: 'text', data: { text: '嗨 ' } },
  { type: 'at', data: { qq: ALICE } },
])
for (const cleanup of httpHarness.cleanups) cleanup()

// ---------------------------------------------------------------------
console.log('\n— 卸载 —')
for (const cleanup of harness.cleanups) cleanup()
await sleep(20)
const lastSocket = sockets[sockets.length - 1]
ok('卸载时关了连接', lastSocket.closedByUs)
ok('卸载时释放了所有会话', harness.created.every((c) => c.agent.disposed))

process.stderr.write = realWrite

console.log('')
if (fails.length) {
  console.log(`✗ ${pass} 项通过，${fails.length} 项失败：`)
  for (const f of fails) console.log(`   ✗ ${f}`)
  process.exitCode = 1
} else {
  console.log(`✓ 全部通过（${pass} 项）`)
}
