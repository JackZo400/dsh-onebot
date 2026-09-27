/**
 * CQ 码 ↔ 消息段数组。
 *
 * 这一层是**纯函数**：不碰网络、不读配置、不记状态。为什么硬要拆出来单测：
 * OneBot 11 里同一条消息有两种长相 —— `message` 字段可能是 CQ 码字符串，
 * 也可能是 segment 数组，取决于实现的 `message_format` 配置（同一个实现换个
 * 开关就变脸）。这两种长相在下游必须长得一模一样，否则「@ 我 的判定」「引用
 * 展开」这类逻辑就得写两遍，写两遍就一定有一遍是错的。
 *
 * 三个真实坑，都在下面处理掉了：
 *   1. CQ 码里的参数值要转义（`&` `[` `]` `,` 四个字符），不然一句「a,b」就把
 *      参数截断了。**反转义的顺序必须是 & 最后**，否则 `&amp;#91;` 会被还原两次。
 *   2. 有些实现把数组 **JSON 序列化成字符串** 塞进 `message` 字段（少见但真有），
 *      所以字符串要先试 JSON 解析，解析不出来再当 CQ 码。别反过来 —— 普通文字
 *      消息里出现 `[` 太正常了（`[图片]`），硬解析会丢字。
 *   3. 消息段里的 `qq` / `user_id` 有时是数字有时是字符串，一律按字符串比。
 */

/** CQ 码需要转义的字符。顺序也是转义顺序：`&` 必须第一个换。 */
const ESCAPES = [
  ['&', '&amp;'],
  ['[', '&#91;'],
  [']', '&#93;'],
  [',', '&#44;'],
]

/**
 * 把一段**文本**转义成能安全塞进 CQ 码参数值的样子。
 * @param {unknown} text
 * @returns {string}
 */
export function escapeCq(text) {
  let s = String(text ?? '')
  for (const [raw, entity] of ESCAPES) s = s.split(raw).join(entity)
  return s
}

/**
 * 反转义。顺序跟 {@link escapeCq} 相反：先还原实体，`&amp;` 放最后。
 * 反过来写的话，`&amp;#91;`（本来就是字面量 `&#91;`）会被拆成 `&` + `#91;` → 多出一个 `[`。
 * @param {unknown} text
 * @returns {string}
 */
export function unescapeCq(text) {
  let s = String(text ?? '')
  for (const [raw, entity] of [...ESCAPES].reverse()) s = s.split(entity).join(raw)
  return s
}

/** `key=value,key2=value2`（CQ 码里 `[CQ:type` 之后那一段，含开头的逗号）→ 对象 */
function parseCqParams(raw) {
  const data = {}
  const s = String(raw ?? '')
  if (!s) return data
  for (const piece of s.replace(/^,/, '').split(',')) {
    if (!piece) continue
    const eq = piece.indexOf('=')
    if (eq < 0) {
      data[piece.trim().toLowerCase()] = ''
      continue
    }
    const key = piece.slice(0, eq).trim().toLowerCase()
    if (!key) continue
    data[key] = unescapeCq(piece.slice(eq + 1))
  }
  return data
}

/** 对象 → CQ 码参数串（含开头的逗号；没有参数就返回空串） */
function stringifyCqParams(data) {
  const parts = []
  for (const [key, value] of Object.entries(data ?? {})) {
    if (value === undefined || value === null) continue
    parts.push(`${key}=${escapeCq(value)}`)
  }
  return parts.length ? `,${parts.join(',')}` : ''
}

/** 数组里的键值统一成字符串：`qq: 123` 和 `qq: '123'` 得比得上 */
function normalizeData(data) {
  const out = {}
  for (const [key, value] of Object.entries(data ?? {})) {
    if (value === undefined || value === null) continue
    out[key] = typeof value === 'object' ? value : String(value)
  }
  return out
}

/** 合并相邻的 text 段（CQ 解析中间会切出很多小段，留着只会让下游做无用功） */
function mergeText(segments) {
  const out = []
  for (const seg of segments) {
    const prev = out[out.length - 1]
    if (seg.type === 'text' && prev?.type === 'text') {
      prev.data.text += seg.data.text
      continue
    }
    out.push(seg)
  }
  return out
}

/**
 * CQ 码字符串 → segment 数组。
 * 码外面的文字是**被转义过的**（要反转义），码里面的参数值也是。
 * @param {unknown} text
 * @returns {Array<{type: string, data: Record<string, unknown>}>}
 */
export function parseCqString(text) {
  const s = String(text ?? '')
  const segments = []
  // 参数里不可能出现裸 `[` `]`（那是 CQ 码的边界，进参数前一定转义过），所以这个正则够用
  const re = /\[CQ:([A-Za-z0-9_.-]+)((?:,[^[\]]*)?)\]/g
  let last = 0
  let m
  while ((m = re.exec(s))) {
    if (m.index > last) {
      const plain = unescapeCq(s.slice(last, m.index))
      if (plain) segments.push({ type: 'text', data: { text: plain } })
    }
    segments.push({ type: m[1].toLowerCase(), data: parseCqParams(m[2]) })
    last = m.index + m[0].length
  }
  if (last < s.length) {
    const plain = unescapeCq(s.slice(last))
    if (plain) segments.push({ type: 'text', data: { text: plain } })
  }
  return mergeText(segments)
}

/**
 * 单个 segment → CQ 码。
 * @param {{type?: string, data?: Record<string, unknown>}} segment
 * @returns {string}
 */
export function segmentToCq(segment) {
  const type = String(segment?.type ?? '').toLowerCase()
  if (!type) return ''
  if (type === 'text') return escapeCq(segment?.data?.text ?? '')
  return `[CQ:${type}${stringifyCqParams(segment?.data)}]`
}

