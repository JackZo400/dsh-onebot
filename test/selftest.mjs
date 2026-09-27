/**
 * 协议层自检 —— 不联网、不起 dsh、不碰任何真实服务。
 *
 * 跑：`node test/selftest.mjs`
 *
 * 卷子都是**真实形态**的输入：OneBot 11 的上报 JSON（字符串版和数组版各一份）、
 * 一个假 fetch、一个假 WebSocket。覆盖 README「自检」那节列的 8 条。
 * 断言都是真断言 —— 任何一条不成立，脚本以非 0 退出。
 */
import {
  escapeCq,
  humanizeCq,
  messageToCq,
  normalizeSegments,
  parseCqString,
  segmentsToCq,
  unescapeCq,
} from '../src/cq.js'
import { parseOneBotEvent, renderEnvelope, sameMsgId, sanitizeOutgoing, shouldDispatch } from '../src/event.js'
import {
  buildOutgoingMessage,
  checkResponse,
  createApi,
  createBackoff,
  createHttpTransport,
  createWsTransport,
  idForApi,
  OneBotApiError,
  textToSegments,
} from '../src/api.js'
import { createMessageCache, createQuoteResolver, createSerialQueue, parseSessionKey, sessionKeyOf } from '../src/session.js'

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

const SELF = '123456789'
const GROUP = '987654321'
const ALICE = '111222333'
const BOB = '444555666'

// =====================================================================
console.log('\n— CQ 码 ↔ 消息段 —')

// ② 转义/反转义往返一致（含最容易写错的两个：逗号，和 & 的还原顺序）
for (const sample of ['a,b[c]&d', '&#91;字面量&#93;', '普通一句话', '&amp;', '1,2,3', '【】']) {
  eq(`往返一致：${JSON.stringify(sample)}`, unescapeCq(escapeCq(sample)), sample)
}
eq('逗号被转义（不然参数会被截断）', escapeCq('a,b'), 'a&#44;b')
eq('& 最后还原，不会把 &#91; 拆坏', unescapeCq('&amp;#91;'), '&#91;')

// ① 字符串与数组两种长相 → 同样的内部结构
const cqString = '[CQ:at,qq=123456789] 早上好 [CQ:image,file=a.jpg] 这个什么意思'
const segArray = [
  { type: 'at', data: { qq: 123456789 } },
  { type: 'text', data: { text: ' 早上好 ' } },
  { type: 'image', data: { file: 'a.jpg' } },
  { type: 'text', data: { text: ' 这个什么意思' } },
]
jok('CQ 字符串解析结果', normalizeSegments(cqString), normalizeSegments(segArray))
eq('两种长相的人话化也一样', humanizeCq(cqString, { selfId: SELF }), humanizeCq(segArray, { selfId: SELF }))
eq('@ 我的码变成「在 @ 你」', humanizeCq('[CQ:at,qq=123456789] 在吗', { selfId: SELF }), '[在 @ 你] 在吗')
eq('@全体 单独说', humanizeCq('[CQ:at,qq=all] 集合', { selfId: SELF }), '@全体成员 集合')
eq('图 / 语音 / 卡片都有词', humanizeCq('[CQ:image,file=x.jpg][CQ:record,file=y.amr][CQ:json,data=z]'), '（图）[语音][卡片]')
eq('生码兜底（以后新类型也别把码喂给模型）', humanizeCq('[CQ:unknown_thing,a=1]'), '[unknown_thing]')

// 有的实现会把「数组」JSON 序列化成字符串塞进 message 字段
const jsonStringForm = JSON.stringify([{ type: 'text', data: { text: '嗯' } }, { type: 'image', data: { file: 'b.png' } }])
jok('JSON 字符串形态也认', normalizeSegments(jsonStringForm), [
  { type: 'text', data: { text: '嗯' } },
  { type: 'image', data: { file: 'b.png' } },
])
// 但普通文字以 [ 开头时不能被当成 JSON 吃掉
jok('以 [ 开头的普通文字不被误判', normalizeSegments('[图片]你发的'), [{ type: 'text', data: { text: '[图片]你发的' } }])

