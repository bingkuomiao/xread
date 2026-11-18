import type { BookSource } from '../types'

// ─── 书源静态兼容性检测 ─────────────────────────────────────────────────
// XRead 后端（Rust + rquickjs）只实现了 Legado 书源语法的一个子集。本模块
// 依据后端 parser/js.rs 与 parser/rule_engine.rs 的实际支持边界，对书源规则做
// 纯静态扫描（零网络、秒级），给出 A/B/C 分级与具体问题清单。
// 规则清单源自仓库自带的 tools/check_sources.py（曾对 504 源做体检），此处
// 移植为 TS 并补充了正文阶段、webView、顶层 return、图片源等检测项。
//
// 与原脚本的重要差异：原脚本把「非 📚小说 分组」一律判 C（不兼容）。但用户
// 已验证可用的漫画源会被冤枉，故这里不直接判 C。进一步：漫画/图片源若正文经
// @js 产出 <img> 且配置了 imageStyle（已验证的渲染路径），直接判 A 兼容；只有
// 未识别到该路径、或叠加缺失 java / webView / Jsoup / @get·@put 等硬缺口时才
// 标 B／C —— 与书源测试「避免误伤正常源」的原则一致。

export type CompatLevel = 'A' | 'B' | 'C'

export interface CompatIssue {
  code: string
  label: string
  detail: string
  // 该问题会把书源判到哪个等级（C 为硬不兼容，B 为有风险/需人工）
  level: 'B' | 'C'
}

export interface CompatResult {
  level: CompatLevel
  issues: CompatIssue[]
  // 当无其他问题时给出的友好小结（如已识别的漫画/图片源渲染路径），
  // 供弹窗在「无问题」时展示更贴切的提示，替代通用的「规则语法全部受支持」。
  note?: string
}

export interface CompatSummary {
  A: number
  B: number
  C: number
  total: number
}

// js.rs 中 java_obj.set(...) 实际实现的方法（+ shim 补的 getAppVariant）
const JAVA_IMPL = new Set([
  'aesBase64DecodeToString', 'ajax', 'androidId', 'base64Decode',
  'base64Encode', 'decodeURI', 'decodeURIComponent', 'deviceID',
  'encodeURI', 'encodeURIComponent', 'get', 'getCookie',
  'getWebViewUA', 'hexDecodeToString', 'lang', 'log', 'longToast',
  'md5Encode', 'now', 'post', 'put', 'qread', 'reLoginView',
  'refreshExplore', 'setAllCookies', 'showBrowser', 'startBrowser',
  'timeFormat', 'toast', 'uuid', 'getAppVariant',
])

// 可直接当 CSS 标签的 Legado @tag 后缀
const TAG_NAMES = [
  'li', 'dd', 'dt', 'a', 'div', 'span', 'p', 'tr', 'td', 'th',
  'ul', 'ol', 'option', 'h1', 'h2', 'h3', 'h4', 'h5', 'img',
  'section', 'article', 'dl', 'table', 'tbody', 'em', 'b', 'strong',
]
const TAG_CHAIN_RE = new RegExp(
  `@(?:tag\\.)?(${[ ...TAG_NAMES ].sort((a, b) => b.length - a.length).join('|')})\\b`,
  'i',
)

// 参与扫描的字段：规则对象 + URL + jsLib + 登录相关 + header
const BLOB_KEYS = [
  'ruleSearch', 'ruleBookInfo', 'ruleToc', 'ruleContent', 'ruleExplore',
  'searchUrl', 'exploreUrl', 'jsLib', 'loginUi', 'loginCheckJs',
  'coverDecodeJs', 'header',
]
const LIST_FIELDS: [string, string][] = [
  ['ruleToc', 'chapterList'],
  ['ruleSearch', 'bookList'],
  ['ruleExplore', 'bookList'],
]

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

