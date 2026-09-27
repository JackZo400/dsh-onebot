/**
 * OneBot 11 的 API 层：两种 transport（HTTP / 正向 WebSocket）+ 消息段构造。
 *
 * 为什么要两种都做：OneBot 11 的常见部署长得不一样 ——
 *   · 有的只开 HTTP API（`POST /send_group_msg`），事件走它自己的反向上报；
 *   · 有的开正向 WebSocket（我们当客户端连过去），事件和 API 都走这根 socket。
 * 上层（index.js / session.js）只认「call(action, params)」这一个口子，
 * 换 transport 不动业务代码。
 *
 * 三个真实坑：
 *   1. **回调式 API 会撒谎**。HTTP 返回 200 不代表发成功了 —— 失败信息在 body 的
 *      `retcode` / `status` 里（`retcode=100` 之类）。只看 HTTP 状态码的话，消息
 *      没发出去而日志里全是成功。所以每个响应都过 {@link checkResponse}。
 *   2. **WS 的响应要和请求配对**。同一根 socket 上并发好几个调用时，回包的顺序不
 *      保证；靠 `echo` 配对，超时就必须把 pending 清掉，不然内存里全是僵尸。
 *   3. **重连要退避，而且日志要收敛**。服务端没起来的时候 1 秒一次的日志能在半小时
 *      内刷爆磁盘 —— 所以延迟指数增长，且超过若干次之后只在 2 的幂次上报数。
 */

import { segmentsToCq } from './cq.js'

/** 能发出去的消息段类型（OneBot 11 的标准段 + 群/私聊都吃的几个）。 */
export const SEGMENT_TYPES = ['text', 'at', 'image', 'record', 'reply', 'face']

/** API 层的统一错误：调用方只需要看 `action` / `retcode`，别去猜 body 长什么样。 */
export class OneBotApiError extends Error {
  /**
   * @param {string} message
   * @param {{action?: string, retcode?: number, status?: string, wording?: string, code?: string}} [info]
   */
  constructor(message, info = {}) {
    super(message)
    this.name = 'OneBotApiError'
    this.action = info.action
    this.retcode = info.retcode
    this.status = info.status
    this.wording = info.wording
    this.code = info.code
  }
}

/**
 * OneBot 响应 → data，或者抛错。
 * 判定顺序是「status 说失败」或「retcode 非 0」都要当失败；两者都没有的实现（少数）
 * 就按成功处理，返回 `json.data`（可能是 undefined）。
 *
 * @param {unknown} json
 * @param {string} action
 * @returns {any}
 */
export function checkResponse(json, action) {
  if (!json || typeof json !== 'object') {
    throw new OneBotApiError(`${action}：返回的不是 JSON 对象`, { action })
  }
  const body = /** @type {Record<string, any>} */ (json)
  const status = body.status === undefined || body.status === null ? '' : String(body.status)
  const retcode = body.retcode === undefined || body.retcode === null ? undefined : Number(body.retcode)
  const failed = status === 'failed' || status === 'error' || (retcode !== undefined && retcode !== 0)
  if (failed) {
    const wording = body.wording ?? body.message ?? ''
    throw new OneBotApiError(
      `${action} 被拒绝：retcode=${retcode ?? status}${wording ? ` ${wording}` : ''}`,
      { action, retcode, status, wording: String(wording) },
    )
  }
  return body.data
}

/**
 * 指数退避 + 抖动。
 * @param {object} [options]
 * @param {number} [options.baseMs] 第一次重连等多久
 * @param {number} [options.maxMs] 上限（到了就一直是它，别再涨）
 * @param {number} [options.factor] 每次乘多少
 * @param {number} [options.jitter] 0~1：把延迟随机打散，避免多个实例同时重连砸服务端
 * @param {() => number} [options.random] 注入随机源（自检里要可复现）
 * @returns {{next: () => number, reset: () => void, attempt: () => number}}
 */