/**
 * segment 数组 → CQ 码字符串。
 * text 段在 CQ 码里就是裸文字（要转义），别的段写成码。
 * @param {Array<unknown>} segments
 * @returns {string}
 */
export function segmentsToCq(segments) {
  return (Array.isArray(segments) ? segments : []).map(segmentToCq).join('')
}

/**
 * `message` 字段（字符串 | 数组 | 单个段对象）→ 统一的 segment 数组。
 * @param {unknown} message
 * @returns {Array<{type: string, data: Record<string, unknown>}>}
 */
export function normalizeSegments(message) {
  if (Array.isArray(message)) {
    const out = []
    for (const item of message) {
      if (item === undefined || item === null) continue
      if (typeof item === 'string') {
        if (item) out.push({ type: 'text', data: { text: item } })
        continue
      }
      if (typeof item !== 'object') continue
      const type = String(item.type ?? '').toLowerCase()
      if (!type) continue
      out.push({ type, data: normalizeData(item.data) })
    }
    return mergeText(out)
  }
  if (message && typeof message === 'object') {
    // 有的封装只给一个段对象；当单元素数组处理
    return normalizeSegments([message])
  }
  const s = String(message ?? '')
  if (!s) return []
  const trimmed = s.trim()
  if (trimmed.startsWith('[')) {
    // 先试「数组被 JSON 序列化成字符串」那种少见长相；解析不出来（或不是段数组）
    // 就当普通 CQ 码 —— 普通消息以 `[` 开头很常见，别在这里丢字
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed) && parsed.every((x) => x && typeof x === 'object' && typeof x.type === 'string')) {
        return normalizeSegments(parsed)
      }
    } catch {
      // 不是 JSON，走 CQ 码
    }
  }
  return parseCqString(s)
}

/**
 * 任意长相的消息 → CQ 码字符串（存原文、写日志用）。
 * @param {unknown} message
 * @returns {string}
 */
export function messageToCq(message) {
  return segmentsToCq(normalizeSegments(message))
}

/** 所有 at 段指向的 qq（含 `all`）。判定「@ 我」和渲染 @名字 都用它。 */
export function atTargets(segments) {
  return (Array.isArray(segments) ? segments : [])
    .filter((s) => s?.type === 'at')
    .map((s) => String(s.data?.qq ?? '').trim())
    .filter(Boolean)
}

/** 纯文字部分（日志、命令识别用；不带 [图片] 这类占位） */
export function textOf(message) {
  return normalizeSegments(message)
    .filter((s) => s.type === 'text')
    .map((s) => String(s.data.text ?? ''))
    .join('')
    .trim()
}

/** 一段是不是回复段：`[CQ:reply,id=xxx]` 或 `{type:'reply',data:{id}}` → id */
export function extractReplyId(message) {
  for (const seg of normalizeSegments(message)) {
    if (seg.type !== 'reply') continue
    const id = String(seg.data?.id ?? '').trim()
    if (id) return id
  }
  return undefined
}

/** 表情/媒体段 → 人话。模型看不懂 `[CQ:image,file=xxx.jpg]`，但看得懂「（图）」。 */
const MEDIA_WORDS = {
  face: '[表情]',
  mface: '[表情]',
  sface: '[表情]',
  record: '[语音]',
  video: '[视频]',
  json: '[卡片]',
  xml: '[卡片]',
  markdown: '[卡片]',
  forward: '[合并转发]',
  share: '[链接]',
  music: '[音乐]',
  poke: '[戳一戳]',
  dice: '[骰子]',
  rps: '[猜拳]',
  location: '[位置]',
}

/**
 * 消息 → 给模型看的人话（{@link humanizeCq}）。
 *
 * @param {unknown} message CQ 码字符串或 segment 数组
 * @param {object} [options]
 * @param {(qq: string) => string | undefined} [options.atName] 号码 → 名字（查名册；查不到就退回号码）
 * @param {string | number} [options.selfId] @ 到自己的时候换成「[在 @ 你]」，比一串号码好懂
 * @param {boolean} [options.imageLinks] 图要不要带上直链（有些实现给的 url 是内网地址，默认不带）
 * @param {number} [options.maxLength] 超长就截断（引用行要塞进一行里）
 * @returns {string}
 */
export function humanizeCq(message, options = {}) {
  const { atName, selfId, imageLinks = false, maxLength } = options
  const self = selfId === undefined || selfId === null ? '' : String(selfId)
  const parts = []
  for (const seg of normalizeSegments(message)) {
    const type = seg.type
    if (type === 'text') {
      parts.push(String(seg.data.text ?? ''))
      continue
    }
    if (type === 'at') {
      const qq = String(seg.data.qq ?? '').trim()
      if (qq === 'all') parts.push('@全体成员')
      else if (self && qq === self) parts.push('[在 @ 你]')
      else parts.push(`@${atName?.(qq) || qq}`)
      continue
    }
    if (type === 'image') {
      const url = String(seg.data.url ?? '').trim()
      if (imageLinks && /^https?:\/\//i.test(url)) parts.push(`（图 ${url}）`)
      else parts.push('（图）')
      continue
    }
    if (type === 'file') {
      const name = String(seg.data.name ?? seg.data.file ?? '').trim()
      parts.push(name ? `[文件 ${name}]` : '[文件]')
      continue
    }
    if (type === 'reply') continue // 由信封的「↩ 回复 …」那一行单独表达
    parts.push(MEDIA_WORDS[type] ?? `[${type}]`) // 以后 QQ 加了新类型，也别把生码喂给模型
  }
  const text = parts
    .join('')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
  if (maxLength && text.length > maxLength) return `${text.slice(0, maxLength)}…`
  return text
}
