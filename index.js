/**
 * dsh-onebot —— 给 dsh 的 Agent 接一条 QQ 通道（OneBot 11 标准客户端）。
 *
 * 为什么是 OneBot 11：中文社区的 QQ 机器人实现（go-cqhttp / Lagrange / NapCat /
 * LLOneBot …）几乎都实现了这套协议。所以这里**不绑定任何一家**：你那边跑着哪个实现都行，
 * 配上地址和 token 就能用。哪天想换实现，配置文件里改一行地址，插件和会话记忆都不用动。
 *
 * 它做什么：
 *   · 当客户端连正向 WebSocket（收事件 + 调 API），或者只调 HTTP API（发）
 *   · 把一条 QQ 消息变成一个 dsh 会话里的一轮对话，把助手的回答发回去
 *   · 一个会话 key（群 / 私聊）一个 dsh 会话，互不串线；同会话串行、一条消息一条回复
 *
 * 它**不**做什么（有意留白，见 README「没做」那一节）：
 *   · 不塞人设、不做记忆分级、不做内容审查、不做日结 —— 那些是部署策略，属于你
 *   · 不解析图片/语音内容（图只变成「（图）」，需要的话可以打开 imageLinks 把直链给模型）
 *   · 不支持反向 WebSocket / HTTP 上报（那需要插件自己起 HTTP 服务，见 README）
 *
 * @module dsh-onebot
 */
import { randomUUID } from 'node:crypto'
import { parseOneBotEvent, renderEnvelope, sanitizeOutgoing, shouldDispatch } from './src/event.js'
import { buildOutgoingMessage, createApi, createBackoff, createHttpTransport, createWsTransport } from './src/api.js'
import { createAgentPool, createMemberRoster, createMessageCache, createQuoteResolver, createSerialQueue } from './src/session.js'

/** Cordis 插件名。 */
export const name = 'dsh-onebot'

/** 需要的能力：创建/驱动 agent（`ctx.agents`）。 */
export const inject = ['agents']

/** 所有配置项和默认值（README 里那一节就是照抄这里）。 */
export const DEFAULTS = {
  /** 正向 WebSocket 地址，例如 ws://127.0.0.1:3001 （收事件 + 调 API 都走它） */
  ws: '',
  /** HTTP API 地址，例如 http://127.0.0.1:3000 （只用来发；事件它不推） */
  http: '',
  /** access_token：HTTP 走 Authorization: Bearer，WS 走 ?access_token= */
  accessToken: '',
  /** 机器人 QQ 号。留空 = 用每条事件里的 self_id（多账号部署下这样才对） */
  selfId: '',
  /** 允许的群号；空数组 = 所有群（但群里默认只有 @ 我才理） */
  groups: [],
  /** 是否响应私聊。默认关：私聊是最容易被白嫖 token 的口子 */
  private: false,
  /** 私聊白名单；空数组 = 不限（仅当 private 打开） */
  users: [],
  /** 群里必须 @ 我才派给 agent。false = 群里每条消息都进模型（费钱，慎用） */
  requireMention: true,
  /** 回复时引用触发它的那条消息（群里这样别人分得清在回谁） */
  quoteReply: true,
  /** 图要不要把直链写进正文（模型能自己取图时才有意义，默认不带） */
  imageLinks: false,
  /** 发消息的格式：array（默认，最稳）或 string（CQ 码） */
  format: 'array',
  /** 模型路由 / 模型（不填就用 dsh 自己的默认） */
  provider: '',
  model: '',
  /** 会话的工作目录（文件的根）；不填 = dsh 进程的工作目录 */
  cwd: '',
  /** 可选的 dsh agent 预设名（装了 agentPresets 服务才生效） */
  preset: '',
  /** 信封里显示的时间时区 */
  tz: 'Asia/Shanghai',
  /** 日志啰嗦一点（没 @ 我的群消息、发给模型的原文都会打出来） */
  debug: false,
  /** 同会话串行队列：排到几条就丢，单条最长处理多久 */
  queue: { max: 5, timeoutMs: 180_000 },
  /** 单次 API 调用 / 等连接建立 的超时 */
  timeouts: { callMs: 15_000, readyMs: 10_000 },
  /** 断线重连：退避 + 抖动 + 日志收敛 */
  reconnect: { enabled: true, baseMs: 1000, maxMs: 60_000, factor: 2, jitter: 0.2, quietAfter: 5 },
  /**
   * 注入口：给自检和特殊环境用（YAML 里配不了函数）。
   * fetch / WebSocket / sleep 三个都留空时就用 Node 自带的那套。
   */
  fetch: null,
  WebSocket: null,
  sleep: null,
  now: null,
}

