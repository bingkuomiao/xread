<template>
  <div class="explore-view">
    <!-- 顶部区域与书籍列表同处一个滚动容器，下滑时整体向上滚走 -->
    <div class="content-panel" ref="scrollContainer" @scroll="handleScroll">
      <!-- 顶部标题 -->
      <header class="explore-header">
        <h2>发现</h2>
      </header>

      <!-- 筛选控件：原生 <select>（类型/频道/平台/字数/更新/排序等），
           与书源工作区「全部分组」下拉共用 .native-select 样式 -->
      <div v-if="store.filterKinds.length" class="filter-bar">
        <label
          v-for="kind in store.filterKinds"
          :key="kind.paramKey || kind.title"
          class="filter-select-field"
        >
          <span class="filter-select-label">{{ kind.title }}</span>
          <select
            class="native-select filter-select"
            :value="currentVarValue(kind)"
            :aria-label="kind.title"
            @change="selectFilterOption(kind, ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="opt in optionsFor(kind)" :key="opt" :value="opt">{{ opt }}</option>
          </select>
        </label>
      </div>

      <!-- 榜单 / 分类标签（默认最多2行，超出可展开） -->
      <div v-if="store.rankingKinds.length" class="ranking-wrapper">
        <div class="ranking-bar" :class="{ 'is-measuring': !rankingMeasured }">
          <button
            v-for="kind in visibleRankingKinds"
            :key="kind.url || kind.title"
            class="ranking-chip"
            :class="{ active: store.activeCategoryUrl === kind.url }"
            @click="onCategoryClick(kind)"
          >
            {{ kind.title }}
          </button>
        </div>
        <!-- 隐藏测量层：始终渲染全部标签，用于按行分组计算「前两行」的数量 -->
        <div ref="rankingMeasure" class="ranking-bar ranking-measure" aria-hidden="true">
          <button
            v-for="kind in store.rankingKinds"
            :key="`m-${kind.url || kind.title}`"
            class="ranking-chip"
            :class="{ active: store.activeCategoryUrl === kind.url }"
            tabindex="-1"
          >
            {{ kind.title }}
          </button>
        </div>
        <button
          v-if="rankingHasOverflow"
          type="button"
          class="ranking-toggle-btn"
          :title="isRankingExpanded ? '收起标签' : '展开更多标签'"
          @click="toggleRanking()"
        >
          <span>{{ isRankingExpanded ? '收起' : '展开' }}</span>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            class="toggle-icon"
            :class="{ 'is-expanded': isRankingExpanded }"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </div>

      <!-- 书籍列表：与书架一致的卡片网格 -->
      <BookGrid
        :books="store.books"
        :is-search="true"
        :loading="store.loading && store.books.length === 0"
        :empty-text="store.activeCategoryUrl ? '暂无数据' : '请选择书源或榜单'"
        @click="handleBookClick"
        @info="handleBookInfo"
        @addToShelf="handleAddToShelf"
      />

      <div class="end-state" v-if="!store.loading && !store.hasMore && store.books.length > 0">
        没有更多了
      </div>

      <div class="error-state" v-if="store.error">{{ store.error }}</div>
    </div>

    <BookDetailModal v-model="showDetail" :book="selectedBook" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useExploreStore } from '../stores/explore'
import { useReaderStore } from '../stores/reader'
import { saveBook } from '../api/bookshelf'
import { fetchExploreSourcePreference } from '../api/user'
import { useAppStore } from '../stores/app'
import BookGrid from '../components/BookGrid.vue'
import BookDetailModal from '../components/BookDetailModal.vue'
import type { Book, SearchBook, ExploreKind } from '../types'

const store = useExploreStore()
const readerStore = useReaderStore()
const appStore = useAppStore()
const router = useRouter()

const scrollContainer = ref<HTMLElement>()

function currentVarValue(kind: ExploreKind) {
  const key = kind.paramKey || kind.title
  const chars = kind.chars ?? []
  return store.variables[key] || kind.default || chars[0] || ''
}

function selectFilterOption(kind: ExploreKind, opt: string) {
  const key = kind.paramKey || kind.title
  store.setVariable(key, opt)
}

const openingBookUrl = ref('')
const showDetail = ref(false)
const selectedBook = ref<Book | SearchBook | null>(null)

// 榜单标签：默认只显示两行，超出部分折叠，可用箭头展开。
// 折叠采用「只渲染前两行」的方式（而非容器裁切），
// 这样标签的投影不会被 overflow 切断，边界处不会出现一条横向硬边。
const rankingMeasure = ref<HTMLElement>()
const isRankingExpanded = ref(false)
const rankingVisibleCount = ref(Number.POSITIVE_INFINITY)
const rankingHasOverflow = ref(false)
// 首次测量完成前，先用 CSS 兜底折叠高度，避免首帧闪出全部标签
const rankingMeasured = ref(false)

