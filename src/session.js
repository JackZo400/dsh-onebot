/**
 * 会话层：会话 key、agent 池、群成员名册、引用缓存、串行队列。
 *
 * 这一层负责「一条消息进来之后，怎么变成一次 dsh 会话，以及怎么把回复送回去」，
 * 但它**不认识 OneBot 协议**（只认 {@link createApi} 的 `call`），
 * 也不认识具体业务 —— 换成别的 IM 通道，这一层几乎可以照搬。
 *
 * 三个真实的坑（都是踩过才知道的）：
 *   1. **同一个会话不能并发跑**。两条消息几乎同时到，如果各起一轮，后一轮清缓冲会把
 *      前一轮的输出冲掉 —— 表现就是「我回了两句，它只回一句」。所以每个会话一条串行队列，
 *      而且必须等**回复真发出去**才放行下一条。
 *   2. **工具调用之前那段正文不是回复**。模型干活时会自言自语（「我先看一下…」），
 *      原样发给用户就是一堆半句话。所以记住「最后一次工具调用开始时缓冲有多长」，
 *      只发那之后的部分。
 *   3. **引用一条更早的消息时本地可能没留到**。本地只缓存最近几十条，于是要用标准接口
 *      `get_msg` 去捞；同一条 5 分钟内只捞一次，免得有人连点把接口打成风暴。
 */

import { randomUUID } from 'node:crypto'
import { normalizeSegments } from './cq.js'
import { sameMsgId, shortGroupName } from './event.js'

/**
 * 会话 key：群 `group:<群号>`，私聊 `private:<QQ号>`。
 * key 就是 agent 池的索引 —— 一个 key 一个 dsh 会话，记忆和上下文互不串线。
 * @param {{scope?: string, groupId?: string, userId?: string}} message
 * @returns {string}
 */
export function sessionKeyOf(message) {
  if (!message) return ''
  if (message.scope === 'group') return `group:${message.groupId}`
  return `private:${message.userId}`
}

/**
 * key → 通道描述（给别的插件、日志看的）。
 * @param {string} key
 * @returns {{scope: 'group'|'private'|'unknown', id: string}}
 */
export function parseSessionKey(key) {
  const s = String(key ?? '')
  const idx = s.indexOf(':')
  if (idx < 0) return { scope: 'unknown', id: s }
  const kind = s.slice(0, idx)
  const id = s.slice(idx + 1)
  if (kind === 'group') return { scope: 'group', id }
  if (kind === 'private') return { scope: 'private', id }
  return { scope: 'unknown', id: s }
}

/**
 * 最近消息缓存：为了把「谁回复了哪条」还原成原文。
 * 只缓存**本会话**的（跨会话引用不存在，OneBot 的 reply 段只在同一会话里有效）。
 * @param {object} [options]
 * @param {number} [options.max] 每个会话留多少条
 */
export function createMessageCache(options = {}) {
  const { max = 60 } = options
  /** @type {Map<string, Array<{id: string, who: string, segments: Array<object>, at: number}>>} */
  const byChat = new Map()
  return {
    /**
     * @param {string} key 会话 key
     * @param {{id?: unknown, who?: string, segments?: unknown, raw?: unknown, at?: number}} entry
     */
    remember(key, entry) {
      const id = String(entry?.id ?? '').trim()
      if (!id || !key) return
      const list = byChat.get(key) ?? []
      list.push({
        id,
        who: String(entry.who ?? ''),
        segments: normalizeSegments(entry.segments ?? entry.raw ?? []),
        at: Number(entry.at) || Date.now(),
      })
      if (list.length > max) list.splice(0, list.length - max)
      byChat.set(key, list)
    },
    /**
     * @param {string} key
     * @param {unknown} id
     * @returns {{id: string, who: string, segments: Array<object>, at: number}|undefined}
     */
    lookup(key, id) {
      const list = byChat.get(key)
      if (!list || !id) return undefined
      for (let i = list.length - 1; i >= 0; i--) {
        if (sameMsgId(list[i].id, id)) return list[i]
      }
      return undefined
    },
    /** 最近几条（新→旧） */
    recent(key, n = 10) {
      return [...(byChat.get(key) ?? [])].reverse().slice(0, n)
    },
    size() {
      return byChat.size
    },
    clear() {
      byChat.clear()
    },
  }
}