export function createBackoff(options = {}) {
  const { baseMs = 1000, maxMs = 60_000, factor = 2, jitter = 0, random = Math.random } = options
  let attempt = 0
  return {
    next() {
      const raw = Math.min(maxMs, baseMs * factor ** attempt)
      attempt += 1
      if (!jitter) return raw
      const spread = raw * jitter
      const value = raw - spread + 2 * spread * random()
      return Math.max(0, Math.round(Math.min(maxMs, value)))
    },
    reset() {
      attempt = 0
    },
    attempt() {
      return attempt
    },
  }
}

/** 数字型 id 就发数字（有些实现只认数字），非数字/超长原样发字符串 */
export function idForApi(id) {
  const s = String(id ?? '').trim()
  if (!s) return s
  // 允许负号：群消息 id 有的实现是负的（-1234567890 那种），发成字符串有的实现不认
  if (/^-?\d{1,15}$/.test(s)) return Number(s)
  return s
}

/** 文本里裸写的 `@123456` → 真正的 at 段。
 *
 *  为什么必须拆：**字符串**消息里的 `[CQ:at,qq=…]` 是码，会被实现解析；但**数组**
 *  消息里的 text 段是字面文本，`@123456` 就只是六个字符加一个 @，不会变成提醒。
 *  边界断言（前面不是字母/点/@/-，后面不是数字）是为了别误伤邮箱和长数字。 */
export function textToSegments(text) {
  const s = String(text ?? '')
  const out = []
  const re = /(?<![\w.@-])@(\d{5,12})(?!\d)/g
  let last = 0
  let m
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ type: 'text', data: { text: s.slice(last, m.index) } })
    out.push({ type: 'at', data: { qq: m[1] } })
    last = m.index + m[0].length
  }
  if (last < s.length) out.push({ type: 'text', data: { text: s.slice(last) } })
  if (!out.length) return s ? [{ type: 'text', data: { text: s } }] : []
  return out
}

