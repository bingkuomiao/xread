<template>
  <div class="reader-source" :style="{ background: theme.popup, color: theme.fontColor }">
    <div class="source-header">
      <div class="header-left">
        <h3>切换书源</h3>
        <span class="source-count" v-if="preparedResults.length">{{ preparedResults.length }} 个结果</span>
      </div>
      <button class="close-btn" @click="store.closePanel()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
    </div>

    <div class="source-list" ref="listRef">
      <!-- 当前书：与其他卡片共用 ReaderBookCard，仅内容不同 -->
      <ReaderBookCard
        v-if="store.book"
        :card-bg="theme.popup"
        :card-fg="theme.fontColor"
        :cover="briefCover"
        :title="store.book.name"
        :meta="briefMeta"
        :primary-line="currentReadChapter ? `已读：${currentReadChapter}` : ''"
        :latest="store.book.latestChapterTitle"
        :source-name="briefSourceLabel"
        :source-url="briefSourceUrl"
        badge="当前"
        badge-type="current"
      />

      <div v-if="searching && !preparedResults.length" class="loading">
        <div class="spinner"></div>
        正在全网搜索同名书籍...
      </div>

      <div v-else-if="!preparedResults.length" class="empty">未找到其他书源</div>

      <template v-else>
        <!-- 推荐切换：多维评分（匹配/五项数据/可用性/数据质量）最优的源，随加载动态重排 -->
        <template v-if="recommendedResults.length">
          <div class="section-label recommend-label">推荐切换 · 综合各源数据优选</div>
          <ReaderBookCard
            v-for="item in recommendedResults"
            :key="item.book.bookUrl + item.book.origin"
            :card-bg="theme.popup"
            :card-fg="theme.fontColor"
            :cover="candidateCover(item.book)"
            :title="item.book.name"
            :meta="candidateMeta(item)"
            :primary-line="candidateWordCount(item)"
            :latest="item.meta.latest || item.book.lastChapter"
            :source-name="item.sourceLabel"
            :source-url="sourceHost(item.book.origin)"
            badge="推荐"
            :active="armedKey === candidateKey(item.book)"
            @click="onCandidateClick(item)"
          />
        </template>

        <!-- 其他可用源：恢复旧版详细卡片样式 -->
        <div class="section-label" v-if="otherResults.length">其他可用源</div>
        <ReaderBookCard
          v-for="item in otherResults"
          :key="item.book.bookUrl + item.book.origin"
          :card-bg="theme.popup"
          :card-fg="theme.fontColor"
          :cover="candidateCover(item.book)"
          :title="item.book.name"
          :meta="candidateMeta(item)"
          :primary-line="candidateWordCount(item)"
          :latest="item.meta.latest || item.book.lastChapter"
          :source-name="item.sourceLabel"
          :source-url="sourceHost(item.book.origin)"
          :badge="item.meta.status || undefined"
          badge-type="status"
          :active="armedKey === candidateKey(item.book)"
          @click="onCandidateClick(item)"
        />
      </template>

      <div v-if="searching && preparedResults.length" class="inline-loading">
        <div class="spinner small"></div>
        继续搜索其他书源...
      </div>

      <div v-if="hasMoreSources && !searching" class="load-more-wrap">
        <button class="load-more-btn" :disabled="loadingMore" @click="loadMoreSources">
          {{ loadingMore ? '加载中...' : '加载更多' }}
        </button>
      </div>
    </div>

    <!-- Switching Overlay -->
    <Transition name="fade">
      <div v-if="store.loading" class="switch-overlay" :style="{ background: theme.popup }">
        <div class="spinner"></div>
        <p>正在切换书源，请稍候...</p>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { reactive, computed, ref, onMounted, onUnmounted } from 'vue'
import ReaderBookCard from './ReaderBookCard.vue'
import { useReaderStore } from '../../stores/reader'
import { useAppStore } from '../../stores/app'
import { useSourceStore } from '../../stores/source'
import { getAvailableBookSourceSSE } from '../../api/search'
import { getBookInfo, getCoverUrl, saveLocalBookCover } from '../../api/bookshelf'
import { useBookshelfStore } from '../../stores/bookshelf'
import { sanitizeBooks } from '../../utils/cleanText'
import { isLocalBook } from '../../utils/localBook'
import { isPlaceholderAuthor, pickConsensusCover } from '../../utils/localBookMatch'
import {
  coverFingerprint,
  hasEffectiveCover,
  isPlausibleWordCount,
  parseWordCountToNumber,
  strictMatchNameAuthor,
} from '../../utils/bookSourceRecommend'
import type { Book, SearchBook } from '../../types'

type SourceMeta = {
  latest: string
  chapterCount: number
  wordCount: string
  updateTime: string
  status: string
  intro: string
}