// 把字段值按「原始文本」展开（不做 JSON.stringify，否则规则里的换行会被转义成
// 字面 \n，导致 `njava.getString` 这类粘连让 \bjava 词边界失效、漏检 java 方法）
function flatten(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(flatten).join('\n')
  if (typeof v === 'object') return Object.values(v as Record<string, unknown>).map(flatten).join('\n')
  return String(v)
}

function blobOf(src: Record<string, unknown>): string {
  return BLOB_KEYS.map((k) => flatten(src[k])).join('\n')
}

function javaMethods(blob: string): string[] {
  const found = new Set<string>()
  for (const m of blob.matchAll(/\bjava\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    found.add(m[1])
  }
  return [ ...found ]
}

function listValue(src: Record<string, unknown>, ruleKey: string, field: string): string {
  return str(asRecord(src[ruleKey])[field])
}

// 列表规则是否需要降级：含 @tag.li/@li 链，且不是 JS 规则、不含 ## / {{}} / css:
function isTagChain(v: string): boolean {
  if (!v || /<js>|@js:/.test(v)) return false
  if (v.includes('##') || v.includes('{{') || v.includes('css:')) return false
  return TAG_CHAIN_RE.test(v)
}

/**
 * 检测单个书源的静态兼容性。
 * A = 原生兼容；B = 有风险/需人工确认（通常仍可用）；C = 硬不兼容（基本读不了）。
 */
export function checkSourceCompatibility(
  source: BookSource | Record<string, unknown>,
): CompatResult {
  const src = asRecord(source)
  const blob = blobOf(src)
  const issues: CompatIssue[] = []
  const push = (issue: CompatIssue) => issues.push(issue)

  // ── C：硬不兼容 ────────────────────────────────────────────────────
  const missing = javaMethods(blob).filter((m) => !JAVA_IMPL.has(m))
  if (missing.length) {
    push({
      code: 'JAVA_MISSING',
      label: `缺失 java 方法 (${missing.slice(0, 4).join(', ')}${missing.length > 4 ? '…' : ''})`,
      detail: `${missing.join('、')} 在 XRead 未实现，调用会抛 not a function，规则返回空或整页兜底。`,
      level: 'C',
    })
  }
  if (/Packages\.|org\.jsoup/.test(blob)) {
    push({
      code: 'JSOUP',
      label: '依赖 Java Jsoup',
      detail: 'Packages. / org.jsoup 需要 Java 类，QuickJS 环境不可用，目录/正文规则会失效。',
      level: 'C',
    })
  }
  if (/"webView"|"webJs"|"webViewDelayTime"|webView\b/.test(blob)) {
    push({
      code: 'WEBVIEW',
      label: '依赖 WebView 渲染',
      detail: 'URL options 含 webView/webJs，XRead 无浏览器渲染能力，规则无法执行。',
      level: 'C',
    })
  }

  // ── B：有风险 / 需人工确认 ─────────────────────────────────────────
  const chains = LIST_FIELDS.filter(([rk, fld]) => isTagChain(listValue(src, rk, fld)))
  if (chains.length) {
    push({
      code: 'TAG_CHAIN',
      label: `列表使用 @tag 链 (${chains.map(([rk]) => rk).join('、')})`,
      detail: 'XRead 的列表选择只取 @ 前第一段，其余丢弃，目录容易退化成 1 章；可改写为 CSS 后代选择器。',
      level: 'B',
    })
  }
  const contentBlob = flatten(src.ruleContent)
  if (/@get:\{|@put:\{/.test(contentBlob)) {
    push({
      code: 'CONTENT_VAR',
      label: '正文规则使用 @get/@put 源变量',
      detail: 'XRead 未在正文阶段加载/插值源变量，裸 @get 不替换会导致正文为空，建议改成自足规则。',
      level: 'B',
    })
  }
  // lookbehind 排除 {{$.x}} 的第二个 {，只命中真正的单花括号模板
  if (/(?<!\{)\{\$\./.test(blob)) {
    push({
      code: 'SINGLE_BRACE',
      label: '单花括号模板 {$.x}',
      detail: '字段规则里的单花括号 {$.x} 不会被替换为模板，需改成双花括号 {{$.x}}。',
      level: 'B',
    })
  }
  // blob 经 JSON.stringify，规则里的换行会变成字面 "\n"，两种都要识别
  if (/(?:^|\\n|\n)\s*return\b/.test(blob) && !/\(function|=>|\bfunction\b/.test(blob)) {
    push({
      code: 'TOP_RETURN',
      label: '疑似顶层 return',
      detail: 'eval 直接执行脚本，顶层 return 会报 Illegal return statement，需把代码包进 IIFE。',
      level: 'B',
    })
  }
  if (str(src.loginUrl) || str(src.loginUi)) {
    push({
      code: 'LOGIN_REQUIRED',
      label: '需要登录',
      detail: '配置了 loginUrl/loginUi，需在书源管理里完成登录后才能正常搜索与阅读。',
      level: 'B',
    })
  }
  if (!listValue(src, 'ruleToc', 'chapterList').trim()) {
    push({
      code: 'NO_TOC',
      label: '无目录规则（下载类源）',
      detail: 'ruleToc.chapterList 为空，导入后没有在线目录可读，本身合法但用途有限。',
      level: 'B',
    })
  }
  const group = str(src.bookSourceGroup)
  const isMediaGroup = /漫画|影视|有声|音乐|短剧|大人/.test(group)
  // 正文规则对象：content 是实际规则串，imageStyle 是「正文内图片布局」字段。
  // flatten() 只取 object 的值会丢掉键名，故 imageStyle 必须直接读字段。
  // 关键：imageStyle 在纯文本小说源里也很常见（只是内联图片的布局），且取值 "0"
  // 表示「未配置」，不能仅凭「字段存在」就把源判成图片/非文本源。只有真实取值
  // （非 0 / 空 / none）才表示图片渲染已配置。
  const contentObj = asRecord(src.ruleContent)
  const contentStr = str(contentObj.content)
  const imageStyleRaw = str(contentObj.imageStyle).trim()
  const imageStyleReal =
    imageStyleRaw !== '' && imageStyleRaw !== '0' && imageStyleRaw.toLowerCase() !== 'none'
  const hasImgMarker = /<img|imageDecode/i.test(contentStr)
  // 是否「图片/非文本源」：需有明确信号——显式图片类型、媒体分组、或正文产出图片。
  // 单凭 imageStyle 字段存在不足以判定（文本源也常带该字段，且 "0" 表示未配置）。
  const isImageSource =
    src.bookSourceType === 2 ||
    isMediaGroup ||
    hasImgMarker
  // 已验证的「图片渲染路径」：正文含 <img>/imageDecode，或配置了真实 imageStyle。
  // 命中即视为已知可用渲染路径，判为兼容，不再标「需人工确认」。
  const imageRenderPath = hasImgMarker || imageStyleReal
  if (isImageSource && !imageRenderPath) {
    push({
      code: 'NON_TEXT',
      label: '疑似图片/非文本源',
      detail: 'XRead 正文链路面向文本小说，该源被识别为图片/媒体源（图片类型或媒体分组），但正文未检出 <img>/imageDecode、也未配置真实 imageStyle，渲染路径不明，需人工确认是否可用。',
      level: 'B',
    })
  }

  const level: CompatLevel = issues.some((i) => i.level === 'C')
    ? 'C'
    : issues.length
      ? 'B'
      : 'A'
  // 已识别为「兼容」的漫画/图片源：给出更贴切的小结，避免显示通用的小说措辞
  const note =
    level === 'A' && isImageSource && imageRenderPath
      ? '漫画/图片源：正文含 <img>/imageDecode 或已配置 imageStyle，已知图片渲染路径可用'
      : undefined
  return { level, issues, note }
}

/**
 * 判断是否为漫画/图片类书源（用于深度测试时自动切换为漫画关键词搜索）。
 * 三类信号任一命中即视为漫画源：bookSourceType=2、分组含「漫画」、正文规则含 imageStyle/<img。
 */
export function isComicSource(
  source: BookSource | Record<string, unknown>,
): boolean {
  const src = asRecord(source)
  const group = str(src.bookSourceGroup)
  const contentObj = asRecord(src.ruleContent)
  // imageStyle 是「正文内图片布局」字段，纯文本小说源也常带它（且 "0" 表示未配置），
  // 不能单独作为漫画信号，否则会把带 imageStyle 的小说源误判为漫画源去换关键词。
  const imageStyleRaw = str(contentObj.imageStyle).trim()
  const imageStyleReal =
    imageStyleRaw !== '' && imageStyleRaw !== '0' && imageStyleRaw.toLowerCase() !== 'none'
  return (
    src.bookSourceType === 2 ||
    /漫画|影视|有声|音乐|短剧|大人/.test(group) ||
    imageStyleReal ||
    /<img|imageDecode/i.test(str(contentObj.content))
  )
}

export function summarizeCompatibility(results: CompatResult[]): CompatSummary {
  const summary: CompatSummary = { A: 0, B: 0, C: 0, total: results.length }
  for (const r of results) summary[r.level] += 1
  return summary
}

/**
 * 深度测试的目标等级：选中「全部」时测全部书源；点选概览卡片或标签时只测该等级。
 */
export function deepTestLevelsFor(filterLevel: CompatLevel | 'ALL'): CompatLevel[] {
  return filterLevel === 'ALL' ? ['A', 'B', 'C'] : [filterLevel]
}

export const LEVEL_META: Record<CompatLevel, { label: string; hint: string }> = {
  A: { label: '兼容', hint: '规则语法后端全部支持' },
  B: { label: '需留意', hint: '有风险，通常仍可用，建议深度测试确认' },
  C: { label: '不兼容', hint: '硬缺口，基本读不了' },
}

// ─── 兼容检测结论写回书源分组 ───────────────────────────────────────
// 分组在书源管理页按 /[,;；、]/ 切分，这里沿用同一套分隔符，保证标记能成为
// 一个可被筛选的独立分组，同时不破坏用户原有的分组。
export const DEEP_GROUP_WARN = '需留意'
export const DEEP_GROUP_BAD = '不兼容'
const DEEP_GROUPS: string[] = [DEEP_GROUP_WARN, DEEP_GROUP_BAD]
export type DeepGroupLabel = typeof DEEP_GROUP_WARN | typeof DEEP_GROUP_BAD | null

/**
 * 依据「静态兼容等级」返回要写入的分组标记：
 * - C 不兼容 → 「不兼容」
 * - B 需留意 → 「需留意」
 * - A 兼容    → null（清除已有标记）
 *
 * 标记只由静态等级决定，与深度链路测试的结果无关：深度测试仅负责展示链路
 * 详情并触发「完成一个写回一个」，不再改写标记。这样静态判「需留意」的源
 * 不会因为一次网络失败 / 正文为空被错标成「不兼容」，三种标记各归各、不串。
 */
export function compatGroupLabelFor(level: CompatLevel): DeepGroupLabel {
  if (level === 'C') return DEEP_GROUP_BAD
  if (level === 'B') return DEEP_GROUP_WARN
  return null
}

/**
 * 在原有分组基础上应用标记：只去掉旧的「需留意/不兼容」，再追加新标记。
 * 书源测试写的「失效」分组不属于 DEEP_GROUPS，会被原样保留，互不覆盖。
 * 无标记且不需要清除时原样返回，避免把用户原本的分隔符规范化造成无谓写回。
 */
export function applyDeepGroup(current: string, label: DeepGroupLabel): string {
  const parts = current.split(/[,;；、]/).map((s) => s.trim()).filter(Boolean)
  const hasMarker = parts.some((p) => DEEP_GROUPS.includes(p))
  if (!hasMarker && !label) return current
  const kept = parts.filter((p) => !DEEP_GROUPS.includes(p))
  if (label) kept.push(label)
  return kept.join(',')
}