/** `get_msg` 返回值 → 缓存条目（跟 {@link createMessageCache} 里的结构一致，好放一起） */
export function normalizeQuoted(data, selfIds = []) {
  if (!data || typeof data !== 'object') return undefined
  const row = /** @type {Record<string, any>} */ (data)
  // 有的实现把消息对象套在 data.message 里，有的直接给
  const inner = row.message && typeof row.message === 'object' && !Array.isArray(row.message) && row.message.message_id !== undefined ? row.message : row
  const sender = inner.sender ?? row.sender ?? {}
  const uid = String(inner.user_id ?? row.user_id ?? sender.user_id ?? '').trim()
  const isSelf = Boolean(uid) && selfIds.map(String).includes(uid)
  // 名字后面带上号码：同一个群里重名很常见，引用行里得能分清是谁
  const name = String(sender.card ?? '').trim() || String(sender.nickname ?? '').trim()
  const who = isSelf ? '我自己' : name ? (uid ? `${name}(QQ ${uid})` : name) : uid ? `QQ ${uid}` : '某人'
  return {
    id: String(inner.message_id ?? row.message_id ?? '').trim(),
    who,
    segments: normalizeSegments(inner.message ?? inner.raw_message ?? []),
    at: Number(inner.time ?? row.time) ? Number(inner.time ?? row.time) * 1000 : Date.now(),
  }
}

/**
 * 引用解析：先查本地缓存，没有就用 `get_msg` 捞。同一条有 TTL，捞过就不再捞。
 * @param {object} options
 * @param {{getMsg: (id: unknown) => Promise<any>}} options.api
 * @param {ReturnType<typeof createMessageCache>} [options.cache]
 * @param {(...a: unknown[]) => void} [options.log]
 * @param {() => number} [options.now]
 * @param {number} [options.ttlMs]
 * @param {string[]} [options.selfIds]
 * @param {number} [options.maxMemo]
 */
export function createQuoteResolver(options) {
  const { api, cache, log = () => {}, now = Date.now, ttlMs = 300_000, selfIds = [], maxMemo = 200 } = options
  /** @type {Map<string, {at: number, hit?: object}>} */
  const memo = new Map()
  return {
    /**
     * @param {string} key 会话 key（本地缓存按会话分）
     * @param {unknown} replyId 被引用那条的 message_id
     */
    async resolve(key, replyId) {
      const id = String(replyId ?? '').trim()
      if (!id) return undefined
      const local = cache?.lookup(key, id)
      if (local) return local
      const memoKey = `${key}|${id}`
      const seen = memo.get(memoKey)
      if (seen && now() - seen.at < ttlMs) return seen.hit
      let hit
      try {
        hit = normalizeQuoted(await api.getMsg(id), selfIds)
      } catch (e) {
        // 捞不到不是致命错误：信封里会写「原文我这边没拿到」，模型自己知道别硬编
        log('取被引用那条失败：', e?.message ?? String(e))
      }
      memo.set(memoKey, { at: now(), hit })
      if (memo.size > maxMemo) memo.delete(memo.keys().next().value)
      if (hit) cache?.remember(key, hit)
      return hit
    },
    stats() {
      return { memo: memo.size }
    },
  }
}

/**
 * 群成员名册：号码 → 名字。
 *
 * 为什么值得缓存：`get_group_member_list` 一次几百条，跟着每条消息去拉等于自杀；
 * 而「@某人是 @谁」直接影响模型读不读得懂。TTL 到期后**后台刷新**，不给消息路径加延迟。
 *
 * @param {object} options
 * @param {{getGroupMemberList: (groupId: unknown) => Promise<any[]>, getGroupInfo?: (groupId: unknown) => Promise<any>}} options.api
 * @param {(...a: unknown[]) => void} [options.log]
 * @param {() => number} [options.now]
 * @param {number} [options.ttlMs]
 * @param {number} [options.maxGroups]
 */