type CandidateItem = {
  book: SearchBook
  meta: SourceMeta
  sameName: boolean
  sameAuthor: boolean
  sameLatest: boolean
  chapterHint: string
  available: boolean      // 详情接口是否成功拿到数据（书源可用信号）
  dataScore: number       // 五项数据完整度（0~5）
  score: number           // 多维综合推荐分
  reasons: string[]       // 推荐理由（用于卡片展示）
  sourceLabel: string     // 书源名称（方便识别，回退域名）
  wordNumber: number      // 字数数值（用于「字数多者优先」排序，0 表示不可信/缺失）
  coverKey: string        // 封面归一化标识（用于统计「同批封面数量」）
}

const store = useReaderStore()
const appStore = useAppStore()
const sourceStore = useSourceStore()
const bookshelfStore = useBookshelfStore()
const theme = computed(() => store.currentTheme)

// 书源 URL 归一化：去掉协议、# 后缀、末尾斜杠，便于同名不同写法的 URL 反查书源名
function normalizeSourceUrl(url?: string) {
  if (!url) return ''
  return url.replace(/^https?:\/\//i, '').replace(/#[\s\S]*$/, '').replace(/\/+$/, '').toLowerCase()
}

// origin(URL) → 书源显示名映射（用归一化 URL 匹配，兼容 # 后缀/协议差异）
const sourceNameByUrl = computed(() => {
  const map = new Map<string, string>()
  for (const source of sourceStore.sources) {
    const key = normalizeSourceUrl(source.bookSourceUrl)
    if (key && source.bookSourceName && !map.has(key)) {
      map.set(key, source.bookSourceName.trim())
    }
  }
  return map
})

// 统一的书源显示名：优先搜索结果自带 originName，其次按 URL 反查书源配置名，最后回退域名
function resolveSourceLabel(book: SearchBook) {
  const direct = (book.originName || '').trim()
  if (direct) return direct
  const mapped = sourceNameByUrl.value.get(normalizeSourceUrl(book.origin))
  if (mapped) return mapped
  return sourceHost(book.origin) || book.origin || '未知书源'
}

// 封面走书架同款后端代理，避免 raw http 图被拦截/跨域失败；加载失败时由公共组件回退首字占位
const briefCover = computed(() => getCoverUrl(store.book?.customCoverUrl || store.book?.coverUrl))

// 与附件书架卡片一致的「作者 · 共X章」副标题（当前书籍用 store 的章节总数）
const briefMeta = computed(() => {
  const book = store.book
  if (!book) return ''
  const parts: string[] = [cleanAuthor(book.author)]
  const count = book.totalChapterNum || store.chapters?.length || 0
  if (count) parts.push(`共${count}章`)
  return parts.join(' · ')
})
// 当前阅读进度章节（已读）：优先 durChapterTitle，其次当前章节标题
const currentReadChapter = computed(() => {
  const title = (store.book?.durChapterTitle || store.currentChapter?.title || '').trim()
  return title
})
// 当前书籍来源：优先书源名，其次按 URL 反查配置名，最后回退域名
const briefSourceLabel = computed(() => {
  const book = store.book
  if (!book) return ''
  const direct = (book.originName || '').trim()
  if (direct) return direct
  const mapped = sourceNameByUrl.value.get(normalizeSourceUrl(book.origin))
  return mapped || sourceHost(book.origin) || book.origin || ''
})
const briefSourceUrl = computed(() => sourceHost(store.book?.origin))

// 候选卡片封面：仅有效封面才走书架同款代理；占位/无效 URL 直接回退首字占位，
// 避免图1中「暂无封面」占位图被当成有封面的源。加载失败仍由公共组件回退首字。
function candidateCover(book: SearchBook) {
  return hasEffectiveCover(book.coverUrl) ? getCoverUrl(book.coverUrl!) : ''
}

// 书源展示只取域名，去掉冗长的完整 URL，列表更清爽
function sourceHost(url?: string) {
  if (!url) return ''
  const match = url.match(/^https?:\/\/([^/]+)/i)
  return match ? match[1] : url
}

// 从书源分类字段里提取完本/连载状态
function readingStatus(kind?: string): string {
  const text = kind || ''
  if (/完结|完本|已完|全书完|全本|end/i.test(text)) return '完本'
  if (/连载|更新中|未完|未完结|serial/i.test(text)) return '连载'
  return ''
}

// 书源返回的作者字段常自带「作者：」前缀，去除避免与模板前缀重复
function cleanAuthor(value?: string): string {
  const text = (value || '').trim()
  if (!text) return '未知作者'
  return text.replace(/^作者\s*[:：]\s*/, '').trim() || '未知作者'
}

// 详情增强：搜索结果自带最新章节/字数/更新时间，详情接口再补章节总数与完本状态
type InfoLike = {
  latestChapterTitle?: string
  lastChapter?: string
  totalChapterNum?: number
  wordCount?: string
  updateTime?: string
  kind?: string
  intro?: string
}
function buildMeta(info?: InfoLike | null, fallback?: InfoLike | null): SourceMeta {
  return {
    latest: info?.latestChapterTitle || fallback?.lastChapter || '',
    chapterCount: info?.totalChapterNum || 0,
    wordCount: info?.wordCount || fallback?.wordCount || '',
    updateTime: info?.updateTime || fallback?.updateTime || '',
    status: readingStatus(info?.kind || fallback?.kind),
    intro: (info?.intro || fallback?.intro || '').trim(),
  }
}

const searching = ref(false)
const loadingMore = ref(false)
const results = ref<SearchBook[]>([])
const lastIndex = ref(-1)
const hasMoreSources = ref(true)
const selectedCandidate = ref<CandidateItem | null>(null)
// 双击进入：单击仅选中（蓝框 armed），再次点击同一候选才真正切换
const armedKey = ref<string | null>(null)
function candidateKey(book: SearchBook) {
  return `${book.bookUrl}||${book.origin}`
}
function onCandidateClick(item: CandidateItem) {
  const key = candidateKey(item.book)
  if (armedKey.value === key) {
    armedKey.value = null
    handleSwitch(item.book)
  } else {
    armedKey.value = key
  }
}
const detailMap = reactive<Record<string, Book>>({})
const AVAILABLE_CONCURRENT_COUNT = 10
const ENRICH_LIMIT = 10
let enriching = false
let attempted = new Set<string>()
let availableSourceSSE: EventSource | null = null

function detailKey(book: SearchBook) {
  return `${book.origin}||${book.bookUrl}`
}

function normalizeText(value?: string) {
  return (value || '')
    .replace(/\s+/g, '')
    .replace(/[：:,.，。！？!?\-—_()（）【】\[\]<>《》'"“”‘’]/g, '')
    .toLowerCase()
}

function normalizeAuthorText(value?: string) {
  return normalizeText(value).replace(/^作者/, '')
}

// 多维推荐评分：匹配度 + 五项数据完整度 + 可用性 + 相对数据质量。
// 详情接口会持续异步回填 detailMap，preparedResults 依赖它，因此分数与推荐组会动态重排。
const preparedResults = computed<CandidateItem[]>(() => {
  if (!store.book) return []
  const currentName = normalizeText(store.book.name)
  const currentAuthor = normalizeAuthorText(store.book.author)
  const currentLatest = normalizeText(store.book.latestChapterTitle || store.currentChapter?.title)
  const currentChapterCount = store.book.totalChapterNum || 0

  const items: CandidateItem[] = results.value.map((book) => {
    const sameName = normalizeText(book.name) === currentName
    const sameAuthor = normalizeAuthorText(book.author) === currentAuthor
    // 严格匹配（复用共享判断标准）：书名 + 作者都严格相等，与本地书封面匹配同源。
    const strictMatch = strictMatchNameAuthor(book, store.book!.name, store.book!.author).both
    const sameLatest = !!currentLatest && normalizeText(book.lastChapter) === currentLatest
    const chapterHint = sameLatest
      ? '可无缝续读'
      : (book.lastChapter ? `目标源最新：${book.lastChapter}` : '')
    // 详情接口成功返回即视为“可用”信号；未返回则退回搜索结果自带字段
    const info = detailMap[detailKey(book)]
    const available = !!info
    const meta = buildMeta(info, book)

    // 有效封面：占用权重，避免「暂无封面」的源仅凭其它数据虚高排到第一位。
    const hasCover = hasEffectiveCover(book.coverUrl)
    const coverKey = coverFingerprint(book.coverUrl)
    // 字数只有可信时才计入完整度与排序（如 1015 章却标「23K」属书源写错，不采信）。
    const wordCountOk = isPlausibleWordCount(meta.wordCount, meta.chapterCount)
    const wordNumber = wordCountOk ? parseWordCountToNumber(meta.wordCount) : 0

    // 六项数据完整度：最新 / 章数 / 字数 / 更新 / 状态 / 简介，各计 1 分
    let dataScore = 0
    if (meta.latest) dataScore += 1
    if (meta.chapterCount > 0) dataScore += 1
    if (wordCountOk) dataScore += 1
    if (meta.updateTime) dataScore += 1
    if (meta.status) dataScore += 1
    if (meta.intro) dataScore += 1 // 有简介加分

    // 相对数据质量：章数不少于当前书，内容不比当前源少
    const chapterQuality = meta.chapterCount > 0 && meta.chapterCount >= currentChapterCount ? 1 : 0

    // 最后一章有效性：标题存在且不是「结束语/完本」这类无信息占位，才算有效对比信号。
    const lastChapterRaw = meta.latest || book.lastChapter || ''
    const lastChapterEffective =
      !!lastChapterRaw &&
      !/^(结束语|完本|全文完|完结|end|完|the end|暂无|无)$/i.test(normalizeText(lastChapterRaw))

    const reasons: string[] = []
    if (sameLatest) reasons.push('章节一致')
    if (strictMatch) reasons.push('书名作者匹配')
    else if (sameName) reasons.push('书名匹配')
    else if (sameAuthor) reasons.push('作者匹配')
    if (hasCover) reasons.push('有封面')
    if (meta.intro) reasons.push('有简介')
    if (available) reasons.push('可访问')
    if (dataScore >= 4) reasons.push('资料完整')

    const score =
      (sameName ? 3 : 0) +
      (sameAuthor ? 3 : 0) +
      (strictMatch ? 2 : 0) +      // 严格匹配优先于仅归一化相等
      (sameLatest ? 4 : 0) +
      (lastChapterEffective ? 1 : 0) + // 最后一章是有效章节名（可比对进度），非「结束语」占位
      (hasCover ? 6 : 0) +          // 封面优先级提高：有封面优先，避免无封面源虚高
      (available ? 2 : 0) +
      dataScore +
      chapterQuality

    return {
      book, meta, sameName, sameAuthor, sameLatest, chapterHint,
      available, dataScore, score, reasons,
      sourceLabel: resolveSourceLabel(book),
      wordNumber,
      coverKey,
    }
  })

  // 对比章节总数：比当前书章节更多的源加分（内容更全），全场最多的再额外加分。
  // 只加“更多”的分，章节数相同或更少的源不额外加分，避免倒逼数据虚高。
  const maxChapterCount = items.reduce((max, it) => Math.max(max, it.meta.chapterCount), 0)

  // 统计同批候选的字数：仅采信可信值，取最大值作为「字数最多」基准。
  const maxWordNumber = items.reduce((max, it) => Math.max(max, it.wordNumber), 0)
  // 统计同批候选的封面：同一张封面（归一化指纹）出现次数最多的视为「共识封面」。
  // 图2场景：多数源共用一张封面，个别源串图，共识封面持有者应排在前面。
  const coverCounts = new Map<string, number>()
  items.forEach((it) => {
    if (it.coverKey) coverCounts.set(it.coverKey, (coverCounts.get(it.coverKey) || 0) + 1)
  })
  const majorityCoverCount = coverCounts.size
    ? Array.from(coverCounts.values()).reduce((max, n) => Math.max(max, n), 0)
    : 0
  const majorityCoverKey = coverCounts.size
    ? Array.from(coverCounts.entries()).find(([, n]) => n === majorityCoverCount)?.[0] || ''
    : ''

  items.forEach((it) => {
    const count = it.meta.chapterCount
    if (count > 0 && currentChapterCount > 0 && count > currentChapterCount) {
      it.score += 1
      it.reasons.push('章节更多')
    }
    if (count > 0 && count === maxChapterCount) {
      it.score += 1
      it.reasons.push('章节最多')
    }
    // 字数：可信且为全场最多 +2；其余按相对全场最大值的比例给 0~1 分（字数多者优先）。
    if (it.wordNumber > 0 && maxWordNumber > 0) {
      if (it.wordNumber === maxWordNumber) {
        it.score += 2
        it.reasons.push('字数最多')
      } else {
        it.score += Math.max(0, it.wordNumber / maxWordNumber) // 0~1 的小数，字数多者更高
      }
    }
    // 封面一致性：持有共识封面且同批至少 2 个源用同一张 → 加权；用不同封面的源明显靠后。
    // 权重与「多数派封面」的票数挂钩，封面越集中（越多源认同）加分越高，最多 +6。
    if (majorityCoverCount >= 2 && it.coverKey === majorityCoverKey) {
      const coverBonus = Math.min(6, 2 + majorityCoverCount)
      it.score += coverBonus
      it.reasons.push(`封面一致(${majorityCoverCount}源)`)
    }
  })

  return items.sort(
    (a, b) =>
      b.score - a.score ||
      b.wordNumber - a.wordNumber || // 分数相近时，字数多者优先
      b.dataScore - a.dataScore,
  )
})

// 推荐切换：候选池 10 个，按综合评分取前 4 名，其余进“其他可用源”。
// 因为依赖 preparedResults，书源持续加载/详情回填时推荐组会自动重排。
const RECOMMEND_MAX = 4
const recommendedResults = computed(() => preparedResults.value.slice(0, RECOMMEND_MAX))
const recommendedKeys = computed(() => new Set(recommendedResults.value.map((item) => detailKey(item.book))))
const otherResults = computed(() =>
  preparedResults.value.filter((item) => !recommendedKeys.value.has(detailKey(item.book))),
)

// 卡片副标题：作者 · 共X章（与书架卡片一致）
// 详情未回填章节数时，回退用当前书的章节总数（同一本书各源章节数通常一致），确保作者后始终有章数。
function candidateMeta(item: CandidateItem) {
  const parts: string[] = [cleanAuthor(item.book.author)]
  const count = item.meta.chapterCount || store.book?.totalChapterNum || 0
  if (count) parts.push(`共${count}章`)
  return parts.join(' · ')
}

// 待切换源不显示"已读"，改为字数；字数不可信（如 432 章却标 17K）时不展示，避免误导。
function candidateWordCount(item: CandidateItem) {
  const w = (item.meta.wordCount || '').trim()
  if (!w || !isPlausibleWordCount(w, item.meta.chapterCount)) return ''
  return `字数：${w}`
}

onMounted(() => {
  // 加载书源列表，用于把候选 URL 反查成友好的书源名称
  if (sourceStore.sources.length === 0) {
    void sourceStore.fetchSources().catch(() => undefined)
  }
  startSearch()
})

onUnmounted(() => {
  closeAvailableSourceSSE()
})

function startSearch() {
  if (!store.book) return
  closeAvailableSourceSSE()
  searching.value = true
  loadingMore.value = false
  results.value = []
  lastIndex.value = -1
  hasMoreSources.value = true
  selectedCandidate.value = null
  Object.keys(detailMap).forEach((key) => { delete detailMap[key] })
  attempted = new Set<string>()
  coverFillDone = false

  openAvailableSourceSSE('initial')
}

// 对前若干个候选补详情（章节总数/完本状态），逐个写回、渐进展示，控制请求量
async function enrichCandidates() {
  if (enriching) return
  const targets = preparedResults.value
    .filter((item) => !detailMap[detailKey(item.book)] && !attempted.has(detailKey(item.book)))
    .slice(0, ENRICH_LIMIT)
  if (!targets.length) return
  enriching = true
  await Promise.all(targets.map(async (item) => {
    const key = detailKey(item.book)
    attempted.add(key)
    try {
      const info = await getBookInfo(item.book.bookUrl, item.book.origin)
      if (info) detailMap[key] = info
    } catch {
      // 详情拉取失败不影响列表，退回搜索结果自带字段，且不再重复请求
    }
  }))
  enriching = false
  // 补齐期间若有新结果，再尝试一轮
  if (preparedResults.value.some((item) => !detailMap[detailKey(item.book)] && !attempted.has(detailKey(item.book)))) {
    void enrichCandidates()
  }
}

// 阅读页顺手补封面：当前书是本地书且无封面时，从已 SSE 拉取的候选中取「共识封面」写回书架。
// 复用本页推荐结果（零额外搜索），只针对严格匹配的候选统计，避免串图；写回后静默刷新书架。
let coverFillDone = false
async function maybeFillCoverFromCandidates() {
  if (coverFillDone) return
  const currentBook = store.book
  if (!currentBook || !isLocalBook(currentBook)) return
  if (currentBook.customCoverUrl || currentBook.coverUrl) return
  const strictBooks = preparedResults.value
    .filter((it) => it.sameName && (it.sameAuthor || isPlaceholderAuthor(currentBook.author)))
    .map((it) => it.book)
  const pool = strictBooks.length ? strictBooks : preparedResults.value.map((it) => it.book)
  const consensus = pickConsensusCover(pool)
  if (!consensus) return
  coverFillDone = true
  const ok = await saveLocalBookCover(currentBook, consensus)
  if (ok) {
    currentBook.customCoverUrl = consensus
    bookshelfStore.fetchBooks().catch(() => undefined)
  }
}

function mergeCandidates(candidates: SearchBook[]) {
  if (!store.book || !candidates.length) return
  const currentBook = store.book
  const currentAuthor = normalizeAuthorText(currentBook.author)
  candidates.forEach((item) => {
    if (item.origin === currentBook.origin) return
    if (currentAuthor && item.author && normalizeAuthorText(item.author) !== currentAuthor) return
    const existed = results.value.some((candidate) =>
      candidate.origin === item.origin || (candidate.bookUrl === item.bookUrl && candidate.origin === item.origin),
    )
    if (!existed) {
      results.value.push(item)
    }
  })
}

type AvailableSourceMode = 'initial' | 'loadMore'
type AvailableSourceSSEPayload = {
  data?: SearchBook[]
  books?: SearchBook[]
  lastIndex?: number
  hasMore?: boolean
}

function closeAvailableSourceSSE() {
  if (!availableSourceSSE) return
  availableSourceSSE.close()
  availableSourceSSE = null
}

function parseAvailableSourcePayload(event: MessageEvent): AvailableSourceSSEPayload | null {
  try {
    return JSON.parse(event.data) as AvailableSourceSSEPayload
  } catch (error) {
    console.error('parse getAvailableBookSourceSSE payload failed', error)
    return null
  }
}

function applyAvailableSourcePayload(payload: AvailableSourceSSEPayload | null) {
  if (!payload) return
  const incoming = sanitizeBooks(
    Array.isArray(payload.data)
      ? payload.data
      : (Array.isArray(payload.books) ? payload.books : []),
  )

  if (typeof payload.lastIndex === 'number') {
    lastIndex.value = payload.lastIndex
  }
  if (typeof payload.hasMore === 'boolean') {
    hasMoreSources.value = payload.hasMore
  }
  mergeCandidates(incoming)

  if (!selectedCandidate.value && preparedResults.value.length) {
    void selectCandidate(preparedResults.value[0])
  }
}

function openAvailableSourceSSE(mode: AvailableSourceMode) {
  if (!store.book) return

  const beforeCount = results.value.length
  const stream = getAvailableBookSourceSSE({
    url: store.book.bookUrl,
    name: store.book.name,
    author: store.book.author,
    origin: store.book.origin,
    lastIndex: mode === 'loadMore' ? lastIndex.value : -1,
    concurrentCount: AVAILABLE_CONCURRENT_COUNT,
  })
  availableSourceSSE = stream

  stream.onmessage = (event) => {
    if (availableSourceSSE !== stream) return
    applyAvailableSourcePayload(parseAvailableSourcePayload(event))
  }

  stream.addEventListener('end', (event) => {
    if (availableSourceSSE !== stream) return
    applyAvailableSourcePayload(parseAvailableSourcePayload(event as MessageEvent))
    finishAvailableSourceSSE(stream, mode, beforeCount)
  })

  stream.onerror = (event) => {
    if (availableSourceSSE !== stream) return
    console.error('getAvailableBookSourceSSE failed', event)
    finishAvailableSourceSSE(stream, mode, beforeCount, true)
  }
}

function finishAvailableSourceSSE(
  stream: EventSource,
  mode: AvailableSourceMode,
  beforeCount: number,
  failed = false,
) {
  if (availableSourceSSE !== stream) return
  stream.close()
  availableSourceSSE = null

  if (mode === 'initial') {
    searching.value = false
  } else {
    loadingMore.value = false
  }

  if (!failed) {
    void enrichCandidates()
    void maybeFillCoverFromCandidates()
  }

  if (!selectedCandidate.value && preparedResults.value.length) {
    void selectCandidate(preparedResults.value[0])
  }

  if (failed) {
    if (mode === 'loadMore') {
      appStore.showToast('加载更多书源失败', 'error')
    }
    return
  }

  if (mode === 'loadMore') {
    const addedCount = results.value.length - beforeCount
    if (addedCount > 0) {
      appStore.showToast(`已新增 ${addedCount} 个书源`, 'success')
    } else if (!hasMoreSources.value) {
      appStore.showToast('没有更多书源了', 'warning')
    } else {
      appStore.showToast('本批次未找到更多匹配书源', 'warning')
    }
  }
}

async function selectCandidate(item: CandidateItem) {
  selectedCandidate.value = item
  try {
    const info = await getBookInfo(item.book.bookUrl, item.book.origin)
    if (selectedCandidate.value?.book.bookUrl !== item.book.bookUrl
      || selectedCandidate.value?.book.origin !== item.book.origin) return
    if (info) detailMap[detailKey(item.book)] = info
  } catch {
    // 详情拉取失败不影响列表，退回搜索结果自带字段
  }
}

function loadMoreSources() {
  if (!store.book || loadingMore.value || !hasMoreSources.value) return

  closeAvailableSourceSSE()
  loadingMore.value = true
  openAvailableSourceSSE('loadMore')
}

async function handleSwitch(res: SearchBook) {
  if (store.loading) return
  try {
    const nextBook = await store.switchSource(res.bookUrl, res.origin)
    store.closePanel()
    appStore.showToast(`已切换到 ${nextBook?.originName || nextBook?.origin || res.origin}`, 'success')
  } catch (e: any) {
    appStore.showToast(`切换失败: ${e?.message || '未知错误'}`, 'error')
  }
}
</script>

<style scoped>
.reader-source {
  display: flex;
  flex-direction: column;
  height: 100%;
  position: relative;
}

.source-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid rgba(0,0,0,0.06);
  flex-shrink: 0;
}

.header-left { display: flex; align-items: baseline; gap: 8px; }
.source-header h3 { font-size: 16px; margin: 0; }
.source-count { font-size: 11px; opacity: 0.5; }

.close-btn {
  width: 32px; height: 32px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 8px; color: inherit; opacity: 0.6;
  background: transparent; border: none; cursor: pointer;
}

.source-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}

.book-brief {
  display: flex;
  gap: 12px;
  margin: 8px 16px 14px;
  padding: 12px;
  border-radius: 14px;
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-primary) 14%, transparent);
}