eq('CQ 里的转义文字还原回来（码外面的文字也要反转义）', parseCqString('[CQ:at,qq=1]a&#44;b')[1].data.text, 'a,b')
eq('码 → 字面量 → 码 一圈不变', messageToCq('[CQ:face,id=14][CQ:image,file=a.jpg]'), '[CQ:face,id=14][CQ:image,file=a.jpg]')

// =====================================================================
console.log('\n— 事件解析 / @ 我 / 回声 —')

const groupAtArray = {
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
const groupAtString = { ...groupAtArray, message: '[CQ:at,qq=123456789] 早上好' }
const groupNoAt = { ...groupAtArray, message: '[CQ:at,qq=444555666] 你看看', raw_message: '[CQ:at,qq=444555666] 你看看', message_id: 1002 }
const groupAtAll = { ...groupAtArray, message: '[CQ:at,qq=all] 都来看看', raw_message: '[CQ:at,qq=all] 都来看看', message_id: 1003 }
const selfEcho = { ...groupAtArray, user_id: 123456789, message_id: 1004, sender: { user_id: 123456789, nickname: 'bot' } }
const selfSent = { ...selfEcho, post_type: 'message_sent', message_id: 1005 }
const privateMsg = {
  time: 1712345700,
  self_id: 123456789,
  post_type: 'message',
  message_type: 'private',
  sub_type: 'friend',
  message_id: 2001,
  user_id: 111222333,
  message: '你好',
  raw_message: '你好',
  sender: { user_id: 111222333, nickname: 'alice' },
}
const noticeEvent = { time: 1712345701, self_id: 123456789, post_type: 'notice', notice_type: 'notify', target_id: 1 }

const opts = { selfIds: [SELF], groups: [], private: true, users: [] }
const pArray = parseOneBotEvent(groupAtArray, opts)
const pString = parseOneBotEvent(groupAtString, opts)
eq('数组版的 @我 判定', pArray.message.atMe, true)
eq('字符串版的 @我 判定', pString.message.atMe, true)
eq('两种长相的会话 key 一致', pString.message.key, 'group:987654321')
eq('会话 key 里带的是群号', sessionKeyOf(pArray.message), `group:${GROUP}`)
eq('群名片优先当名字', pArray.message.name, '爱丽丝')
eq('引用 id 从 reply 段里抠出来（数组版）', parseOneBotEvent({ ...groupAtArray, message: [...groupAtArray.message, { type: 'reply', data: { id: '1001' } }] }, opts).message.quoteId, '1001')
eq('引用 id 从 CQ 码里抠出来（字符串版）', parseOneBotEvent({ ...groupAtArray, message: '[CQ:reply,id=-1234567890][CQ:at,qq=123456789] 这句什么意思' }, opts).message.quoteId, '-1234567890')

eq('只 @ 别人 → 不算 @我', parseOneBotEvent(groupNoAt, opts).message.atMe, false)
eq('@全体 → 不算 @我', parseOneBotEvent(groupAtAll, opts).message.atMe, false)
eq('@别人 的消息不派发', shouldDispatch(parseOneBotEvent(groupNoAt, opts).message, { requireMention: true }).ok, false)
ok(
  '不派发时给得出原因',
  /@/.test(shouldDispatch(parseOneBotEvent(groupNoAt, opts).message, { requireMention: true }).reason),
  shouldDispatch(parseOneBotEvent(groupNoAt, opts).message, { requireMention: true }).reason,
)

// ④ 自己发的消息：两种长相都不能派发
eq('user_id == self_id → 标成自己发的', parseOneBotEvent(selfEcho, opts).message.self, true)
eq('post_type=message_sent → 标成自己发的', parseOneBotEvent(selfSent, opts).message.self, true)
eq('回声不派发', shouldDispatch(parseOneBotEvent(selfEcho, opts).message, {}).ok, false)
eq('回声不派发的理由说得清', shouldDispatch(parseOneBotEvent(selfEcho, opts).message, {}).reason, '自己发出去的消息（回声）')
eq('message_sent 也不派发', shouldDispatch(parseOneBotEvent(selfSent, opts).message, {}).ok, false)
eq('别人说话照常派发', shouldDispatch(pArray.message, {}).ok, true)
eq('私聊不需要 @', parseOneBotEvent(privateMsg, opts).message.atMe, true)
eq('私聊默认关（private: false 时直接忽略）', parseOneBotEvent(privateMsg, { ...opts, private: false }).kind, 'ignored')
eq('群不在白名单 → 忽略', parseOneBotEvent(groupAtArray, { ...opts, groups: ['123'] }).kind, 'ignored')
eq('私聊用户不在白名单 → 忽略', parseOneBotEvent(privateMsg, { ...opts, users: ['123'] }).kind, 'ignored')
eq('notice 事件不处理（有原因）', /通知/.test(parseOneBotEvent(noticeEvent, opts).reason), true)
eq('心跳/元事件安静丢掉', parseOneBotEvent({ post_type: 'meta_event', meta_event_type: 'heartbeat' }, opts).kind, 'meta_event')
eq('没有 post_type 的响应帧不当消息', parseOneBotEvent({ status: 'ok', retcode: 0, data: {} }, opts).kind, 'response')
eq('requireMention: false 时群里不 @ 也派发', shouldDispatch(parseOneBotEvent(groupNoAt, opts).message, { requireMention: false }).ok, true)
eq('群消息 id 负号不影响比对', sameMsgId('-1234567890', '1234567890'), true)
eq('不同 id 不会撞上', sameMsgId('1001', '1002'), false)

eq('群消息的文本是纯文字部分', pArray.message.text, '早上好')

// 信封（给模型看的样子）：@我、引用、正文都在
const rendered = renderEnvelope(pArray.message, { selfId: SELF, atName: () => '爱丽丝', tz: 'Asia/Shanghai' })
ok('信封第一行是在哪/谁', /^【群987654321 · \d\d:\d\d】爱丽丝\(QQ 111222333\)$/m.test(rendered.split('\n')[0]), rendered.split('\n')[0])
ok('信封里有正文', rendered.includes('早上好'), rendered)
const renderedQuote = renderEnvelope(pArray.message, {
  selfId: SELF,
  quote: { who: 'bob(QQ 444555666)', segments: [{ type: 'image', data: { file: 'a.jpg' } }] },
})
ok('引用那一行是人话（不是 CQ 码）', renderedQuote.includes('↩ 回复 bob(QQ 444555666)：「（图）」'), renderedQuote)
ok('引用没拿到时如实说', renderEnvelope(pArray.message, { quoteMissing: true }).includes('原文我这边没拿到'), '')
ok('出去的话里模型自己写的 CQ 码被抹掉', sanitizeOutgoing('你好[CQ:at,qq=123456789]呀\n\n\n\n再说一句') === '你好呀\n\n再说一句', sanitizeOutgoing('你好[CQ:at,qq=123456789]呀\n\n\n\n再说一句'))

// =====================================================================
console.log('\n— 引用（本地缓存 + get_msg 兜底）—')

const cache = createMessageCache({ max: 3 })
cache.remember(`group:${GROUP}`, { id: '-1234567890', who: 'alice(QQ 111222333)', segments: [{ type: 'text', data: { text: '来一张' } }] })
eq('本地缓存能按 id 查到（负号也无所谓）', cache.lookup(`group:${GROUP}`, '1234567890').segments[0].data.text, '来一张')

let getMsgCalls = 0
const fakeApi = {
  async getMsg(id) {
    getMsgCalls++
    return {
      message_id: id,
      user_id: BOB,
      sender: { nickname: 'bob' },
      time: 1712345678,
      message: [{ type: 'text', data: { text: '这个表情包什么意思' } }],
    }
  },
}
const resolver = createQuoteResolver({ api: fakeApi, cache, log: () => {}, selfIds: [SELF] })
const fromApi = await resolver.resolve(`group:${GROUP}`, '2002')
eq('本地没有就用 get_msg 捞', fromApi.segments[0].data.text, '这个表情包什么意思')
eq('捞回来的 who 是「昵称(QQ 号)」', fromApi.who, 'bob(QQ 444555666)')
eq('捞回来的原文能人话化', humanizeCq(fromApi.segments, { selfId: SELF }), '这个表情包什么意思')
await resolver.resolve(`group:${GROUP}`, '2002')
eq('同一条 5 分钟内只捞一次（不把接口打成风暴）', getMsgCalls, 1)
const selfResolver = createQuoteResolver({
  api: { async getMsg() { return { message_id: 1, user_id: SELF, sender: { nickname: 'bot' }, message: '我说的' } } },
  log: () => {},
  selfIds: [SELF],
})
eq('自己发的被引用时 who=我自己', (await selfResolver.resolve('group:1', '1')).who, '我自己')
const cached = await resolver.resolve(`group:${GROUP}`, '-1234567890')
eq('本地缓存命中时不打接口', cached.who, 'alice(QQ 111222333)')

// =====================================================================
console.log('\n— 发送构造（text + at + image 混合）—')

const mixed = buildOutgoingMessage(
  [{ text: '嗨 ' }, { at: ALICE }, { image: 'https://example.com/a.png' }, { text: ' 看这个' }],
  { replyTo: '1001' },
)
jok('reply 段被挪到最前面，其余顺序不变', mixed, [
  { type: 'reply', data: { id: '1001' } },
  { type: 'text', data: { text: '嗨 ' } },
  { type: 'at', data: { qq: ALICE } },
  { type: 'image', data: { file: 'https://example.com/a.png', url: 'https://example.com/a.png' } },
  { type: 'text', data: { text: ' 看这个' } },
])
eq(
  'format=string 时编成 CQ 码',
  buildOutgoingMessage('嗨', { replyTo: '1001', format: 'string' }),
  '[CQ:reply,id=1001]嗨',
)
const withMention = buildOutgoingMessage('@123456789 在吗', {})
jok('正文里裸写的 @号码 变成真 at 段', withMention, [
  { type: 'at', data: { qq: '123456789' } },
  { type: 'text', data: { text: ' 在吗' } },
])
eq('邮箱不会被误当成 @', textToSegments('a@163.com').length, 1)
eq('紧贴着字母的 @ 不拆', textToSegments('x@123456789').length, 1)
eq('长号码不拆（不是 QQ 号）', textToSegments('@1234567890123').length, 1)
eq('id 是数字就发数字', idForApi('987654321'), 987654321)
eq('负的 message_id 也发数字', idForApi('-1234567890'), -1234567890)
eq('超长数字原样发字符串（别丢精度）', idForApi('12345678901234567890'), '12345678901234567890')
jok('face / record 简写也认', buildOutgoingMessage([{ face: '14' }, { record: 'file:///tmp/a.amr' }], {}), [
  { type: 'face', data: { id: '14' } },
  { type: 'record', data: { file: 'file:///tmp/a.amr' } },
])
jok('已经是 {type,data} 的原样透传', buildOutgoingMessage([{ type: 'text', data: { text: '嗯' } }], {}), [
  { type: 'text', data: { text: '嗯' } },
])

// =====================================================================
console.log('\n— API 错误路径（假 fetch）—')

const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 42 } }) })
const apiOk = createApi(createHttpTransport({ baseUrl: 'http://127.0.0.1:3000/', accessToken: 'demo-token', fetchImpl: okFetch, timeoutMs: 200 }))
eq('正常路径拿到 message_id', await apiOk.sendGroupMsg(GROUP, '你好'), '42')

