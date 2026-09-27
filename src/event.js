/**
 * OneBot 11 事件 → 内部消息结构。
 *
 * 这一层只做**判断**，不做 I/O：一条上报该不该理、算不算「@ 我」、是不是自己
 * 发出去的回声、给模型看的正文长什么样。因为全是纯函数，自检里可以拿真事件的
 * JSON 直接喂进来看结果。
 *
 * 三个真实的坑：
 *   1. **回声**。部分实现会把「你自己发出去的消息」也上报回来（有的用
 *      `post_type=message_sent`，有的就是普通 message 但 `user_id === self_id`）。
 *      不过滤的话，机器人会对着自己刚说的话再回一遍，然后无限循环。
 *   2. **@ 我 的判定不能只看 `raw_message`**。字符串消息里 `[CQ:at,qq=...]` 是码，
 *      数组消息里是 `{type:'at'}` 段 —— 只看其中一种，换个实现就全瞎。
 *   3. **群消息 id 可能是负数**（部分实现的群消息 id 是负的），比对时要把符号抹掉，
 *      否则「引用某条」永远查不到本地缓存里那一份。
 */
import { atTargets, extractReplyId, humanizeCq, normalizeSegments, segmentsToCq, textOf } from './cq.js'

/** 过了这一层的 `post_type` 才可能是消息 */
const MESSAGE_POST_TYPES = new Set(['message', 'message_sent'])
/** 明确不处理的：只回个名字，方便日志里看清「这条为什么没理」 */
const IGNORED_POST_TYPES = {
  notice: '通知事件（戳一戳/进退群/撤回）暂不处理',
  request: '请求事件（加好友/加群）暂不处理',
  meta_event: '元事件（心跳/生命周期）不处理',
}

/** 时区：日志是 UTC，人看的是本地时间。默认东八区（可以在配置里改）。 */
export const DEFAULT_TZ = 'Asia/Shanghai'

/**
 * HH:MM（按时区）。Intl 在某些精简 Node 构建里可能没有时区数据，
 * 那就退回机器本地时间 —— 时间不准好过抛异常把消息丢了。
 * @param {Date} [date]
 * @param {string} [tz]
 * @returns {string}
 */
export function clockText(date = new Date(), tz = DEFAULT_TZ) {
  const pad = (n) => String(n).padStart(2, '0')
  try {
    return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(date)
  } catch {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  }
}

/**
 * 群名短名化：群全名常常带旗子、emoji、全角标点，塞进每行信封太吵。
 * 这里不做别名表 —— 别名是「每个部署自己才知道」的东西，属于配置，不该写死在代码里。
 * @param {unknown} id
 * @param {unknown} [full]
 * @returns {string}
 */
export function shortGroupName(id, full) {
  const key = String(id ?? '').trim()
  const raw = String(full ?? '').trim()
  if (!raw) return key ? `群${key}` : '群'
  const clean = raw
    .replace(/[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F]/gu, '')
    .replace(/^[-—·\s]+|[-—·\s]+$/g, '')
  return (clean || raw).slice(0, 12)
}

/**
 * 消息 id 宽松比对：群消息 id 有正有负，实现之间还可能是字符串/数字，
 * 别因为符号或类型对不上就当成两条。
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function sameMsgId(a, b) {
  const norm = (v) => String(v ?? '').trim().replace(/^-/, '')
  const x = norm(a)
  return Boolean(x) && x === norm(b)
}

/** 一条上报里的「我自己是谁」：优先用事件自带的 `self_id`（多账号部署下它才是对的） */
function selfIdOf(event, fallback) {
  const own = String(event?.self_id ?? '').trim()
  return own || String(fallback ?? '').trim()
}

/** 发言人显示名：群里有群名片用群名片，没有用昵称；匿名消息用匿名名 */
function senderNameOf(event, messageType) {
  const sender = event?.sender ?? {}
  const card = String(sender.card ?? '').trim()
  const nick = String(sender.nickname ?? '').trim()
  const anon = String(event?.anonymous?.name ?? '').trim()
  if (messageType === 'group') return card || nick || anon || ''
  return nick || ''
}