export function createMemberRoster(options) {
  const { api, log = () => {}, now = Date.now, ttlMs = 6 * 3600 * 1000, maxGroups = 64 } = options
  /** @type {Map<string, {at: number, members: Map<string, {name: string, role: string}>, title: string, loading?: Promise<void>, failedAt?: number}>} */
  const groups = new Map()

  function slot(groupId) {
    const id = String(groupId ?? '').trim()
    if (!id) return undefined
    let entry = groups.get(id)
    if (!entry) {
      entry = { at: 0, members: new Map(), title: '' }
      groups.set(id, entry)
      if (groups.size > maxGroups) groups.delete(groups.keys().next().value)
    }
    return entry
  }

  /** 拉一次名册（并发调用共用同一个请求；失败不清空旧数据） */
  async function refresh(groupId) {
    const entry = slot(groupId)
    if (!entry) return
    if (entry.loading) return entry.loading
    // 失败之后别每条消息都重试：30 秒内只试一次
    if (entry.failedAt && now() - entry.failedAt < 30_000) return
    entry.loading = (async () => {
      try {
        const list = await api.getGroupMemberList(groupId)
        const members = new Map()
        for (const row of Array.isArray(list) ? list : []) {
          const uid = String(row?.user_id ?? '').trim()
          if (!uid) continue
          const name = String(row?.card ?? '').trim() || String(row?.nickname ?? '').trim()
          if (!name) continue
          members.set(uid, { name, role: String(row?.role ?? '') })
        }
        entry.members = members
        entry.at = now()
        entry.failedAt = undefined
        log('名册已更新：群', String(groupId), `${members.size} 人`)
        // 群名单独问一次（有的实现没开这个接口，拿不到不算错）
        if (!entry.title && typeof api.getGroupInfo === 'function') {
          try {
            const info = await api.getGroupInfo(groupId)
            entry.title = String(info?.group_name ?? info?.name ?? '').trim()
          } catch {
            // 群名只是装饰，失败就算了
          }
        }
      } catch (e) {
        entry.failedAt = now()
        log('拉群名册失败（不影响收消息，只影响显示名字）：', e?.message ?? String(e))
      } finally {
        entry.loading = undefined
      }
    })()
    return entry.loading
  }

  /** 名册要过期了就后台刷一次（调用方不等） */
  function ensure(groupId) {
    const entry = slot(groupId)
    if (!entry) return
    if (now() - entry.at > ttlMs) void refresh(groupId)
  }

  // 全部写成普通函数、互相按名字调用：不靠 `this`。
  // 解构出去用（`const { displayName } = roster`）也不会突然炸 —— 那种 bug 很难查。
  /** 同步查名字：查不到返回空串（调用方退回号码，绝不阻塞消息） */
  function displayName(groupId, userId) {
    const entry = groups.get(String(groupId ?? '').trim())
    return entry?.members.get(String(userId ?? '').trim())?.name ?? ''
  }
  function groupTitle(groupId) {
    return groups.get(String(groupId ?? '').trim())?.title ?? ''
  }
  /** 异步查：缓存没有就等一次刷新 */
  async function resolveName(groupId, userId) {
    const hit = displayName(groupId, userId)
    if (hit) return hit
    await refresh(groupId)
    return displayName(groupId, userId)
  }
  /** 信封上的「在哪」：有群名用群名，没有就「群<号>」 */
  function label(groupId) {
    return shortGroupName(groupId, groupTitle(groupId))
  }
  function stats() {
    return { groups: groups.size, members: [...groups.values()].reduce((n, g) => n + g.members.size, 0) }
  }

  return { displayName, resolveName, groupTitle, label, refresh, ensure, stats }
}

/**
 * 每个会话一条串行队列。
 *
 * 队列满就丢（默认 5 条）：一个会话里 5 条还没回完，说明模型那边已经堵了，
 * 再堆下去只会让回复越来越晚、越来越不对题 —— 丢掉比积压好（日志里会写清楚）。
 *
 * @param {object} [options]
 * @param {(...a: unknown[]) => void} [options.log]
 * @param {number} [options.timeoutMs] 单条最长处理时间（兜底：agent 卡住时别把队列堵死）
 * @param {number} [options.maxQueue]
 */
export function createSerialQueue(options = {}) {
  const { log = () => {}, timeoutMs = 180_000, maxQueue = 5 } = options
  const busy = new Set()
  /** @type {Map<string, Array<() => Promise<void>>>} */
  const queued = new Map()

  async function run(key, task) {
    if (busy.has(key)) {
      const list = queued.get(key) ?? []
      if (list.length >= maxQueue) {
        log('队列满了，这条先丢（前面还堵着）：', key, `队里 ${list.length} 条`)
        return false
      }
      list.push(task)
      queued.set(key, list)
      log('排队（上一条还没回完）：', key, `队里 ${list.length} 条`)
      return true
    }
    busy.add(key)
    try {
      await withTimeout(task(), timeoutMs)
    } catch (e) {
      log('这条处理出错：', key, e?.message ?? String(e))
    } finally {
      const list = queued.get(key) ?? []
      const next = list.shift()
      if (list.length) queued.set(key, list)
      else queued.delete(key)
      busy.delete(key)
      if (next) void run(key, next)
    }
    return true
  }

  /** 超时只是「不再等它」，不是「取消它」：任务本身还会跑完（agent 不能被我们硬掐） */
  function withTimeout(promise, ms) {
    if (!ms || ms <= 0) return promise
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        log(`这条超过 ${Math.round(ms / 1000)}s 还没回完，先放队列往下走`)
        resolve()
      }, ms)
      Promise.resolve(promise).then(
        () => {
          clearTimeout(timer)
          resolve()
        },
        (e) => {
          clearTimeout(timer)
          reject(e)
        },
      )
    })
  }

  return {
    run,
    busyKeys: () => [...busy],
    pending: (key) => (queued.get(key) ?? []).length,
    clear() {
      queued.clear()
    },
  }
}