let seenRequest
const spyFetch = async (url, init) => {
  seenRequest = { url, init }
  return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) }
}
const apiSpy = createApi(createHttpTransport({ baseUrl: 'http://127.0.0.1:3000', accessToken: 'demo-token', fetchImpl: spyFetch, timeoutMs: 200 }))
await apiSpy.sendPrivateMsg(ALICE, '私聊一句')
eq('token 走 Authorization: Bearer', seenRequest.init.headers.Authorization, 'Bearer demo-token')
eq('地址就是 /send_private_msg（尾部斜杠不会变双斜杠）', seenRequest.url, 'http://127.0.0.1:3000/send_private_msg')
eq('user_id 发的是数字（有些实现只认数字）', JSON.parse(seenRequest.init.body).user_id, Number(ALICE))

const retcodeFetch = async () => ({ ok: true, status: 200, json: async () => ({ status: 'failed', retcode: 100, wording: 'SEND_MSG_API_ERROR' }) })
try {
  await createApi(createHttpTransport({ baseUrl: 'http://x', fetchImpl: retcodeFetch, timeoutMs: 200 })).sendGroupMsg(GROUP, 'hi')
  ok('retcode≠0 必须抛错', false, '没抛')
} catch (e) {
  ok('retcode≠0 抛的是 OneBotApiError', e instanceof OneBotApiError, String(e))
  eq('错误里带着 retcode', e.retcode, 100)
  ok('错误里带着实现给的原文', /SEND_MSG_API_ERROR/.test(e.message), e.message)
}

