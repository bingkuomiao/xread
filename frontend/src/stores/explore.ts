import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { exploreBook, getExploreKinds } from '../api/explore'
import { useSourceStore } from './source'
import type { SearchBook, BookSource, ExploreKind } from '../types'
import {
  getInitialExploreCategoryUrl,
  parseExploreCategories,
  type ExploreCategory,
} from '../utils/exploreCategories'

/**
 * 发现页首页书列缓存：按「书源 + 榜单 + 变量」维度缓存 `exploreBook` 第 1 页，
 * 让重复进入发现页 / 切回某源时首屏瞬时出书单，省去一次后端对外网书源的真实请求。
 *
 * 安全性约束（务必遵守，否则会抵消 1.0.120 的修复）：
 * - 仅缓存「非空的」首页结果（空结果一律不入库），因此命中缓存绝不可能是「暂无数据」。
 * - key 含榜单 URL 与变量：写操作（切源/切分类/改筛选）必然产生新 key 而失效，
 *   不会掩盖用户主动刷新；榜单 URL 始终取自「带变量的第二次控件拉取」之后的权威值。
 * - **只缓存书列、不缓存控件**：发现页控件（kinds）的榜单 URL 依赖筛选变量在 URL
 *   解析时生效（1.0.120 因此才加了「空变量控件 → 补默认变量控件」两次拉取），缓存这类
 *   变量相关控件并在跨次访问中复用，会把错误/默认榜单 URL 带回来，正是本次回归的根因，
 *   故控件严格不走缓存，保持与 1.0.120 完全一致的拉取流程。
 */
interface CachedBooks {
  books: SearchBook[]
  ts: number
}
const booksCache = new Map<string, CachedBooks>()
/** 首页书列缓存有效期：2 分钟内复用，过期后正常网络拉取。 */
const BOOKS_TTL = 2 * 60 * 1000
/** 缓存条目上限：书源×榜单×变量组合数本就有限，超出时丢弃最旧条目，避免长会话内存无界增长。 */
const BOOKS_CACHE_MAX = 50

/** 把变量对象规范成稳定 key（键排序 + 值序列化），用于缓存命中判定。 */
function varsKeyOf(vars: Record<string, string>): string {
  const keys = Object.keys(vars).sort()
  const flat = keys.map((k) => `${k}=${vars[k]}`).join('&')
  return flat || '-'
}

/** 发现页默认书源在 localStorage 中的键，供书源工作区等处复用。 */
export const EXPLORE_SOURCE_KEY = 'xread-explore-source'

/** 安全读取本地偏好（SSR / 隐私模式 / 测试环境下 localStorage 可能不可用）。 */
function readSavedExploreSource(): string | null {
  try {
    return localStorage.getItem(EXPLORE_SOURCE_KEY)
  } catch {
    return null
  }
}

/**
 * 用户明确设置的发现默认书源，是 localStorage 偏好的「响应式镜像」。
 * 必须是 Vue ref：书源工作区按钮通过 computed 读取 isExploreDefaultSource()，
 * 只有响应式依赖变化才会即时刷新；直接读 localStorage 不会被 Vue 追踪，
 * 会出现「点了开关要切走再切回、按钮才更新」。
 */
const preferredSourceUrl = ref<string>(readSavedExploreSource() || '')

/**
 * 从 localStorage 重新同步偏好（store 初始化 / 书源列表变化 / 多标签页修改后）。
 * 读不到记录（隐私模式、外部清空）时保留当前会话里的镜像，避免把刚点出的状态冲掉。
 */
function syncPreferredSourceUrl() {
  const saved = readSavedExploreSource()
  if (saved !== null) preferredSourceUrl.value = saved
}

/** 供组件在切换书源时主动刷新镜像，保证看到的是最新偏好。 */
export function refreshExploreDefaultPreference() {
  syncPreferredSourceUrl()
}