/** 图片的三种给法：http(s) 直链 / base64 / 本地路径（实现自己去读） */
function imageData(value) {
  const v = String(value ?? '').trim()
  if (!v) return {}
  if (/^https?:\/\//i.test(v)) return { file: v, url: v }
  return { file: v }
}

/**
 * 混着写的一段一段 → 标准消息段数组。
 *
 * 接受三种写法（可以混在同一个数组里）：
 *   · 字符串 → text 段（里面的 `@数字` 会变成 at 段）
 *   · `{type, data}` → 直接过（想精确控制就用它）
 *   · `{text}` / `{at}` / `{image}` / `{record}` / `{face}` / `{reply}` → 简写
 *
 * **reply 段永远被挪到最前面** —— OneBot 的实现普遍要求引用段在首位，
 * 放中间的话有的实现会忽略它（发出去就是一条没有引用的消息，肉眼很难发现）。
 *
 * @param {unknown} parts
 * @returns {Array<{type: string, data: Record<string, unknown>}>}
 */
export function buildSegments(parts) {
  const list = Array.isArray(parts) ? parts : parts === undefined || parts === null ? [] : [parts]
  const out = []
  const replies = []
  const pushText = (text) => {
    const s = String(text ?? '')
    if (!s) return
    out.push(...textToSegments(s))
  }
  for (const item of list) {
    if (item === undefined || item === null) continue
    if (typeof item === 'string') {
      pushText(item)
      continue
    }
    if (typeof item !== 'object') continue
    if (typeof item.type === 'string' && item.type) {
      const seg = { type: item.type.toLowerCase(), data: { ...(item.data ?? {}) } }
      if (seg.type === 'reply') replies.push(seg)
      else out.push(seg)
      continue
    }
    if (item.reply !== undefined) replies.push({ type: 'reply', data: { id: String(item.reply) } })
    if (typeof item.text === 'string') pushText(item.text)
    if (item.at !== undefined) out.push({ type: 'at', data: { qq: String(item.at) } })
    if (item.image !== undefined) out.push({ type: 'image', data: imageData(item.image) })
    if (item.record !== undefined) out.push({ type: 'record', data: { file: String(item.record) } })
    if (item.face !== undefined) out.push({ type: 'face', data: { id: String(item.face) } })
  }
  return [...replies, ...out]
}

/**
 * 出去的一条消息 → 实现想要的格式。
 * @param {unknown} message 字符串（当正文）或消息段数组
 * @param {object} [options]
 * @param {string|number} [options.replyTo] 要引用的那条的 message_id
 * @param {'array'|'string'} [options.format] array（默认，最稳）或 string（CQ 码）
 * @returns {Array<object>|string}
 */
export function buildOutgoingMessage(message, options = {}) {
  const { replyTo, format = 'array' } = options
  const base = typeof message === 'string' ? textToSegments(message) : buildSegments(message)
  const segments = replyTo === undefined || replyTo === null || replyTo === '' ? base : buildSegments([{ reply: replyTo }, ...base])
  return format === 'string' ? segmentsToCq(segments) : segments
}

/** 默认的 socket 工厂：Node 22+ 有全局 WebSocket；没有就得由配置注入（见 README）。 */
function resolveWebSocketImpl(explicit) {
  if (explicit) return explicit
  const globalImpl = globalThis.WebSocket
  if (globalImpl) return globalImpl
  throw new Error(
    '没有可用的 WebSocket 实现：Node 22+ 自带全局 WebSocket；Node 18/20 请在配置里给 WebSocketImpl（例如从 ws 包传进来）' +
      '；或者只用 http 传输（那样只能发、收不到消息）。',
  )
}

/**
 * HTTP API transport：一次调用一个 POST。
 * @param {object} options
 * @param {string} options.baseUrl 形如 `http://127.0.0.1:3000`
 * @param {string} [options.accessToken]
 * @param {typeof fetch} [options.fetchImpl] 注入用（自检里给假的）
 * @param {number} [options.timeoutMs]
 * @param {(...a: unknown[]) => void} [options.log]
 */
export function createHttpTransport(options) {
  const { baseUrl, accessToken = '', fetchImpl, timeoutMs = 15_000, log = () => {} } = options
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  if (!base) throw new Error('http 传输需要 baseUrl，比如 http://127.0.0.1:3000')
  const doFetch = fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') {
    throw new Error('这个 Node 没有全局 fetch（需要 Node 18+），也没注入 fetchImpl：请升级 Node 或改用 ws 传输')
  }
  const headers = { 'Content-Type': 'application/json' }
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`

  return {
    kind: 'http',
    async call(action, params) {
      const controller = new AbortController()
      // 注意：这个 timer 不能 unref —— 它代表「一次调用正在飞行中」，
      // 进程要等它出结果（unref 之后如果事件循环空了，Node 会直接退出，调用永远不返回）
      const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
      try {
        const res = await doFetch(`${base}/${action}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(params ?? {}),
          signal: controller.signal,
        })
        if (!res || typeof res !== 'object') throw new OneBotApiError(`${action}：没有拿到响应`, { action })
        if (res.ok === false) {
          const text = typeof res.text === 'function' ? await res.text().catch(() => '') : ''
          throw new OneBotApiError(`${action}：HTTP ${res.status} ${String(text).slice(0, 200)}`, { action, status: String(res.status) })
        }
        let json
        try {
          json = await res.json()
        } catch (e) {
          throw new OneBotApiError(`${action}：响应不是 JSON（${e?.message ?? e}）`, { action })
        }
        return checkResponse(json, action)
      } catch (e) {
        if (e instanceof OneBotApiError) throw e
        const reason = controller.signal.aborted ? `超时（${timeoutMs}ms）` : (e?.message ?? String(e))
        throw new OneBotApiError(`${action}：调用 ${base} 失败 —— ${reason}`, { action, code: e?.code })
      } finally {
        clearTimeout(timer)
      }
    },
    close() {},
  }
}

/** 默认 sleep（可注入：自检里换成立刻返回，免得真等退避时间） */
const defaultSleep = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    // 这个可以 unref：等重连的这段时间里如果进程本来就没事干，让它退出是合理的
    timer?.unref?.()
  })