/**
 * 一条上报 JSON → 内部消息。
 *
 * 不派发的情况**一定给出 reason**：上线后第一个问题永远是「我 @ 它了它怎么不理我」，
 * 日志里得能直接读出是哪一道闸挡的（群不在白名单 / 没 @ 我 / 是回声 / 私聊没开）。
 *
 * @param {unknown} raw 一条 OneBot 上报（已 JSON.parse 的对象）
 * @param {object} [options]
 * @param {Array<string|number>} [options.selfIds] 已知的机器人账号（自兜底；事件里的 self_id 优先）
 * @param {Array<string|number>} [options.groups] 允许的群；空数组 = 不限
 * @param {boolean} [options.private] 是否响应私聊
 * @param {Array<string|number>} [options.users] 私聊白名单；空数组 = 不限（仅当 private 打开）
 * @returns {{kind: string, message?: object, reason: string}}
 */
export function parseOneBotEvent(raw, options = {}) {
  const { selfIds = [], groups = [], private: allowPrivate = false, users = [] } = options
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'unknown', reason: '不是对象' }

  const postType = String(raw.post_type ?? '').trim()
  if (!postType) {
    // 没有 post_type 又带 retcode/echo 的，是 API 的响应帧（正常会被 transport 先截走）。
    // 走到这里说明实现的封装不太一样，当噪声丢掉，别当成消息。
    if (raw.echo !== undefined || raw.retcode !== undefined) return { kind: 'response', reason: 'API 响应帧' }
    return { kind: 'unknown', reason: '没有 post_type' }
  }
  if (IGNORED_POST_TYPES[postType]) return { kind: postType, reason: IGNORED_POST_TYPES[postType] }
  if (!MESSAGE_POST_TYPES.has(postType)) return { kind: 'unknown', reason: `不认识的 post_type=${postType}` }

  const messageType = String(raw.message_type ?? '').trim()
  const selfId = selfIdOf(raw, selfIds[0])
  const userId = String(raw.user_id ?? '').trim()
  // 回声的两种长相：明确的 message_sent，或者 user_id 跟 self_id 撞上
  const self = postType === 'message_sent' || (Boolean(selfId) && userId === selfId)

  const segments = normalizeSegments(raw.message ?? raw.raw_message ?? [])
  const rawCq = String(raw.raw_message ?? '').trim() || segmentsToCq(segments)

  if (messageType === 'group') {
    const groupId = String(raw.group_id ?? '').trim()
    if (!groupId) return { kind: 'unknown', reason: '群消息却没有 group_id' }
    if (groups.length && !groups.map(String).includes(groupId)) {
      return { kind: 'ignored', reason: `群 ${groupId} 不在允许列表里` }
    }
    const atMe = Boolean(selfId) && atTargets(segments).includes(selfId)
    return {
      kind: 'message',
      reason: '',
      message: {
        scope: 'group',
        key: `group:${groupId}`,
        groupId,
        userId,
        selfId,
        messageId: raw.message_id === undefined ? '' : String(raw.message_id),
        time: timeOf(raw),
        segments,
        raw: rawCq,
        text: textOf(segments),
        atMe,
        self,
        name: senderNameOf(raw, 'group'),
        role: String(raw.sender?.role ?? ''),
        subType: String(raw.sub_type ?? ''),
        quoteId: extractReplyId(segments),
      },
    }
  }

  if (messageType === 'private') {
    if (!allowPrivate) return { kind: 'ignored', reason: '私聊没开（配置 private: false）' }
    const list = users.map(String)
    if (list.length && !list.includes(userId)) return { kind: 'ignored', reason: `私聊用户 ${userId} 不在允许列表里` }
    return {
      kind: 'message',
      reason: '',
      message: {
        scope: 'private',
        key: `private:${userId}`,
        groupId: '',
        userId,
        selfId,
        messageId: raw.message_id === undefined ? '' : String(raw.message_id),
        time: timeOf(raw),
        segments,
        raw: rawCq,
        text: textOf(segments),
        // 私聊本来就是对着我说的，不需要 @
        atMe: true,
        self,
        name: senderNameOf(raw, 'private'),
        role: '',
        subType: String(raw.sub_type ?? ''),
        quoteId: extractReplyId(segments),
      },
    }
  }

  return { kind: 'unknown', reason: `不认识的 message_type=${messageType || '(空)'}` }
}