.book-brief-cover {
  width: 56px;
  height: 76px;
  flex-shrink: 0;
  border-radius: 10px;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.06);
}

.book-brief-cover img,
.book-brief-placeholder {
  width: 100%;
  height: 100%;
}

.book-brief-cover img {
  object-fit: cover;
}

.book-brief-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  font-weight: 700;
}

.book-brief-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.book-brief-title {
  font-size: 15px;
  font-weight: 700;
}

.book-brief-meta {
  font-size: 12px;
  opacity: 0.68;
  line-height: 1.4;
}

.section-label {
  padding: 12px 20px 4px;
  font-size: 11px;
  letter-spacing: 0.05em;
  opacity: 0.4;
  font-weight: 600;
}

.recommend-label { color: var(--color-primary, #f43f5e); opacity: 0.9; }

.source-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 13px 20px;
  border-bottom: 1px solid rgba(0,0,0,0.06);
  cursor: pointer;
  transition: background 0.2s;
}

.source-item:hover { background: rgba(0,0,0,0.03); }
.source-item.selected {
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
  box-shadow: inset 3px 0 0 var(--color-primary, #f43f5e);
}

/* 书架同款卡片：左侧封面 + 右侧信息，最后一行书源名称与地址 */
.source-item.shelf-card {
  display: grid;
  grid-template-columns: 62px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  margin: 8px 14px;
  padding: 11px 12px;
  border: 1px solid var(--glass-border, rgba(255,255,255,0.5));
  border-radius: var(--radius-lg, 14px);
  background: var(--glass-bg, rgba(255,255,255,0.55));
  box-shadow: var(--glass-shadow, 0 6px 18px rgba(0,0,0,0.06));
  backdrop-filter: blur(var(--glass-blur, 12px)) saturate(var(--glass-saturate, 1.2));
  -webkit-backdrop-filter: blur(var(--glass-blur, 12px)) saturate(var(--glass-saturate, 1.2));
  border-bottom: 1px solid var(--glass-border, rgba(255,255,255,0.5));
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.source-item.shelf-card:hover {
  background: var(--glass-bg-hover, rgba(255,255,255,0.72));
  transform: translateY(-1px);
}
.source-item.shelf-card.selected {
  background: color-mix(in srgb, var(--color-primary) 10%, var(--glass-bg));
  box-shadow: 0 0 0 2px var(--color-primary, #f43f5e);
}

.shelf-cover {
  width: 62px;
  height: 86px;
  border-radius: 6px;
  overflow: hidden;
  position: relative;
  flex-shrink: 0;
  background: var(--color-bg-sunken, rgba(0,0,0,0.05));
  box-shadow: 0 4px 10px rgba(0,0,0,0.14), 0 0 0 1px rgba(0,0,0,0.04);
}
.shelf-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.shelf-cover-ph {
  width: 100%; height: 100%;
  display: flex; align-items: center; justify-content: center;
  font-size: 22px; font-weight: 700;
  color: var(--color-primary, #f43f5e);
  background: linear-gradient(160deg, color-mix(in srgb, var(--color-primary) 14%, transparent), rgba(70,134,121,0.08));
}
.shelf-rec-flag, .shelf-status-flag {
  position: absolute; top: 0; right: 0;
  padding: 2px 5px;
  font-size: 9px; font-weight: 700;
  color: #fff;
  background: var(--color-primary, #f43f5e);
  border-bottom-left-radius: 6px;
}
.shelf-status-flag { background: rgba(0,0,0,0.55); }

.shelf-info { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.shelf-title {
  font-size: 15px; font-weight: 800; color: var(--color-text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  line-height: 1.25;
}
.shelf-meta {
  font-size: 12px; opacity: 0.62;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.shelf-chapter {
  font-size: 12px; opacity: 0.78;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.shelf-read-chapter { color: var(--color-primary, #f43f5e); opacity: 0.92; }
.brief-source-row { margin-top: 2px; }
.shelf-source-row {
  display: flex; align-items: center; gap: 6px;
  min-width: 0; margin-top: 2px;
}
.shelf-source-name {
  flex-shrink: 0;
  font-size: 11px; font-weight: 600;
  padding: 1px 7px;
  border-radius: var(--radius-full, 999px);
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  color: var(--color-primary, #f43f5e);
  max-width: 60%;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.shelf-source-url {
  min-width: 0;
  font-size: 10px; opacity: 0.48;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.shelf-switch {
  flex-shrink: 0;
  padding: 6px 12px;
  font-size: 12px; font-weight: 600;
  color: #fff;
  background: var(--color-primary, #f43f5e);
  border: none;
  border-radius: var(--radius-full, 999px);
  cursor: pointer;
  transition: opacity 0.2s, transform 0.2s;
}
.shelf-switch:hover { opacity: 0.88; transform: scale(1.03); }
.shelf-switch:active { transform: scale(0.97); }

@media (max-width: 380px) {
  .source-item.shelf-card { grid-template-columns: 54px minmax(0, 1fr); gap: 9px; }
  .shelf-cover { width: 54px; height: 74px; }
  .shelf-title { font-size: 14px; }
}

.source-main { flex: 1; min-width: 0; }
.source-name-row { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; min-width: 0; flex-wrap: wrap; }
.source-name {
  font-weight: 600;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.compare-badge {
  flex-shrink: 0;
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.06);
  opacity: 0.72;
  white-space: nowrap;
}

.compare-badge.good {
  background: rgba(82, 196, 26, 0.14);
  color: #3f8f16;
  opacity: 1;
}

.compare-badge.status {
  background: rgba(0, 0, 0, 0.05);
  opacity: 0.6;
}

.source-chapter {
  font-size: 11px;
  opacity: 0.7;
  color: var(--color-primary, #f43f5e);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.source-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-top: 6px;
  font-size: 11px;
  opacity: 0.5;
}

.source-meta span + span::before {
  content: '·';
  margin-right: 10px;
  opacity: 0.6;
}

/* 旧版详细卡片：完整网址 + 书名 + 作者 + 最新章节 + 匹配标签 */
.source-book-name {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  margin-bottom: 4px;
  font-size: 13px;
  font-weight: 600;
  flex-wrap: wrap;
}
.source-label-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  max-width: 100%;
}
.source-label-host {
  font-size: 11px;
  font-weight: 400;
  opacity: 0.45;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.source-author-inline {
  font-size: 11px;
  font-weight: 400;
  opacity: 0.5;
  margin-bottom: 3px;
}
.source-compare-line {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 7px;
}
.compare-text {
  font-size: 11px;
  opacity: 0.55;
}
.compare-text.strong {
  color: var(--color-primary, #f43f5e);
  opacity: 0.92;
}
.compare-badge.outline {
  border: 1px solid rgba(0,0,0,0.1);
  background: transparent;
  opacity: 0.6;
}

.switch-btn {
  padding: 5px 13px;
  font-size: 11px;
  border-radius: 12px;
  border: 1px solid var(--color-border);
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0.7;
  flex-shrink: 0;
}

.source-item:hover .switch-btn {
  background: var(--color-primary, #f43f5e);
  color: white;
  border-color: var(--color-primary, #f43f5e);
  opacity: 1;
}

.compare-panel {
  margin: 10px 16px 18px;
  padding: 14px;
  border-radius: 16px;
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-primary) 14%, transparent);
}

.compare-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.compare-header h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
}

.switch-btn.primary {
  background: var(--color-primary, #f43f5e);
  border-color: var(--color-primary, #f43f5e);
  color: #fff;
  opacity: 1;
}

.switch-btn:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.compare-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.compare-card {
  padding: 12px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.6);
  border: 1px solid rgba(0, 0, 0, 0.06);
}

.compare-card.highlight {
  border-color: color-mix(in srgb, var(--color-primary) 28%, transparent);
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
}

.compare-title {
  margin-bottom: 8px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  opacity: 0.58;
}

.compare-name {
  font-size: 14px;
  font-weight: 700;
  line-height: 1.4;
  margin-bottom: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.compare-author {
  font-size: 12px;
  opacity: 0.7;
  margin-bottom: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.compare-origin {
  font-size: 11px;
  opacity: 0.55;
  margin-bottom: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.compare-stats { display: flex; flex-direction: column; gap: 5px; }

.stat-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 11px;
  line-height: 1.6;
}

.stat-key {
  flex: 0 0 30px;
  opacity: 0.5;
}

.stat-val {
  flex: 1;
  min-width: 0;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.85;
}

.stat-val.status-done { color: #3f8f16; opacity: 1; }
.stat-val.status-serial { color: var(--color-primary, #f43f5e); opacity: 1; }

.loading, .empty {
  padding: 40px 20px;
  text-align: center;
  opacity: 0.5;
  font-size: 14px;
}

.inline-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 20px;
  font-size: 12px;
  opacity: 0.55;
}

.load-more-wrap {
  padding: 16px 20px 24px;
  display: flex;
  justify-content: center;
}

.load-more-btn {
  min-width: 120px;
  padding: 10px 18px;
  border-radius: 999px;
  border: 1px solid rgba(0,0,0,0.08);
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.load-more-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
  border-color: var(--color-primary, #f43f5e);
  color: var(--color-primary, #f43f5e);
}

.load-more-btn:disabled {
  opacity: 0.5;
  cursor: wait;
}

.spinner {
  width: 24px;
  height: 24px;
  border: 2px solid rgba(0,0,0,0.1);
  border-top-color: var(--color-primary, #f43f5e);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin: 0 auto 12px;
}

.inline-loading .spinner,
.spinner.small {
  width: 14px;
  height: 14px;
  margin: 0;
  border-width: 2px;
}

@keyframes spin { to { transform: rotate(360deg); } }

.switch-overlay {
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  z-index: 20;
}

.switch-overlay p { margin-top: 16px; font-size: 14px; opacity: 0.8; }

@media (max-width: 640px) {
  .source-item {
    padding: 12px 16px;
    align-items: flex-start;
  }

  .source-action {
    padding-top: 2px;
  }

  .compare-panel {
    margin: 8px 12px 16px;
    padding: 12px;
  }

  .compare-header {
    flex-direction: column;
    align-items: stretch;
  }

  .compare-grid {
    grid-template-columns: 1fr;
  }
}
</style>