const visibleRankingKinds = computed(() =>
  isRankingExpanded.value
    ? store.rankingKinds
    : store.rankingKinds.slice(0, rankingVisibleCount.value),
)

/**
 * 在隐藏测量层里按行分组，统计「前两行」共有多少个标签。
 * 测量层始终渲染全部标签且宽度与展示区一致，因此换行结果与展开态相同。
 */
function measureRanking() {
  const el = rankingMeasure.value
  if (!el) return

  const chips = Array.from(el.querySelectorAll<HTMLElement>('.ranking-chip'))
  if (chips.length === 0) {
    rankingVisibleCount.value = Number.POSITIVE_INFINITY
    rankingHasOverflow.value = false
    rankingMeasured.value = true
    return
  }

  // 按行归组：key 为行顶端，value 为该行标签数
  const rowTops: number[] = []
  const rowCounts = new Map<number, number>()
  for (const chip of chips) {
    const top = chip.offsetTop
    if (!rowCounts.has(top)) {
      rowCounts.set(top, 0)
      rowTops.push(top)
    }
    rowCounts.set(top, rowCounts.get(top)! + 1)
  }
  rowTops.sort((a, b) => a - b)

  if (rowTops.length <= 2) {
    rankingVisibleCount.value = chips.length
    rankingHasOverflow.value = false
    rankingMeasured.value = true
    return
  }

  rankingVisibleCount.value = rowCounts.get(rowTops[0]!)! + rowCounts.get(rowTops[1]!)!
  rankingHasOverflow.value = true
  rankingMeasured.value = true
}

function toggleRanking() {
  isRankingExpanded.value = !isRankingExpanded.value
}

/**
 * 从服务端同步「发现」页书源选择：手机上在搜索管理里切换后，
 * 其他设备刷新 / 重新进入发现页、或切回本标签页时自动跟随。
 * 未登录、无服务端配置或该书源已失效时静默回退到本地选择。
 */
async function syncExploreSourceFromServer() {
  const url = await fetchExploreSourcePreference()
  // 服务端偏好仅作多设备跟随；本会话用户主动选过默认源时不再覆盖
  store.applyServerPreference(url)
}

function handleVisibilityChange() {
  if (document.hidden) return
  void syncExploreSourceFromServer()
}

onMounted(async () => {
  await store.init()
  await syncExploreSourceFromServer()
  await nextTick()
  measureRanking()
  window.addEventListener('resize', measureRanking)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  // 字体加载完成后标签尺寸可能变化，重新测一次。
  document.fonts?.ready.then(measureRanking).catch(() => undefined)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', measureRanking)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
})

// 榜单/分类标签变化（切换书源、筛选条件后重新拉取）时需要重新测量
watch(
  () => store.rankingKinds.map((kind) => kind.title).join('|'),
  async () => {
    await nextTick()
    measureRanking()
  },
)



/**
 * 下拉候选项。部分控件（如「平台」）的候选由书源云端配置动态提供，
 * 首次拿不到 chars 时至少保留当前值；当前值不在候选中时也补到首位，
 * 保证原生 <select> 的选中值一定存在于 option 列表里，闭合态不会空白。
 */
function optionsFor(kind: ExploreKind) {
  const chars = kind.chars ?? []
  const current = currentVarValue(kind)
  if (chars.length > 0) {
    return current && !chars.includes(current) ? [current, ...chars] : chars
  }
  return current ? [current] : []
}

function onCategoryClick(kind: ExploreKind) {
  if (!kind.url) return
  store.setCategory(kind.url)
}

function handleScroll() {
  const el = scrollContainer.value
  if (!el) return
  const { scrollTop, scrollHeight, clientHeight } = el
  if (scrollTop + clientHeight >= scrollHeight - 120) {
    store.fetchMore()
  }
}

function handleBookInfo(book: Book | SearchBook) {
  selectedBook.value = book
  showDetail.value = true
}

async function handleBookClick(book: Book | SearchBook) {
  const b = book as Book
  if (!b.origin || !b.bookUrl) return
  if (openingBookUrl.value === b.bookUrl) return

  openingBookUrl.value = b.bookUrl
  const targetIndex = b.durChapterIndex || 0

  try {
    const loadBookTask = readerStore.loadBook(b)
    await router.push('/reader')
    await loadBookTask
    await readerStore.loadChapter(targetIndex)
  } finally {
    openingBookUrl.value = ''
  }
}