/**
 * 正向 WebSocket transport：事件从这根 socket 进来，API 调用也从它出去。
 *
 * @param {object} options
 * @param {string} options.url 形如 `ws://127.0.0.1:3001` 或 `ws://host:3001/onebot/v11/ws`
 * @param {string} [options.accessToken] 会以 `?access_token=` 拼上去（标准允许；Node 的全局 WebSocket 不支持自定义头）
 * @param {any} [options.WebSocketImpl]
 * @param {number} [options.timeoutMs] 单次 API 调用超时
 * @param {number} [options.readyTimeoutMs] 等连接建立的时间
 * @param {(event: object) => void} [options.onEvent] 事件回调
 * @param {(...a: unknown[]) => void} [options.log]
 * @param {boolean} [options.autoReconnect]
 * @param {ReturnType<typeof createBackoff>} [options.backoff]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {number} [options.quietAfter] 重连日志从第几次开始收敛
 */
export function createWsTransport(options) {
  const {
    url,
    accessToken = '',
    WebSocketImpl,
    timeoutMs = 15_000,
    readyTimeoutMs = 10_000,
    onEvent = () => {},
    log = () => {},
    autoReconnect = true,
    backoff = createBackoff(),
    sleep = defaultSleep,
    quietAfter = 5,
    /** 连上多久才算「真的连上了」——只有稳了才把退避清零，见 handleClose */
    stableMs = 30_000,
    now = Date.now,
  } = options
  const target = String(url ?? '').trim()
  if (!target) throw new Error('ws 传输需要 url，比如 ws://127.0.0.1:3001')
  const Impl = resolveWebSocketImpl(WebSocketImpl)

  /** @type {any} */ let socket
  let closed = false
  let open = false
  let reconnectSeq = 0
  let attempts = 0
  let errorLogged = false
  let openedAt = -1
  /** @type {Set<{resolve: () => void, reject: (e: Error) => void, timer: any}>} */
  const waiters = new Set()
  /** @type {Map<string, {action: string, resolve: (v: any) => void, reject: (e: Error) => void, timer: any}>} */
  const pending = new Map()
  let echoSeq = 0

  function urlWithToken() {
    if (!accessToken) return target
    // 手动拼，不走 new URL()：URL() 会顺手补一个尾部 `/`，把用户填的路径改掉。
    // 路径对 OneBot 是有意义的（有的实现挂在 /onebot/v11/ws 上）。
    if (/[?&]access_token=/.test(target)) return target
    return `${target}${target.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(accessToken)}`
  }

  function settleWaiters(error) {
    for (const w of [...waiters]) {
      waiters.delete(w)
      clearTimeout(w.timer)
      if (error) w.reject(error)
      else w.resolve()
    }
  }

  function failPending(reason) {
    for (const [echo, entry] of [...pending]) {
      pending.delete(echo)
      clearTimeout(entry.timer)
      entry.reject(new OneBotApiError(`${entry.action}：${reason}`, { action: entry.action }))
    }
  }

  function waitOpen() {
    if (open) return Promise.resolve()
    if (closed) return Promise.reject(new OneBotApiError('连接已经关了，调不了 API'))
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          waiters.delete(waiter)
          reject(new OneBotApiError(`还没连上 OneBot 服务（等了 ${readyTimeoutMs}ms）`))
        }, readyTimeoutMs),
      }
      waiters.add(waiter)
    })
  }

  function handleFrame(raw) {
    if (raw === undefined || raw === null) return
    let data = raw
    if (typeof data !== 'string') {
      // 浏览器给 Blob；ws 包给 Buffer；都收成字符串
      if (data && typeof data.text === 'function') {
        void data.text().then(handleFrame)
        return
      }
      data = String(data)
    }
    if (!data.trim()) return
    let json
    try {
      json = JSON.parse(data)
    } catch {
      log('收到不是 JSON 的帧（忽略）：', data.slice(0, 80))
      return
    }
    if (!json || typeof json !== 'object') return
    // 1) 是某个调用的回包 → 按 echo 配对
    if (json.echo !== undefined && pending.has(String(json.echo))) {
      const entry = pending.get(String(json.echo))
      pending.delete(String(json.echo))
      clearTimeout(entry.timer)
      try {
        entry.resolve(checkResponse(json, entry.action))
      } catch (e) {
        entry.reject(e)
      }
      return
    }
    // 2) 是事件 → 交出去
    if (json.post_type) {
      try {
        onEvent(json)
      } catch (e) {
        log('事件处理出错：', e?.message ?? String(e))
      }
      return
    }
    // 3) 剩下的（没有 echo 的 API 回包 / 别的心跳帧）安静丢掉，别刷日志
  }

  function handleOpen() {
    open = true
    errorLogged = false
    openedAt = now()
    log('已连上 OneBot 服务')
    settleWaiters(null)
  }

  function handleClose(ev) {
    const wasOpen = open
    open = false
    failPending('连接断了')
    settleWaiters(new OneBotApiError('连接断了'))
    if (closed) return
    // 只有「连上并且稳了一会儿」才把退避清零。反过来的话，服务端一连接就断（比如 token
    // 不对、正在重启）会变成 100ms 一次的疯狂重连 —— 那正是退避要防的事。
    if (wasOpen && openedAt >= 0 && now() - openedAt >= stableMs) {
      attempts = 0
      backoff.reset()
    }
    const why = ev && typeof ev === 'object' && ev.code !== undefined ? `code=${ev.code}` : '未知原因'
    scheduleReconnect(wasOpen ? '连接断开' : '没能建立连接', why)
  }

  function handleError(ev) {
    if (closed) return
    if (!errorLogged) {
      errorLogged = true
      const msg = ev?.message ?? ev?.error?.message ?? ''
      log('连接出错：', String(msg).slice(0, 160) || '(实现没给原因)')
    }
    // 出错之后通常紧跟着 close，由 handleClose 负责重连 —— 这里别自己再排一个
  }

  function scheduleReconnect(reason, detail) {
    if (closed || !autoReconnect) return
    const delay = backoff.next()
    attempts += 1
    const n = attempts
    // 日志收敛：前几次每次都报，之后只在 1/2/4/8/16… 次报 —— 服务端挂了半小时也不会刷爆日志
    if (n <= quietAfter || (n & (n - 1)) === 0) {
      log(`${reason}${detail ? `（${detail}）` : ''}，${Math.round(delay)}ms 后重连（第 ${n} 次）`)
    }
    const seq = ++reconnectSeq
    void (async () => {
      try {
        await sleep(delay)
      } catch {
        // sleep 被取消/注入的假实现抛错都不该影响重连
      }
      if (closed || seq !== reconnectSeq) return
      connect()
    })()
  }

  function bind(socketLike) {
    const handlers = {
      open: handleOpen,
      close: handleClose,
      error: handleError,
      message: (payload) => handleFrame(payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload),
    }
    if (typeof socketLike.addEventListener === 'function') {
      for (const [ev, fn] of Object.entries(handlers)) socketLike.addEventListener(ev, fn)
      return
    }
    if (typeof socketLike.on === 'function') {
      for (const [ev, fn] of Object.entries(handlers)) socketLike.on(ev, fn)
      return
    }
    throw new Error('这个 WebSocket 实现既没有 addEventListener 也没有 on，认不出来')
  }

  function connect() {
    if (closed) return
    open = false
    errorLogged = false
    try {
      // 第三个参数是给 ws 包用的（自定义头）；Node 自带的全局 WebSocket 会忽略它，
      // 所以 token 同时拼在 query 上 —— 两条路都覆盖。
      socket = new Impl(urlWithToken(), undefined, accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : undefined)
      bind(socket)
    } catch (e) {
      log('建连接失败：', e?.message ?? String(e))
      scheduleReconnect('建连接失败')
    }
  }

  return {
    kind: 'ws',
    /** 立刻发起连接（apply 时调一次） */
    start() {
      connect()
    },
    async call(action, params) {
      await waitOpen()
      const echo = `dsh-onebot-${++echoSeq}`
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(echo)
          reject(new OneBotApiError(`${action}：调用超时（${timeoutMs}ms）`, { action }))
        }, timeoutMs)
        pending.set(echo, { action, resolve, reject, timer })
        try {
          socket.send(JSON.stringify({ action, params: params ?? {}, echo }))
        } catch (e) {
          pending.delete(echo)
          clearTimeout(timer)
          reject(new OneBotApiError(`${action}：发送失败 —— ${e?.message ?? e}`, { action }))
        }
      })
    },
    close() {
      closed = true
      reconnectSeq += 1
      open = false
      failPending('连接已关闭')
      settleWaiters(new OneBotApiError('连接已关闭'))
      try {
        socket?.close?.()
      } catch {
        // 关的时候报错没什么可做的
      }
    },
    state() {
      return { connected: open, pending: pending.size, attempts }
    },
  }
}