const http500 = async () => ({ ok: false, status: 500, text: async () => 'internal error' })
try {
  await createApi(createHttpTransport({ baseUrl: 'http://x', fetchImpl: http500, timeoutMs: 200 })).sendGroupMsg(GROUP, 'hi')
  ok('HTTP 500 必须抛错', false, '没抛')
} catch (e) {
  ok('HTTP 失败的错误里带状态码和 body', /HTTP 500/.test(e.message) && /internal error/.test(e.message), e.message)
}

const brokenNet = async () => {
  throw new Error('fetch failed: ECONNREFUSED')
}
try {
  await createApi(createHttpTransport({ baseUrl: 'http://127.0.0.1:1', fetchImpl: brokenNet, timeoutMs: 200 })).getMsg('1')
  ok('连不上必须抛错', false, '没抛')
} catch (e) {
  ok('连不上的错误说清是哪个地址', /调用 http:\/\/127\.0\.0\.1:1 失败/.test(e.message) && /ECONNREFUSED/.test(e.message), e.message)
}

// 超时：假 fetch 永不 resolve，只有 abort 时才 reject —— 20ms 后应该自己认输
const hangFetch = (url, init) =>
  new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')))
  })
try {
  await createApi(createHttpTransport({ baseUrl: 'http://x', fetchImpl: hangFetch, timeoutMs: 20 })).sendGroupMsg(GROUP, 'hi')
  ok('超时必须抛错', false, '没抛')
} catch (e) {
  ok('超时的错误里写着超时', /超时（20ms）/.test(e.message), e.message)
}