async function handleAddToShelf(book: Book | SearchBook) {
  try {
    await saveBook({
      name: book.name,
      author: book.author,
      bookUrl: book.bookUrl,
      origin: book.origin,
      coverUrl: book.coverUrl,
    })
    appStore.showToast(`"${book.name}" 已加入书架`, 'success')
  } catch (e: unknown) {
    appStore.showToast((e as Error).message, 'error')
  }
}
</script>

<style scoped>
.explore-view {
  height: 100%;
  min-height: 0;
  max-width: var(--content-max-width);
  margin: 0 auto;
  width: 100%;
  display: flex;
  flex-direction: column;
  background: transparent;
  overflow: hidden;
}

.explore-header {
  padding: var(--space-5) 0 var(--space-3);
  display: flex;
  justify-content: center;
  align-items: center;
}

.explore-header h2 {
  font-size: var(--text-2xl);
  font-weight: 700;
  margin: 0;
  color: var(--color-text);
  letter-spacing: -0.02em;
  text-align: center;
}

/* 筛选控件 */
.filter-bar {
  padding: 0 0 var(--space-3);
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: var(--space-2);
}

/* 原生 <select> 筛选下拉：闭合态复用 global.css 的 .native-select，
   与书源工作区「全部分组」、发现管理「切换书源」同款；展开后的
   选项列表由系统渲染（PC 浅色 / iOS 深色带勾选）。 */
.filter-select-field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.filter-select-label {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  white-space: nowrap;
}

.filter-select {
  min-width: 96px;
  max-width: 180px;
  min-height: 34px;
  padding: 0 30px 0 10px;
  font-size: var(--text-sm);
  font-weight: 600;
}

/* 榜单标签栏：最多显示两行，超出部分折叠，可用箭头展开 */
.ranking-wrapper {
  position: relative;
  padding: 0 0 var(--space-3);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
}

.ranking-bar {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
}

/* 首次测量完成前的兜底：先按两行高度裁切，避免首帧闪出全部标签 */
.ranking-bar.is-measuring {
  max-height: 76px;
  overflow: hidden;
}

/* 测量层：绝对定位 + 零高度裁切，标签仍会正常布局（offsetTop 可用于分行），
   但既不显示、不拦截点击，也不会撑出多余的滚动区域。 */
.ranking-measure {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 0;
  overflow: hidden;
  visibility: hidden;
  pointer-events: none;
}

.ranking-toggle-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px;
  border-radius: var(--radius-full);
  border: 1px solid var(--glass-border);
  background: var(--glass-bg);
  box-shadow: var(--glass-shadow), var(--glass-inset-highlight);
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  color: var(--color-text-tertiary);
  font-size: var(--text-xs);
  cursor: pointer;
  transition: all var(--duration-fast) var(--ease-out);
}

.ranking-toggle-btn:hover {
  color: var(--color-primary);
  border-color: rgba(255, 255, 255, 0.85);
  background: var(--glass-bg-hover);
}

.toggle-icon {
  width: 14px;
  height: 14px;
  transition: transform var(--duration-fast) var(--ease-out);
}

.toggle-icon.is-expanded {
  transform: rotate(180deg);
}

.ranking-chip {
  flex-shrink: 0;
  padding: 8px 16px;
  border-radius: var(--radius-full);
  border: 1px solid var(--glass-border);
  background: var(--glass-bg);
  box-shadow: var(--glass-shadow), var(--glass-inset-highlight);
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  cursor: pointer;
  transition: all var(--duration-fast) var(--ease-out);
}

.ranking-chip:hover {
  color: var(--color-primary);
  background: var(--glass-bg-hover);
  border-color: rgba(255, 255, 255, 0.85);
}

.ranking-chip.active {
  border-color: var(--color-primary-border);
  background: var(--color-primary-bg);
  color: var(--color-primary);
  font-weight: 600;
}

/* 滚动区：顶部筛选区 + 书籍列表一起滚动，隐藏滚动条 */
.content-panel {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 var(--space-6) calc(104px + var(--space-6));
  position: relative;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.content-panel::-webkit-scrollbar {
  display: none;
}

.end-state,
.error-state {
  text-align: center;
  padding: 20px 0;
  color: var(--color-text-tertiary);
  font-size: var(--text-sm);
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 8px;
}

.error-state {
  color: var(--color-danger);
}

@media (max-width: 640px) {
  .content-panel {
    padding-left: var(--space-4);
    padding-right: var(--space-4);
  }
}
</style>