/** 上报时间（秒）→ Date；没有就用现在 */
function timeOf(raw) {
  const secs = Number(raw?.time)
  return Number.isFinite(secs) && secs > 0 ? new Date(secs * 1000) : new Date()
}

/**
 * 要不要把这条交给 agent（以及为什么不要）。
 * 跟 {@link parseOneBotEvent} 里的白名单过滤分开：白名单是「谁允许跟它说话」，
 * 这里是「这条值不值得花一次模型调用」。
 *
 * @param {object} message {@link parseOneBotEvent} 给出的 message
 * @param {object} [options]
 * @param {boolean} [options.requireMention] 群里必须 @ 我才理（默认 true）
 * @returns {{ok: boolean, reason: string}}
 */
export function shouldDispatch(message, options = {}) {
  const { requireMention = true } = options
  if (!message) return { ok: false, reason: '没有消息' }
  if (message.self) return { ok: false, reason: '自己发出去的消息（回声）' }
  if (message.scope === 'group' && requireMention && !message.atMe) return { ok: false, reason: '群里没 @ 我' }
  return { ok: true, reason: '' }
}

/** 把一句多行文本压成一行（换行会毁掉「第一行是信封」的读法） */
export function oneLine(text, max = 80) {
  const t = String(text ?? '')
    .replace(/\s*\n+\s*/g, ' / ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/**
 * 一条消息 → 给模型看的正文。
 *
 * 为什么要信封而不是裸文本：模型需要知道「谁、在哪、什么时候说的」，还得知道
 * 被回复的那句是什么 —— 只丢一句「这个什么意思」，它连对象都没有。
 *
 * ```
 * 【群 demo · 22:15】alice(QQ 123456)
 * ↩ 回复 bob(QQ 654321)：「（图）来一张」
 * 这个表情包什么意思
 * ```
 *
 * @param {object} message
 * @param {object} [options]
 * @param {(qq: string) => string | undefined} [options.atName]
 * @param {string|number} [options.selfId]
 * @param {{who?: string, segments?: Array<unknown>, text?: string}} [options.quote] 被引用的那条（本地缓存或 get_msg 捞回来的）
 * @param {boolean} [options.quoteMissing] 引用了、但原文没拿到
 * @param {Array<string>} [options.extra] 额外说明行
 * @param {string} [options.tz]
 * @param {boolean} [options.imageLinks]
 * @returns {string}
 */
export function renderEnvelope(message, options = {}) {
  const { atName, selfId, quote, quoteMissing = false, extra = [], tz = DEFAULT_TZ, imageLinks = false } = options
  const who = message?.name ? `${message.name}(QQ ${message.userId})` : `QQ ${message.userId}`
  const where = message?.scope === 'group' ? shortGroupName(message.groupId) : '私聊'
  const lines = [`【${where} · ${clockText(message?.time, tz)}】${who}`]
  if (quote) {
    const quoted = quote.text ?? humanizeCq(quote.segments ?? [], { atName, selfId, imageLinks })
    const from = quote.who || '某人'
    lines.push(`↩ 回复 ${from}：「${oneLine(humanizeCq(quoted, { atName, selfId, imageLinks }))}」`)
  } else if (quoteMissing) {
    lines.push('↩ 回复了某条更早的消息（原文我这边没拿到）')
  }
  for (const line of extra) if (line) lines.push(line)
  const body = humanizeCq(message?.segments ?? [], { atName, selfId, imageLinks }).trim()
  lines.push(body || '（本条没有文字）')
  return lines.join('\n')
}

/**
 * 出去的话过一遍：模型有时候自己写 CQ 码（学样），裸码发进群很难看，
 * 也容易被实现当成真的码去解析 —— 一律抹掉。
 * @param {unknown} text
 * @returns {string}
 */
export function sanitizeOutgoing(text) {
  return String(text ?? '')
    .replace(/\[CQ:[A-Za-z0-9_.-]+[^\]]*\]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// 会话 key（`group:<群号>` / `private:<QQ号>`）在 session.js 里 —— 那里才是它的家