// checkResponse 的边界：没有 retcode/status 的实现按成功处理；不是对象就报错
eq('没有 retcode 的响应按成功（少数实现这样）', checkResponse({ data: { message_id: 7 } }, 'get_msg').message_id, 7)
try {
  checkResponse('ok', 'get_msg')
  ok('非对象响应要抛错', false, '没抛')
} catch (e) {
  ok('非对象响应抛错', e instanceof OneBotApiError, String(e))
}

// =====================================================================
console.log('\n— 断线重连（退避递增、时间可注入）—')

const backoff = createBackoff({ baseMs: 100, maxMs: 800, factor: 2, jitter: 0 })
const delays = [backoff.next(), backoff.next(), backoff.next(), backoff.next(), backoff.next(), backoff.next()]
jok('退避序列递增且封顶', delays, [100, 200, 400, 800, 800, 800])
const jittered = createBackoff({ baseMs: 1000, maxMs: 1000, factor: 2, jitter: 0.5, random: () => 0 })
eq('抖动下限 = 延迟 ×(1-jitter)', jittered.next(), 500)
const jitteredHigh = createBackoff({ baseMs: 1000, maxMs: 1000, factor: 2, jitter: 0.5, random: () => 1 })
eq('抖动上限 = 延迟 ×(1+jitter)，且不超过 maxMs', jitteredHigh.next(), 1000)