/**
 * 把 transport 包成「OneBot 客户端」：业务只跟它打交道。
 * @param {ReturnType<typeof createHttpTransport> | ReturnType<typeof createWsTransport>} transport
 * @param {object} [options]
 * @param {'array'|'string'} [options.format]
 * @param {(...a: unknown[]) => void} [options.log]
 */
export function createApi(transport, options = {}) {
  const { format = 'array', log = () => {} } = options

  async function call(action, params) {
    return await transport.call(action, params)
  }

  async function send(targetKey, message, opts = {}) {
    const parts = String(targetKey ?? '').split(':')
    const kind = parts[0]
    const id = parts.slice(1).join(':')
    if (kind === 'group') return await sendGroupMsg(id, message, opts)
    if (kind === 'private') return await sendPrivateMsg(id, message, opts)
    throw new OneBotApiError(`不认识的会话 key=${targetKey}（应该是 group:<id> 或 private:<id>）`)
  }

  async function sendGroupMsg(groupId, message, opts = {}) {
    const data = await call('send_group_msg', {
      group_id: idForApi(groupId),
      message: buildOutgoingMessage(message, { replyTo: opts.replyTo, format }),
    })
    const id = messageIdOf(data)
    log('群消息已发出', String(groupId), id ? `id=${id}` : '')
    return id
  }

  async function sendPrivateMsg(userId, message, opts = {}) {
    const data = await call('send_private_msg', {
      user_id: idForApi(userId),
      message: buildOutgoingMessage(message, { replyTo: opts.replyTo, format }),
    })
    const id = messageIdOf(data)
    log('私聊消息已发出', String(userId), id ? `id=${id}` : '')
    return id
  }

  return {
    transport,
    call,
    send,
    sendGroupMsg,
    sendPrivateMsg,
    /** 取某条消息（引用展开用） */
    async getMsg(messageId) {
      return await call('get_msg', { message_id: idForApi(messageId) })
    },
    /** 群成员名册 */
    async getGroupMemberList(groupId) {
      const data = await call('get_group_member_list', { group_id: idForApi(groupId) })
      return Array.isArray(data) ? data : []
    },
    async getGroupMemberInfo(groupId, userId) {
      return await call('get_group_member_info', { group_id: idForApi(groupId), user_id: idForApi(userId) })
    },
    /** 群名（标准接口，但有的实现没开；拿不到就用「群<号>」兜底，不算错误） */
    async getGroupInfo(groupId) {
      return await call('get_group_info', { group_id: idForApi(groupId) })
    },
    async getLoginInfo() {
      return await call('get_login_info', {})
    },
  }
}

/** 发送返回值里抠 message_id：不同实现放的位置不一样（data.message_id / message_id） */
function messageIdOf(data) {
  if (data === undefined || data === null) return undefined
  if (typeof data === 'object') {
    const v = data.message_id ?? data.messageId
    return v === undefined || v === null ? undefined : String(v)
  }
  return String(data)
}