/** 默认合并（嵌套那几层也要合，不然只写一个字段就会把整块默认值冲掉） */
export function resolveConfig(raw) {
  const merged = { ...DEFAULTS, ...(raw ?? {}) }
  merged.queue = { ...DEFAULTS.queue, ...(raw?.queue ?? {}) }
  merged.timeouts = { ...DEFAULTS.timeouts, ...(raw?.timeouts ?? {}) }
  merged.reconnect = { ...DEFAULTS.reconnect, ...(raw?.reconnect ?? {}) }
  merged.groups = Array.isArray(merged.groups) ? merged.groups : merged.groups ? [merged.groups] : []
  merged.users = Array.isArray(merged.users) ? merged.users : merged.users ? [merged.users] : []
  return merged
}

/**
 * 插件入口。
 * @param {any} ctx Cordis 上下文
 * @param {object} [rawConfig] 见 {@link DEFAULTS}
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  // 直接写 stderr，不走 ctx.logger —— cordis 的 logger 默认只挂一个内存环形缓冲，
  // info 既不落文件也不上屏，插件看着像根本没加载。
  const log = (...args) => {
    try {
      process.stderr.write(`${new Date().toISOString()} [dsh-onebot] ${args.map(stringify).join(' ')}\n`)
    } catch {
      // stderr 都没了就算了
    }
  }

  const now = typeof config.now === 'function' ? config.now : Date.now
  const selfIds = [config.selfId].map((v) => String(v ?? '').trim()).filter(Boolean)

  // ---------------- 配置检查：说清楚为什么不能跑，别静默失败 ----------------
  if (!config.ws && !config.http) {
    log('既没配 ws 也没配 http，插件什么都不做。至少配一个：ws://127.0.0.1:3001 或 http://127.0.0.1:3000')
    return
  }
  if (config.format !== 'array' && config.format !== 'string') {
    log(`format=${config.format} 不认识，按 array 处理（可选 array / string）`)
    config.format = 'array'
  }

  // ---------------- transport：WS 收事件+发，HTTP 只发 ----------------
  let wsTransport
  let httpTransport
  try {
    httpTransport = config.http
      ? createHttpTransport({
          baseUrl: config.http,
          accessToken: config.accessToken,
          fetchImpl: config.fetch ?? undefined,
          timeoutMs: config.timeouts.callMs,
          log,
        })
      : undefined
    wsTransport = config.ws
      ? createWsTransport({
          url: config.ws,
          accessToken: config.accessToken,
          WebSocketImpl: config.WebSocket ?? undefined,
          timeoutMs: config.timeouts.callMs,
          readyTimeoutMs: config.timeouts.readyMs,
          onEvent: (event) => void handleEvent(event),
          log,
          autoReconnect: config.reconnect.enabled !== false,
          backoff: createBackoff(config.reconnect),
          sleep: typeof config.sleep === 'function' ? config.sleep : undefined,
          quietAfter: Number(config.reconnect.quietAfter) || 5,
        })
      : undefined
  } catch (e) {
    log('配置有问题，插件不启动：', e?.message ?? String(e))
    return
  }
  const apiTransport = httpTransport ?? wsTransport
  const api = createApi(apiTransport, { format: config.format, log })
  if (!wsTransport) {
    log('只配了 http：能发不能收。OneBot 的 HTTP API 不推送事件，要收消息得配 ws（正向 WebSocket）')
  } else if (httpTransport) {
    log('ws 收事件，API 调用走 http（两个地址都配了，按这个分工用）')
  }

  // ---------------- 会话层 ----------------
  const cache = createMessageCache({ max: 60 })
  const quotes = createQuoteResolver({ api, cache, log, now, selfIds })
  const roster = createMemberRoster({ api, log, now })
  const pool = createAgentPool({
    ctx,
    log,
    provider: config.provider,
    model: config.model,
    cwd: config.cwd,
    preset: config.preset,
  })
  const queue = createSerialQueue({ log, timeoutMs: config.queue.timeoutMs, maxQueue: config.queue.max })

  const stat = { events: 0, messages: 0, dispatched: 0, replied: 0, skipped: 0, errors: 0 }
  /** 登录信息（连上之后问一次；selfId 留空时靠它兜底） */
  let login = { id: '', nickname: '' }

  const selfIdFor = (message) => String(message?.selfId ?? selfIds[0] ?? '')

  /** 给模型看的 @名字：名册里有就用名字，没有就退回号码（再后台刷名册） */
  const atNameFor = (groupId) => (qq) => roster.displayName(groupId, qq) || undefined

  // ---------------- 最近消息：为了还原「回复了哪条」 ----------------
  function remember(message) {
    const self = message.self || (selfIdFor(message) && String(message.userId) === selfIdFor(message))
    cache.remember(message.key, {
      id: message.messageId,
      who: self ? '我自己' : message.name || `QQ ${message.userId}`,
      segments: message.segments,
      at: message.time?.getTime?.() ?? now(),
    })
  }

  // ---------------- 事件入口 ----------------
  async function handleEvent(raw) {
    stat.events += 1
    const parsed = parseOneBotEvent(raw, {
      selfIds,
      groups: config.groups,
      private: config.private,
      users: config.users,
    })
    if (parsed.kind !== 'message') {
      // 噪声事件不值得刷日志；不认识的、明确忽略的（私聊没开、群不在白名单）要说一声
      if (parsed.kind !== 'meta_event' && parsed.kind !== 'notice' && parsed.kind !== 'request' && parsed.kind !== 'response') {
        log('忽略事件：', parsed.reason)
      }
      return
    }
    const message = parsed.message
    stat.messages += 1
    // 自己发出去的消息也记一份 —— 别人引用我那句时，我得能把原文贴回来
    remember(message)

    const decision = shouldDispatch(message, { requireMention: config.requireMention })
    if (!decision.ok) {
      stat.skipped += 1
      if (config.debug || decision.reason !== '群里没 @ 我') log('不派发：', decision.reason, message.key, JSON.stringify(message.text).slice(0, 60))
      return
    }

    log(
      '收到',
      message.scope,
      message.key,
      JSON.stringify(message.text || message.raw).slice(0, 80),
      message.atMe ? '@我' : '',
      message.name ? `· ${message.name}` : '· (没有名字)',
    )
    // 名册：过期了就在后台刷（不阻塞这条消息）
    if (message.scope === 'group') roster.ensure(message.groupId)
    stat.dispatched += 1
    await queue.run(message.key, () => dispatchOne(message))
  }

  // ---------------- 一条消息 → 一轮对话 ----------------
  async function dispatchOne(message) {
    let rec
    try {
      rec = await pool.ensureSession(message.key)
    } catch (e) {
      stat.errors += 1
      log('建会话失败：', e?.message ?? String(e))
      await reply(message, '（我这边通道还没接好…稍等一下）')
      return
    }
    pool.resetTurn(rec)

    const selfId = selfIdFor(message)
    const atName = atNameFor(message.groupId)
    // 本地没留到那条 → 用 get_msg 捞（同一条 5 分钟内只捞一次）
    const quote = message.quoteId ? await quotes.resolve(message.key, message.quoteId) : undefined
    const text = renderEnvelope(message, {
      atName,
      selfId,
      quote,
      quoteMissing: Boolean(message.quoteId) && !quote,
      tz: config.tz,
      imageLinks: config.imageLinks,
    })
    if (config.debug) log('→ agent：\n' + text)

    try {
      rec.agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      })
    } catch (e) {
      stat.errors += 1
      log('投递给 agent 失败：', e?.message ?? String(e))
      await reply(message, '（我这边刚刚走神了一下…你再说一遍？）')
      return
    }

    try {
      await rec.agent.whenIdle?.()
    } catch (e) {
      stat.errors += 1
      log('等 agent 回答出错：', e?.message ?? String(e))
    }
    // answer() 会切掉工具调用之前的碎话（那些是干活时的自言自语，不是回复）
    const answer = pool.answer(message.key)
    if (!answer) {
      log('这一轮没有可发的正文（只有工具调用）', message.key)
      return
    }
    await reply(message, answer)
  }

  /** 把一段话发回 QQ。引用触发它的那条（配置可关）。 */
  async function reply(message, text) {
    const clean = sanitizeOutgoing(text)
    if (!clean) return
    const replyTo = config.quoteReply ? message.messageId : undefined
    try {
      await api.send(message.key, clean, { replyTo })
      stat.replied += 1
      log('已回复', message.key, `${clean.length} 字`)
    } catch (e) {
      stat.errors += 1
      const detail = e?.retcode !== undefined ? `retcode=${e.retcode}` : e?.message ?? String(e)
      log('回复失败：', message.key, detail)
    }
  }

  // ---------------- 连接生命周期 ----------------
  ctx.effect(() => {
    if (wsTransport?.start) {
      wsTransport.start()
      // 连上之后问一次「我是谁」：日志里看得见连的是哪个号，selfId 没配也能兜底
      void (async () => {
        try {
          const info = await api.getLoginInfo()
          const id = String(info?.user_id ?? '').trim()
          login = { id, nickname: String(info?.nickname ?? '') }
          if (id && !selfIds.includes(id)) selfIds.push(id)
          log(`已登录：${login.nickname || '(没有昵称)'}（${id || '?'}）`)
        } catch (e) {
          log('取登录信息失败（不影响收发，self_id 用事件里的）：', e?.message ?? String(e))
        }
      })()
    } else {
      log('没有 ws：不连事件流，只按需调 http API')
    }

    // 给别的插件用的口子（比如定时主动发消息的插件、加工具的业务插件）
    try {
      ctx.provide('onebot', {
        api,
        call: (action, params) => api.call(action, params),
        send: (key, message, opts) => api.send(key, message, opts),
        sendGroupMsg: (groupId, message, opts) => api.sendGroupMsg(groupId, message, opts),
        sendPrivateMsg: (userId, message, opts) => api.sendPrivateMsg(userId, message, opts),
        sessionKeys: () => [...pool.sessions.keys()],
        login: () => login,
        stats: () => ({ ...stat, sessions: pool.sessions.size, ...(wsTransport?.state?.() ?? {}) }),
        /** 把一段文本/消息段预备好（供外部检查会构造出什么） */
        build: (message, opts) => buildOutgoingMessage(message, { ...opts, format: config.format }),
      })
      log('已暴露 onebot 服务（别的插件可以调 send / call）')
    } catch (e) {
      log('暴露 onebot 服务失败（不影响通道本身）：', e?.message ?? String(e))
    }

    return () => {
      log('卸载中：关连接、停会话')
      try {
        wsTransport?.close?.()
      } catch {
        // 关连接出错没什么可做的
      }
      void pool.disposeAll()
      cache.clear()
      queue.clear()
    }
  })

  const where = [config.ws ? `ws=${config.ws}` : '', config.http ? `http=${config.http}` : ''].filter(Boolean).join(' ')
  log(`就绪：${where} 群=${config.groups.length ? config.groups.join(',') : '不限'} 私聊=${config.private ? '开' : '关'} 群内需@=${config.requireMention ? '是' : '否'}`)
}

/** 日志参数序列化：对象/错误都变成一行，别让日志自己变成一个调试任务 */
function stringify(value) {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return String(value)
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return '[对象]'
    }
  }
  return String(value)
}