/**
 * dsh agent 池：一个会话 key ↔ 一个 agent（会话）。
 *
 * 这里刻意不做记忆分级、门禁、日结那些东西 —— 那些是**部署策略**，该由别的插件
 * （或用户自己的系统提示）决定；通道插件只负责「把消息变成一轮对话，再把话拿回来」。
 *
 * @param {object} options
 * @param {any} options.ctx Cordis 上下文（要能 `ctx.agents.create` 和 `ctx.on`）
 * @param {(...a: unknown[]) => void} [options.log]
 * @param {string} [options.provider] 模型路由（不填就用 dsh 的默认）
 * @param {string} [options.model]
 * @param {string} [options.cwd] 会话工作目录
 * @param {string} [options.preset] 可选的 agent 预设名（dsh 装了 agentPresets 才生效）
 */
export function createAgentPool(options) {
  const { ctx, log = () => {}, provider = '', model = '', cwd = '', preset = '' } = options
  /** @type {Map<string, any>} */
  const sessions = new Map()
  let closed = false

  /** 收助手流式输出：一个会话的正文攒在它自己的缓冲里 */
  function collect(payload) {
    const frame = payload?.frame
    const agentId = payload?.agent?.id ?? payload?.agent?.sessionId
    for (const rec of sessions.values()) {
      if (rec.agent?.sessionId !== agentId && rec.agent?.id !== agentId) continue
      if (frame?.type === 'chunk' && frame.chunk?.type === 'text-delta') {
        rec.buf += frame.chunk.text
        rec.toolCalling = false
      } else if (frame?.type === 'chunk' && frame.chunk?.type === 'tool-call-delta') {
        // 新的一步工具调用：把「要发给用户的那段」的起点推到当前缓冲末尾 ——
        // 它之前说的是干活时的碎话，不算回复
        const id = String(frame.chunk?.id ?? '')
        if (id && id !== rec.toolId) {
          rec.toolId = id
          rec.toolCalling = true
          rec.step += 1
          rec.answerFrom = rec.buf.length
        }
      }
      return rec
    }
    return undefined
  }
  ctx.on('agent/assistant-stream', collect)

  function resetTurn(rec) {
    rec.buf = ''
    rec.answerFrom = 0
    rec.toolCalling = false
    rec.step = 0
    rec.toolId = ''
  }

  async function ensureSession(key) {
    const found = sessions.get(key)
    if (found) return found
    if (closed) throw new Error('插件已经卸载了，不再新建会话')
    const sessionId = randomUUID()
    let presetId = ''
    let setup
    const presets = typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined
    if (preset && presets?.resolve) {
      try {
        const resolved = await presets.resolve(preset)
        presetId = resolved.id
        setup = async (agentCtx) => {
          await presets.mount(agentCtx, resolved.id)
        }
      } catch (e) {
        // 预设解析失败不该拦住通道：用默认身份照常说话，日志里留痕
        log('挂载预设失败（用默认身份继续）：', e?.message ?? String(e))
      }
    }
    const handle = await ctx.agents.create({
      sessionId,
      meta: { ...(cwd ? { cwd } : {}), ...(presetId ? { agentPreset: presetId } : {}) },
      agentOptions: { ...(provider ? { provider } : {}), ...(model ? { model } : {}) },
      ...(setup ? { setup } : {}),
    })
    const rec = {
      key,
      sessionId,
      agent: handle.agent,
      handle,
      buf: '',
      answerFrom: 0,
      toolCalling: false,
      step: 0,
      toolId: '',
      busy: false,
    }
    sessions.set(key, rec)
    log('新建会话', key, '→', sessionId)
    return rec
  }

  /** 这一轮该发出去的那段（工具调用之前的碎话被切掉） */
  function answer(key) {
    const rec = sessions.get(key)
    if (!rec) return ''
    return rec.buf.slice(rec.answerFrom ?? 0).trim()
  }

  async function disposeKey(key) {
    const rec = sessions.get(key)
    if (!rec) return
    sessions.delete(key)
    try {
      await rec.handle?.dispose?.()
    } catch (e) {
      log('关会话失败：', key, e?.message ?? String(e))
    }
  }

  return {
    sessions,
    ensureSession,
    answer,
    resetTurn,
    disposeKey,
    async disposeAll() {
      closed = true
      for (const key of [...sessions.keys()]) await disposeKey(key)
    },
  }
}