/** 假 WebSocket：只实现 transport 用到的那几个方法 */
class FakeSocket {
  static instances = []
  constructor(url, protocols, options) {
    this.url = url
    this.protocols = protocols
    this.options = options
    this.sent = []
    this.listeners = new Map()
    this.closedByUs = false
    FakeSocket.instances.push(this)
  }
  addEventListener(ev, fn) {
    const arr = this.listeners.get(ev) ?? []
    arr.push(fn)
    this.listeners.set(ev, arr)
  }
  emit(ev, payload) {
    for (const fn of this.listeners.get(ev) ?? []) fn(payload)
  }
  send(data) {
    this.sent.push(data)
  }
  close() {
    this.closedByUs = true
    this.emit('close', { code: 1000 })
  }
  /** 假装服务端回了一个成功的响应 */
  reply(echo, data = {}) {
    this.emit('message', { data: JSON.stringify({ status: 'ok', retcode: 0, data, echo }) })
  }
}

const sleeps = []
const wsEvents = []
const ws = createWsTransport({
  url: 'ws://127.0.0.1:3001',
  accessToken: 'demo-token',
  WebSocketImpl: FakeSocket,
  timeoutMs: 100,
  readyTimeoutMs: 100,
  onEvent: (e) => wsEvents.push(e),
  log: () => {},
  backoff: createBackoff({ baseMs: 100, maxMs: 400, factor: 2, jitter: 0 }),
  sleep: (ms) => {
    sleeps.push(ms)
    return Promise.resolve()
  },
  quietAfter: 2,
})
ws.start()
eq('连接地址带上了 access_token（且不改动原路径）', FakeSocket.instances[0].url, 'ws://127.0.0.1:3001?access_token=demo-token')
FakeSocket.instances[0].emit('open')
eq('连上之后 state 是 connected', ws.state().connected, true)

// 事件从 socket 进来 → 交给 onEvent；响应帧按 echo 配对，不会当成事件
FakeSocket.instances[0].emit('message', { data: JSON.stringify({ post_type: 'message', message_type: 'private', user_id: ALICE, message: '你好' }) })
eq('socket 里的事件被转出来了', wsEvents.length, 1)
const callPromise = ws.call('send_group_msg', { group_id: 1, message: 'x' })
await tick() // call() 里有一次 await，发出去是在下一个微任务
const frame = JSON.parse(FakeSocket.instances[0].sent[0])
eq('调用带上了 action / params / echo', frame.action === 'send_group_msg' && Boolean(frame.echo), true)
FakeSocket.instances[0].reply(frame.echo, { message_id: 99 })
eq('echo 配对的响应拿到了 data', (await callPromise).message_id, 99)

// 断线 → 退避重连（sleep 是注入的，所以一秒都没真等）
FakeSocket.instances[0].emit('close', { code: 1006 })
await tick()
await tick()
jok('第一次重连的等待时间', sleeps, [100])
eq('重连真的又建了连接', FakeSocket.instances.length, 2)
FakeSocket.instances[1].emit('open')
FakeSocket.instances[1].emit('close', { code: 1006 })
await tick()
await tick()
jok('第二次重连等待更长（退避）', sleeps, [100, 200])
FakeSocket.instances[2].emit('close', { code: 1006 })
await tick()
await tick()
jok('第三次继续翻倍', sleeps, [100, 200, 400])