/** 判断某书源是否已是发现页默认源（store 尚未初始化时也能读本地偏好）。 */
export function isExploreDefaultSource(url: string): boolean {
  if (!url) return false
  return preferredSourceUrl.value === url
}

/**
 * 获取当前发现页默认书源 URL（未设置时为 ''）。
 * 供搜索页「单个书源」默认值复用，使搜索默认书源与发现页默认书源保持同一来源：
 * 用户在发现页调整默认书源后，单书源搜索的默认值随之改变，无需重复设置。
 */
export function getExploreDefaultSourceUrl(): string {
  return preferredSourceUrl.value
}

export const useExploreStore = defineStore('explore', () => {
  const sourceStore = useSourceStore()

  const activeSourceUrl = ref<string>('')
  const activeCategoryUrl = ref<string>('')

  // 本会话内用户是否主动做过「设为默认 / 取消默认」选择。
  // 为 true 时服务端偏好同步不再覆盖本地选择：未登录或写入延迟时服务端仍是旧值，
  // 照旧覆盖会把刚点出的状态拉回去（发现管理页默认书源、搜索框当前书源不更新）。
  const userChoseInSession = ref(false)

  // 发现页控件（线路/类型/频道/平台/榜单），由后端执行书源 exploreUrl 脚本得到
  const kinds = ref<ExploreKind[]>([])
  const variables = ref<Record<string, string>>({})
  const kindsLoading = ref(false)

  const books = ref<SearchBook[]>([])
  const loading = ref(false)
  const page = ref(1)
  const hasMore = ref(true)
  const error = ref<string | null>(null)

  /**
   * 操作代次令牌：每次发起「切书源 / 切分类 / 切筛选」这类会触发异步拉取的动作时自增。
   * 异步等待（网络请求）返回后若令牌已变化，说明已有更新的操作发起，旧结果直接丢弃，
   * 避免多个并发的 applySource / setCategory 互相覆盖 books / activeCategoryUrl，
   * 造成「默认榜单先显示暂无数据、手动再点一次才出来」的竞态。
   */
  const opToken = ref(0)

  // 筛选出启用了 explore 的书源
  const exploreSources = computed(() => {
    return sourceStore.sources.filter((s: BookSource) => s.enabledExplore && s.exploreUrl)
  })

  // 当前选中的书源对象
  const currentSource = computed(() => {
    return sourceStore.sources.find((s: BookSource) => s.bookSourceUrl === activeSourceUrl.value)
  })

  // 可切换的下拉筛选控件（类型 / 频道 / 平台 / 字数 / 更新 / 排序，排除「线路」）
  const filterKinds = computed(() =>
    kinds.value.filter((kind) => {
      if (kind.type !== 'select') return false
      // 排除「线路」筛选控件
      if (kind.title === '线路' || kind.paramKey === '线路') return false
      // 有候选项最好；若书源未给 chars（如「平台」由云端配置动态提供），
      // 也要保留控件并回填默认值，否则用户完全看不到这个筛选项。
      return (kind.chars?.length ?? 0) > 0 || !!kind.paramKey || !!kind.default
    }),
  )

  // 榜单 / 分类标签（可点击并加载对应书单）
  const rankingKinds = computed(() =>
    kinds.value.filter((kind) => {
      // button / select / text 不是书单入口
      if (kind.type === 'button' || kind.type === 'select' || kind.type === 'text') return false
      const title = kind.title?.trim() || ''
      // 过滤掉「晴天书架」、「登录晴天书源」等无关引流或外链项
      if (title.includes('晴天书架') || title.includes('登录晴天') || title.includes('番茄书架')) {
        return false
      }
      const url = kind.url?.trim()
      if (!url) return false
      // `{{java.startBrowser(...)}}` 这类跳转动作不是书单地址，不能当榜单芯片点击
      return !url.startsWith('{{') && !url.includes('java.')
    }),
  )

  // 操作类按钮（更新配置 / 更新书源 / 书源设置等），仅作展示
  const buttonKinds = computed(() => kinds.value.filter((kind) => kind.type === 'button'))

  // 回退方案：书源脚本不可用时，使用静态 exploreUrl 解析出的分类
  const fallbackCategories = computed<ExploreCategory[]>(() =>
    parseExploreCategories(currentSource.value?.exploreUrl),
  )

  const activeFilterSummary = computed(() =>
    filterKinds.value
      .map((kind) => {
        const key = kind.paramKey || kind.title
        const value = variables.value[key] || kind.default || ''
        return { key, title: kind.title, value }
      })
      .filter((item) => !!item.value),
  )

  async function fetchKinds() {
    if (!activeSourceUrl.value) {
      kinds.value = []
      return
    }
    kindsLoading.value = true
    try {
      kinds.value = await getExploreKinds({
        bookSourceUrl: activeSourceUrl.value,
        variables: { ...variables.value },
      })
    } catch {
      kinds.value = []
    } finally {
      kindsLoading.value = false
    }
  }

  /**
   * 让变量与当前控件保持一致：
   * 保留用户已选项，补齐缺失项，并在选项已失效时回落到默认值。
   */
  function syncVariablesWithKinds() {
    const next: Record<string, string> = { ...variables.value }
    for (const kind of filterKinds.value) {
      if (!kind.paramKey) continue
      const chars = kind.chars ?? []
      const current = next[kind.paramKey]
      if (!current || (chars.length > 0 && !chars.includes(current))) {
        // 回落顺序：书源声明的 default → 候选项第一项。
        // 注意不能因 default 不在 chars 里就丢掉它（例如「平台」的候选项由 jsLib 动态提供）。
        const fallback = kind.default || chars[0] || ''
        if (fallback) next[kind.paramKey] = fallback
      }
    }
    variables.value = next
  }

  async function pickInitialCategory(token: number) {
    // 代次已变化（用户又切了书源/分类），本次选择作废，避免覆盖更新的结果。
    if (token !== opToken.value) return
    const firstRanking = rankingKinds.value[0]?.url?.trim()
    const fallbackUrl = getInitialExploreCategoryUrl(fallbackCategories.value)
    const target = firstRanking || fallbackUrl || ''

    if (!target) {
      activeCategoryUrl.value = ''
      books.value = []
      hasMore.value = false
      return
    }
    activeCategoryUrl.value = target
    await resetAndFetch(token)
  }

  async function applySource(url: string) {
    // 代次自增：之前任何未完成的拉取都会被本次作废。
    const token = ++opToken.value
    activeSourceUrl.value = url
    activeCategoryUrl.value = ''
    books.value = []
    variables.value = {}
    page.value = 1
    hasMore.value = true
    error.value = null

    // 第一次拉控件用空变量；随后按控件补全默认变量，再用「带变量的控件」重拉一次，
    // 保证榜单 URL 在变量生效后解析（后端要求筛选变量必须在 URL 解析时生效，
    // 否则书源会返回默认榜单而非目标榜单，导致默认分类首次为空）。
    await fetchKinds()
    if (token !== opToken.value) return
    syncVariablesWithKinds()
    await fetchKinds()
    if (token !== opToken.value) return
    await pickInitialCategory(token)
  }

  async function ensureActiveSource() {
    if (exploreSources.value.length === 0) {
      activeSourceUrl.value = ''
      activeCategoryUrl.value = ''
      kinds.value = []
      books.value = []
      hasMore.value = false
      return
    }

    // 先让响应式镜像与 localStorage 对齐（可能被其他标签页 / 服务端偏好改动过）
    syncPreferredSourceUrl()
    // 优先沿用用户上次选择的发现书源（若仍然有效）
    const saved = preferredSourceUrl.value || null
    const savedValid = saved && exploreSources.value.some((s) => s.bookSourceUrl === saved)
    const target = savedValid ? saved : exploreSources.value[0].bookSourceUrl

    const activeSourceStillValid = exploreSources.value.some(
      (source) => source.bookSourceUrl === activeSourceUrl.value,
    )
    if (!activeSourceUrl.value || !activeSourceStillValid) {
      // 等待本次切源完成，避免与同步服务端偏好（applyServerPreference）并发，
      // 两个 applySource 互相覆盖导致默认分类先空、手动再点才出来。
      await applySource(target)
    }
  }

  function setSource(url: string) {
    // 标记为用户主动选择：本会话内服务端旧偏好不再覆盖
    userChoseInSession.value = true
    // 先更新响应式镜像：书源工作区按钮、发现管理概览等 computed 会立即刷新，
    // 不必等切换书源或重开弹窗。
    preferredSourceUrl.value = url
    // 无论当前是否已在使用该源，都先记住用户偏好：
    // 书源工作区的开关可能在「当前源恰好已生效」时被拨到开，
    // 若此时提前 return，偏好没写进去，开关会立刻弹回「关」。
    try {
      localStorage.setItem(EXPLORE_SOURCE_KEY, url)
    } catch {
      // 隐私模式 / 无 localStorage 环境下跳过持久化，当前会话仍生效
    }
    if (activeSourceUrl.value === url) return
    void applySource(url)
  }

  /**
   * 立即应用用户明确的本地偏好（书源工作区刚点过「设为默认」）。
   * 打开发现管理弹窗 / 进入发现页时同步调用，让「发现概览」的当前默认书源
   * 与「切换书源」下拉的当前值不等网络请求就更新。列表尚未加载时也先应用。
   */
  function applyLocalPreference() {
    syncPreferredSourceUrl()
    const saved = preferredSourceUrl.value
    if (!saved || saved === activeSourceUrl.value) return
    const list = exploreSources.value
    if (list.length === 0 || list.some((s) => s.bookSourceUrl === saved)) {
      void applySource(saved)
    }
  }

  /**
   * 服务端偏好同步（多设备跟随）：本会话用户已主动选过默认源时直接跳过，
   * 避免未登录 / 写入延迟时用服务端旧值把刚点出的状态覆盖回去。
   * 无本地选择时才跟随服务端；该书源已失效则忽略。
   */
  function applyServerPreference(url: string) {
    if (userChoseInSession.value) return
    if (!url || url === activeSourceUrl.value) return
    if (!exploreSources.value.some((s) => s.bookSourceUrl === url)) return
    void applySource(url)
  }

  /** 切换筛选条件（线路/类型/频道/平台），榜单列表与书单会随之刷新 */
  async function setVariable(paramKey: string, value: string) {
    if (!paramKey) return
    const token = ++opToken.value
    variables.value = { ...variables.value, [paramKey]: value }
    await fetchKinds()
    if (token !== opToken.value) return
    syncVariablesWithKinds()
    await fetchKinds()
    if (token !== opToken.value) return
    await pickInitialCategory(token)
  }

  function setCategory(url: string) {
    const nextUrl = url.trim()
    if (!nextUrl) return
    if (activeCategoryUrl.value === nextUrl) return
    const token = ++opToken.value
    activeCategoryUrl.value = nextUrl
    void resetAndFetch(token)
  }

  async function resetAndFetch(token: number) {
    // 代次已变化，放弃本次重置，沿用更新的操作结果。
    if (token !== opToken.value) return
    books.value = []
    page.value = 1
    hasMore.value = true
    error.value = null
    await fetchMore(token)
  }

  /** 首页书列缓存 key：书源 + 榜单 + 变量组合，任意一项变化都产生新 key 而失效。 */
  function booksCacheKey(): string {
    return `${activeSourceUrl.value}::${activeCategoryUrl.value}::${varsKeyOf(variables.value)}`
  }

  async function fetchMore(token: number = opToken.value) {
    if (token !== opToken.value) return
    if (loading.value || !hasMore.value || !activeSourceUrl.value || !activeCategoryUrl.value) return

    // 首页命中缓存：瞬时出列表，仅在缓存偏旧时再于后台静默刷新，避免每次进入都等网络。
    if (page.value === 1) {
      const hit = booksCache.get(booksCacheKey())
      if (hit && Date.now() - hit.ts < BOOKS_TTL) {
        books.value = hit.books
        page.value = 2
        // 缓存较新（前半段有效期）：直接复用，不发起网络请求。
        if (Date.now() - hit.ts < BOOKS_TTL / 2) {
          loading.value = false
          return
        }
        // 缓存偏旧：仍先展示，并后台刷新（不阻塞首屏）。
        void refreshBooksInBackground(token, hit.ts)
        return
      }
    }

    loading.value = true
    error.value = null
    try {
      const result = await exploreBook({
        bookSourceUrl: activeSourceUrl.value,
        ruleFindUrl: activeCategoryUrl.value,
        page: page.value,
        variables: { ...variables.value },
      })
      // 网络返回前若已切到其它操作，丢弃本次结果，避免串台。
      if (token !== opToken.value) return

      if (result && result.length > 0) {
        books.value.push(...result)
        if (page.value === 1) {
          const key = booksCacheKey()
          booksCache.set(key, { books: [...result], ts: Date.now() })
          // 超出上限时丢弃最旧条目（Map 保持插入顺序）。
          while (booksCache.size > BOOKS_CACHE_MAX) {
            const oldest = booksCache.keys().next().value
            if (oldest === undefined) break
            booksCache.delete(oldest)
          }
        }
        page.value++
      } else {
        hasMore.value = false
      }
    } catch (err: unknown) {
      // 仅当仍是当前操作时才记录错误，避免旧请求覆盖新状态。
      if (token !== opToken.value) return
      error.value = (err as Error).message || '加载失败'
      hasMore.value = false
    } finally {
      loading.value = false
    }
  }

  /**
   * 后台静默刷新首页书列：不改变当前展示（仍以缓存为准），仅在返回结果仍属当前操作、
   * 且本次 fetchMore 发起后缓存未被更新的情况下，用新数据替换，避免列表闪烁。
   */
  async function refreshBooksInBackground(token: number, fetchedAt: number) {
    try {
      const result = await exploreBook({
        bookSourceUrl: activeSourceUrl.value,
        ruleFindUrl: activeCategoryUrl.value,
        page: 1,
        variables: { ...variables.value },
      })
      if (token !== opToken.value) return
      // 期间已有更新（用户切走又切回，或缓存被新写入）：放弃本次后台结果，避免回滚。
      const cur = booksCache.get(booksCacheKey())
      if (cur && cur.ts !== fetchedAt) return
      // 仅当用户仍停在第 1 页（page===2，尚未滚动翻页）时才用新数据替换；
      // 若用户已滚到后续页，直接替换会把已加载的多页书单截断、下次翻页跳号，故跳过。
      // 缓存仍照常更新，保证下次重新进入发现页拿到的是新首页。
      if (page.value === 2 && result && result.length > 0) {
        books.value = result
      }
      if (result && result.length > 0) {
        booksCache.set(booksCacheKey(), { books: [...result], ts: Date.now() })
      }
    } catch {
      // 后台刷新失败不影响已展示的缓存内容。
    }
  }

  // 初始化时加载书源数据
  async function init() {
    if (sourceStore.sources.length === 0) {
      await sourceStore.fetchSources()
    }
    await ensureActiveSource()
  }

  watch(exploreSources, () => {
    ensureActiveSource()
  })

  return {
    activeSourceUrl,
    activeCategoryUrl,
    books,
    loading,
    page,
    hasMore,
    error,
    kinds,
    kindsLoading,
    variables,
    exploreSources,
    currentSource,
    filterKinds,
    rankingKinds,
    buttonKinds,
    fallbackCategories,
    activeFilterSummary,
    init,
    setSource,
    applyLocalPreference,
    applyServerPreference,
    setVariable,
    setCategory,
    fetchMore,
    resetAndFetch,
  }
})