// 稳了一会儿再断 → 退避清零（新的一次故障从最短延迟重来）
let fakeNow = 0
const wsStable = createWsTransport({
  url: 'ws://127.0.0.1:3003',
  WebSocketImpl: FakeSocket,
  timeoutMs: 100,
  readyTimeoutMs: 100,
  onEvent: () => {},
  log: () => {},
  backoff: createBackoff({ baseMs: 100, maxMs: 400, factor: 2, jitter: 0 }),
  sleep: (ms) => {
    sleeps.push(ms)
    return Promise.resolve()
  },
  stableMs: 30_000,
  now: () => fakeNow,
})
const stableSocketStart = FakeSocket.instances.length
const sleepBase = sleeps.length
wsStable.start()
FakeSocket.instances[stableSocketStart].emit('open')
FakeSocket.instances[stableSocketStart].emit('close', { code: 1006 })
await tick()
await tick()
FakeSocket.instances[stableSocketStart + 1].emit('open')
fakeNow = 60_000 // 假装这根连接已经稳了一分钟
FakeSocket.instances[stableSocketStart + 1].emit('close', { code: 1006 })
await tick()
await tick()
// 不重置的话第二次会是 200；清零了才会又是 100
jok('闪断退避递增，稳定连接之后才清零', sleeps.slice(sleepBase), [100, 100])
wsStable.close()

// 关掉之后不许再重连
const before = FakeSocket.instances.length
ws.close()
await tick()
await tick()
eq('close() 之后不再重连', FakeSocket.instances.length, before)
eq('close() 之后 state 是断开', ws.state().connected, false)

// 调用超时（服务端不回）也要能抛出来
const ws2 = createWsTransport({
  url: 'ws://127.0.0.1:3002',
  WebSocketImpl: FakeSocket,
  timeoutMs: 20,
  readyTimeoutMs: 100,
  onEvent: () => {},
  log: () => {},
  autoReconnect: false,
})
ws2.start()
FakeSocket.instances[FakeSocket.instances.length - 1].emit('open')
try {
  await ws2.call('send_group_msg', {})
  ok('WS 调用超时要抛错', false, '没抛')
} catch (e) {
  ok('WS 调用超时的错误里写着超时', /超时/.test(e.message), e.message)
}
ws2.close()

// =====================================================================
console.log('\n— 会话 key / 串行队列 —')

eq('私聊 key', sessionKeyOf({ scope: 'private', userId: ALICE }), `private:${ALICE}`)
jok('key 解析回来', parseSessionKey(`group:${GROUP}`), { scope: 'group', id: GROUP })
jok('不认识的 key 不炸', parseSessionKey('weird'), { scope: 'unknown', id: 'weird' })

const order = []
const q = createSerialQueue({ log: () => {}, timeoutMs: 0, maxQueue: 2 })
const r1 = q.run('k', async () => {
  order.push('a1')
  await tick()
  order.push('a2')
})
const r2 = q.run('k', async () => {
  order.push('b')
})
const r3 = q.run('k', async () => {
  order.push('c')
})
const r4 = q.run('k', async () => {
  order.push('d')
})
await Promise.all([r1, r2, r3, r4])
eq('同会话串行（a 跑完才轮到 b）', order.join(','), 'a1,a2,b,c')
eq('队列满了会丢并返回 false', await r4, false)

const q2 = createSerialQueue({ log: () => {}, timeoutMs: 20 })
const started = []
const long = q2.run('k', async () => {
  started.push('long')
  await new Promise(() => {}) // 永远不结束（模拟 agent 卡住）
})
const after = q2.run('k', async () => {
  started.push('after')
})
await Promise.all([long, after])
eq('卡住的那条超时后，队列继续往下走', started.join(','), 'long,after')

// =====================================================================
console.log('')
if (fails.length) {
  console.log(`✗ ${pass} 项通过，${fails.length} 项失败：`)
  for (const f of fails) console.log(`   ✗ ${f}`)
  process.exitCode = 1
} else {
  console.log(`✓ 全部通过（${pass} 项）`)
}
