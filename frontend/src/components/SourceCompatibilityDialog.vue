<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="modelValue" class="modal-overlay" @click="close"></div>
    </Transition>
    <Transition name="scale">
      <div v-if="modelValue" class="modal-container" @click.self="close">
        <section class="compat-modal">
          <!-- 与书源管理 .source-manager-header 同款：标题 + 统计描述 + 图标按钮 -->
            <header class="source-manager-header">
            <div class="title-block">
              <h2>检测管理</h2>
              <p>
                共 {{ summary.total }} 个 · 兼容 {{ summary.A }} 个 · 需留意 {{ summary.B }} 个 · 不兼容 {{ summary.C }} 个
                <span v-if="loading" class="progress-text"> · 正在加载书源…</span>
                <span v-else-if="batchTesting" class="progress-text">
                  · 深度测试 {{ batchProgress.done }}/{{ batchProgress.total }} · 已标记 {{ batchWritten }}
                </span>
              </p>
            </div>
            <div class="header-actions">
              <button class="icon-btn" :class="{ spinning: loading }" type="button" title="刷新书源" @click="loadSources">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                  <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                  <path d="M16 16h5v5" />
                </svg>
              </button>
              <button class="icon-btn close-btn" type="button" title="关闭" @click="close">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          </header>

          <div class="modal-body">
            <!-- 检测概览 -->
            <section class="overview-panel">
              <div class="panel-head">
                <span class="panel-title">检测概览</span>
                <span class="panel-sub">共 {{ summary.total }} 个书源 · 点击卡片筛选并指定深度测试范围</span>
              </div>
              <div class="summary-grid">
                <button
                  v-for="lv in LEVELS"
                  :key="lv"
                  type="button"
                  class="summary-card"
                  :class="['level-' + lv.toLowerCase(), { active: filterLevel === lv }]"
                  @click="toggleLevel(lv)"
                >
                  <span class="summary-num">{{ summary[lv] }}</span>
                  <span class="summary-label">{{ LEVEL_META[lv].label }}</span>
                </button>
              </div>
              <p class="hint">
                兼容：规则语法全部受支持 · 需留意：有风险但通常仍可用 · 不兼容：硬缺口基本读不了。
                漫画/图片源归入「需留意」需人工确认，不直接判不兼容。
              </p>
            </section>

            <!-- 深度测试工具条 -->
            <section class="deep-toolbar">
              <input v-model="keyword" class="text-input" type="text" placeholder="深度测试关键词（默认 斗破苍穹）" />
              <button
                v-if="!batchTesting"
                class="action-btn primary"
                type="button"
                :disabled="loading || !batchTargets.length"
                @click="runDeepBatch"
              >
                {{ batchTargetLabel }}
              </button>
              <button
                v-else
                class="action-btn stop-btn"
                type="button"
                title="立即停止测试，已完成的书源保持标记"
                @click="stopTesting"
              >
                停止测试 {{ batchProgress.done }}/{{ batchProgress.total }}
              </button>
            </section>
            <p class="toolbar-hint">
              选概览卡片或下方标签可只测某类，选「全部」则测全部。每测完一个即按静态等级写入分组（不兼容/需留意/兼容清除），可在书源管理页按分组处理；
              无匹配记「跳过」可换关键词重试，漫画源自动用漫画关键词。停止或关闭本页会立即停止，已完成的照常标记。
            </p>

            <!-- 筛选 -->
            <div class="filter-row">
              <input v-model="searchText" class="text-input" type="text" placeholder="搜索书源名称或网址" />
              <div class="level-tabs">
                <button
                  v-for="tab in TABS"
                  :key="tab.key"
                  type="button"
                  class="tab-btn"
                  :class="{ active: filterLevel === tab.key }"
                  @click="filterLevel = tab.key"
                >
                  {{ tab.label }}
                </button>
              </div>
            </div>

            <!-- 结果列表 -->
            <div v-if="loading" class="state-hint">正在加载书源列表…</div>
            <div v-else-if="loadError" class="state-hint error">
              <span>{{ loadError }}</span>
              <button class="action-btn" type="button" @click="loadSources">重新加载</button>
            </div>
            <div v-else class="result-list">
              <div v-for="row in filteredRows" :key="row.source.bookSourceUrl" class="result-item">
                <div class="result-head">
                  <span class="level-badge" :class="'level-' + row.compat.level.toLowerCase()">
                    {{ LEVEL_META[row.compat.level].label }}
                  </span>
                  <div class="result-title">
                    <strong>{{ row.source.bookSourceName || '未命名书源' }}</strong>
                    <small>{{ row.source.bookSourceUrl }}</small>
                  </div>
                  <button
                    class="action-btn"
                    type="button"
                    :disabled="!!testingUrls[row.source.bookSourceUrl]"
                    @click="runDeep(row.source.bookSourceUrl)"
                  >
                    {{ testingUrls[row.source.bookSourceUrl] ? '测试中' : '深度测试' }}
                  </button>
                </div>

                <ul v-if="row.compat.issues.length" class="issue-list">
                  <li v-for="issue in row.compat.issues" :key="issue.code" :class="'issue-' + issue.level.toLowerCase()">
                    <b>{{ issue.label }}</b> — {{ issue.detail }}
                  </li>
                </ul>
                <p v-else class="ok-hint">{{ row.compat.note || '✓ 规则语法全部受支持' }}</p>

                <div v-if="testingUrls[row.source.bookSourceUrl]" class="deep-result testing">
                  正在跑完整链路…
                </div>
                <div v-else-if="deepResults[row.source.bookSourceUrl]" class="deep-result">
                  <span
                    v-for="s in stepsOf(row.source.bookSourceUrl)"
                    :key="s.key"
                    class="step-chip"
                    :class="'step-' + s.status"
                    :title="s.detail"
                  >
                    {{ s.label }}·{{ STATUS_TEXT[s.status] }}
                  </span>
                  <span class="overall" :class="overallClass(row.source.bookSourceUrl)">
                    {{ overallText(row.source.bookSourceUrl) }}
                  </span>
                </div>
              </div>
              <div v-if="!filteredRows.length" class="empty">没有匹配的书源</div>
            </div>
          </div>

          <footer class="modal-footer">
            <span class="count-info">书源兼容性静态检测零网络、秒级完成；深度测试会真实请求外部站点。</span>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { BookSource } from '../types'
import { getBookSources, saveBookSources } from '../api/source'
import { useAppStore } from '../stores/app'
import {
  checkSourceCompatibility,
  summarizeCompatibility,
  deepTestLevelsFor,
  compatGroupLabelFor,
  applyDeepGroup,
  isComicSource,
  LEVEL_META,
  type CompatLevel,
  type CompatResult,
} from '../utils/sourceCompatibility'
import {
  runDeepTest,
  type DeepTestResult,
  type DeepTestStep,
  type DeepStepStatus,
} from '../utils/sourceDeepTest'
import { runWithConcurrency } from '../utils/sourceTesting'
import { searchBookMulti } from '../api/search'
import { getBookInfo, getChapterList, getBookContent } from '../api/bookshelf'

// 弹窗挂在 App.vue 顶层，由设置页「检测」按钮打开，因此书源列表自行加载，
// 不再依赖书源管理弹窗传入的 sources。
const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [boolean] }>()

const appStore = useAppStore()

// 漫画/图片源用小说关键词（斗破苍穹）搜索必然无匹配，深度测试无法真正验证。
// 这类源自动改用漫画关键词；用户手动输入时尊重用户输入，仅当留空或仍是默认
// 小说关键词时才切换，避免喧宾夺主。
const NOVEL_KEYWORD = '斗破苍穹'
const COMIC_KEYWORD = '海贼王'
// 批量深度测试的同时进行上限：每个源内部 4 步仍串行，但跨源并发，
// 整体耗时从「N × 单源耗时」降到约「N / 并发数 × 单源耗时」。
// 6 个源同时测 = 最多 24 个在途请求，对后端与浏览器都安全。
const DEEP_TEST_CONCURRENCY = 6
function effectiveKeyword(url: string): string {
  const source = sources.value.find((s) => s.bookSourceUrl === url)
  const typed = keyword.value.trim()
  if (source && isComicSource(source) && (!typed || typed === NOVEL_KEYWORD)) {
    return COMIC_KEYWORD
  }
  return typed || NOVEL_KEYWORD
}

const LEVELS: CompatLevel[] = ['A', 'B', 'C']
const TABS: { key: CompatLevel | 'ALL'; label: string }[] = [
  { key: 'ALL', label: '全部' },
  { key: 'A', label: '兼容' },
  { key: 'B', label: '需留意' },
  { key: 'C', label: '不兼容' },
]
const STATUS_TEXT: Record<DeepStepStatus, string> = {
  pass: '通过', warn: '留意', fail: '失败', skip: '跳过',
}
const OVERALL_TEXT: Record<DeepStepStatus, string> = {
  pass: '链路完整可用', warn: '可用但有问题', fail: '链路失败', skip: '无匹配，请换关键词',
}

interface Row { source: BookSource; compat: CompatResult }

const sources = ref<BookSource[]>([])
const loading = ref(false)
const loadError = ref('')
const keyword = ref('斗破苍穹')
const searchText = ref('')
const filterLevel = ref<CompatLevel | 'ALL'>('ALL')
const deepResults = ref<Record<string, DeepTestResult>>({})
const testingUrls = ref<Record<string, boolean>>({})
const batchTesting = ref(false)
const batchProgress = ref({ done: 0, total: 0 })
let cancelled = false
// 当前一轮深度测试的中断信号：点「停止测试」或关闭弹窗时 abort，
// 链路会在下一个步骤边界立即停下，正在跑的那一个源不写回分组。
let testAbort: AbortController | null = null

// 兼容检测写回书源分组：每完成一个源立即写回，批量也不等全部跑完，
// 这样中途取消 / 关闭弹窗时，已完成源的标记不会丢失。
const pendingGroupUpdates = new Map<string, BookSource>()
// 批量结束时汇总提示用（逐个写回期间静默，避免刷屏）
const batchWritten = ref(0)

const rows = computed<Row[]>(() =>
  sources.value.map((source) => ({ source, compat: checkSourceCompatibility(source) })),
)
const summary = computed(() => summarizeCompatibility(rows.value.map((r) => r.compat)))

// 深度测试目标：选「全部」→ 全部书源；选中某一类 → 只测该类。
const batchTargets = computed(() => {
  const levels = deepTestLevelsFor(filterLevel.value)
  return rows.value.filter((r) => levels.includes(r.compat.level))
})
const batchTargetLabel = computed(() => {
  const n = batchTargets.value.length
  const scope = filterLevel.value === 'ALL'
    ? '全部书源'
    : LEVEL_META[filterLevel.value].label + '书源'
  return `深度测试${scope} (${n})`
})

const filteredRows = computed(() => {
  const q = searchText.value.trim().toLowerCase()
  return rows.value.filter((r) => {
    if (filterLevel.value !== 'ALL' && r.compat.level !== filterLevel.value) return false
    if (!q) return true
    return (
      (r.source.bookSourceName || '').toLowerCase().includes(q) ||
      (r.source.bookSourceUrl || '').toLowerCase().includes(q)
    )
  })
})

async function loadSources() {
  if (loading.value) return
  loading.value = true
  loadError.value = ''
  try {
    sources.value = await getBookSources()
  } catch (e: unknown) {
    loadError.value = `加载书源失败：${(e as Error)?.message || String(e)}`
  } finally {
    loading.value = false
  }
}

/**
 * 返回一个未被中断的信号：单个深度测试复用当前会话，批量测试新建会话。
 * stopTesting() 会把 controller 置空，下一次自然重建。
 */
function ensureAbort(): AbortController {
  if (!testAbort || testAbort.signal.aborted) testAbort = new AbortController()
  return testAbort
}

/**
 * 停止当前深度测试：立即中断正在跑的链路（不再发后续请求），批量循环也会
 * 在下一轮退出。已完成的源在测试过程中已逐个写回，标记保持不变。
 */
function stopTesting() {
  cancelled = true
  testAbort?.abort()
  testAbort = null
}

function close() {
  stopTesting()
  emit('update:modelValue', false)
}
function stepsOf(url: string): DeepTestStep[] {
  return deepResults.value[url]?.steps ?? []
}
function overallText(url: string): string {
  const r = deepResults.value[url]
  return r ? OVERALL_TEXT[r.overall] : ''
}
function overallClass(url: string): string {
  const r = deepResults.value[url]
  return r ? 'step-' + r.overall : ''
}
function toggleLevel(lv: CompatLevel) {
  filterLevel.value = filterLevel.value === lv ? 'ALL' : lv
}

/**
 * 依据「静态兼容等级」准备分组写回（与深度链路测试结果无关）：
 * - C 不兼容 → 标记「不兼容」
 * - B 需留意 → 标记「需留意」
 * - A 兼容   → 清除已有的「需留意 / 不兼容」标记
 *
 * 只改 bookSourceGroup，其余字段原样带上，保留用户原有分组；
 * 书源测试写的「失效」分组不会被清除，三种标记互不覆盖。
 * 深度测试只用来触发「完成一个写回一个」并展示链路详情。
 */
function recordGroupUpdate(url: string) {
  const source = sources.value.find((s) => s.bookSourceUrl === url)
  if (!source) return
  const { level } = checkSourceCompatibility(source)
  const current = source.bookSourceGroup || ''
  const next = applyDeepGroup(current, compatGroupLabelFor(level))
  if (next === current) return
  pendingGroupUpdates.set(url, { ...source, bookSourceGroup: next })
}

/**
 * 把待写回队列落库。
 * - silent：批量逐个写回时不弹 toast（否则一个源一条提示会刷屏），结束时统一提示；
 * - 每次写回都自增书源分组版本号，让书源管理页实时同步，且已测结论立即持久化。
 */
async function flushGroupUpdates(options: { silent?: boolean } = {}): Promise<number> {
  if (!pendingGroupUpdates.size) return 0
  const list = [...pendingGroupUpdates.values()]
  pendingGroupUpdates.clear()
  try {
    await saveBookSources(list)
    // 同步本地镜像，保证弹窗内与库里的一致
    const byUrl = new Map(list.map((s) => [s.bookSourceUrl, s.bookSourceGroup || '']))
    sources.value = sources.value.map((s) =>
      byUrl.has(s.bookSourceUrl)
        ? { ...s, bookSourceGroup: byUrl.get(s.bookSourceUrl) }
        : s,
    )
    // 通知书源管理页重新拉库，分组下拉立即出现「不兼容 / 需留意」两项。
    appStore.bumpSourceGroupVersion()
    if (!options.silent) {
      appStore.showToast(
        `已按静态兼容等级标记 ${list.length} 个书源，书源管理页已自动同步`,
        'success',
      )
    }
    return list.length
  } catch (e: unknown) {
    appStore.showToast(`标记分组失败：${(e as Error)?.message || String(e)}`, 'error')
    return 0
  }
}

// 并发写回锁：批量深度测试并发跑时，多个 runDeep 会同时调用 flushGroupUpdates，
// 而它读写共享的 pendingGroupUpdates（先取 list 再 clear）。若不串行化，会出现
// 「A 读取后 B 也读取、A 清空后 B 再清空」的竞态导致计数错乱。用一条 promise 链
// 把所有 flush 串起来，保证任一时刻只有一个 flush 在动这个集合。
let flushChain: Promise<number> = Promise.resolve(0)
function safeFlushGroupUpdates(options: { silent?: boolean } = {}): Promise<number> {
  const run = flushChain.then(() => flushGroupUpdates(options))
  flushChain = run.catch(() => 0)
  return run
}

function makeDeps() {
  return {
    search: (key: string, url: string) =>
      searchBookMulti({ key, bookSourceUrl: url, page: 1 }),
    info: (bookUrl: string, origin: string) => getBookInfo(bookUrl, origin),
    toc: (params: { bookUrl: string; bookSourceUrl: string }) =>
      getChapterList({ ...params, refresh: 1 }),
    content: (params: { chapterUrl: string; bookSourceUrl: string }) =>
      getBookContent({ ...params, refresh: 1 }),
  }
}

async function runDeep(url: string) {
  if (testingUrls.value[url]) return
  // 单个深度测试取当前会话信号；批量测试复用 runDeepBatch 建立的同一个信号
  const signal = ensureAbort().signal
  testingUrls.value = { ...testingUrls.value, [url]: true }
  let result: DeepTestResult
  try {
    result = await runDeepTest(url, effectiveKeyword(url), makeDeps(), { signal })
  } catch (e: unknown) {
    result = {
      overall: 'fail', ok: false, skipped: false,
      steps: [{ key: 'search', label: '搜索', status: 'fail', detail: (e as Error)?.message || String(e), ms: 0 }],
    }
  }

  const next = { ...testingUrls.value }
  delete next[url]
  testingUrls.value = next

  // 被中断（点停止 / 关闭弹窗）：链路没跑完，既不展示结论也不写入分组。
  // 只判断本次会话的精确信号，避免上一轮的全局取消状态误伤新的单个测试；
  // 之前已完成的源在各自的 runDeep 里已逐个写回，不受影响。
  if (result.cancelled || signal.aborted) return

  deepResults.value = { ...deepResults.value, [url]: result }
  // 标记只由静态兼容等级决定，与链路结论无关；完成一个即写回一个。
  recordGroupUpdate(url)
  const written = await safeFlushGroupUpdates({ silent: batchTesting.value })
  if (batchTesting.value) batchWritten.value += written
}

async function runDeepBatch() {
  if (batchTesting.value || loading.value) return
  cancelled = false
  // 每轮批量新建一个中断会话，避免与上一次已停止的信号串在一起
  testAbort = new AbortController()
  const signal = testAbort.signal
  const targets = batchTargets.value
  batchProgress.value = { done: 0, total: targets.length }
  batchWritten.value = 0
  batchTesting.value = true
  try {
    // 有界并发：跨源同时测试不超过 DEEP_TEST_CONCURRENCY，单源内部 4 步仍串行；
    // 取消/关弹窗时新任务不再发起，在途链路会因 signal 中断而快速返回（已完成的照常标记）。
    await runWithConcurrency(targets, DEEP_TEST_CONCURRENCY, async (row) => {
      if (cancelled || signal.aborted) return
      await runDeep(row.source.bookSourceUrl)
      batchProgress.value = { ...batchProgress.value, done: batchProgress.value.done + 1 }
    })
  } finally {
    batchTesting.value = false
    const stopped = cancelled || signal.aborted
    // 兜底：清空可能的残留（正常路径下已逐个写完）
    batchWritten.value += await safeFlushGroupUpdates({ silent: true })
    if (stopped) {
      appStore.showToast(
        `已停止测试，已完成的 ${batchWritten.value} 个书源已按静态等级标记`,
        'success',
      )
    } else if (batchWritten.value > 0) {
      appStore.showToast(
        `已按静态兼容等级逐个标记 ${batchWritten.value} 个书源，书源管理页已自动同步`,
        'success',
      )
    }
    if (testAbort?.signal === signal) testAbort = null
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (!open) {
      // 关闭弹窗一律停止测试（含遮罩点击 / 关闭按钮 / 底部关闭）
      stopTesting()
      return
    }
    cancelled = false
    testAbort = null
    pendingGroupUpdates.clear()
    batchWritten.value = 0
    deepResults.value = {}
    testingUrls.value = {}
    filterLevel.value = 'ALL'
    searchText.value = ''
    loadSources()
  },
)
</script>

<style scoped>
/* 外壳与书源管理弹窗 .source-modal 同款 */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: var(--z-overlay);
  backdrop-filter: blur(4px);
}
.modal-container {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  padding:
    calc(var(--space-6) + var(--safe-area-top))
    calc(var(--space-6) + var(--safe-area-right))
    calc(var(--space-6) + var(--safe-area-bottom))
    calc(var(--space-6) + var(--safe-area-left));
}
.compat-modal {
  width: min(1180px, 100%);
  height: min(780px, calc(var(--app-height, 100dvh) - var(--safe-area-top) - var(--safe-area-bottom) - 32px));
  max-height: min(88vh, calc(var(--app-height, 100dvh) - var(--safe-area-top) - var(--safe-area-bottom) - 32px));
  background: var(--color-bg-elevated);
  border-radius: var(--radius-xl);
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-xl);
  overflow: hidden;
}

/* 头部与 SourceManagerHeader.vue 完全同款 */
.source-manager-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: calc(var(--space-5) + var(--safe-area-top)) var(--space-6) var(--space-5);
  border-bottom: 1px solid var(--color-border-light);
  background: var(--color-bg-elevated);
  flex-shrink: 0;
}
.title-block { min-width: 0; }
.title-block h2 { font-size: var(--text-lg); font-weight: 700; }
.title-block p { margin-top: 6px; font-size: 13px; color: var(--color-text-tertiary); }
.title-block .progress-text {
  color: var(--color-primary);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  animation: progress-pulse 1.2s ease-in-out infinite;
}
@keyframes progress-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}
.header-actions { display: flex; gap: var(--space-2); }
.action-btn,
.icon-btn {
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  background: transparent;
  cursor: pointer;
  transition: all var(--duration-fast);
}
.icon-btn {
  width: 36px; height: 36px;
  display: flex; align-items: center; justify-content: center;
  color: var(--color-text-secondary);
}
.icon-btn svg { width: 18px; height: 18px; }
.action-btn:hover,
.icon-btn:hover { background: var(--color-bg-hover); }
.icon-btn.spinning svg { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.modal-body { flex: 1; overflow-y: auto; padding: 14px 24px; }

.overview-panel {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg);
  padding: var(--space-4);
}
.panel-head { display: flex; justify-content: space-between; align-items: baseline; gap: var(--space-3); margin-bottom: var(--space-3); }
.panel-title { font-weight: 700; font-size: var(--text-base); }
.panel-sub { font-size: 12px; color: var(--color-text-tertiary); }
.summary-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-3); }
.summary-card {
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  padding: var(--space-3); border: 1px solid var(--color-border);
  border-radius: var(--radius-md); background: var(--color-bg);
  cursor: pointer; transition: all var(--duration-fast);
}
.summary-card:hover { background: var(--color-bg-hover); }
.summary-card.active { border-color: var(--color-primary); box-shadow: 0 0 0 2px var(--color-primary-bg); }
.summary-num { font-size: var(--text-2xl); font-weight: 700; line-height: 1.2; }
.summary-label { font-size: 12px; color: var(--color-text-secondary); }
.summary-card.level-a .summary-num { color: var(--color-success); }
.summary-card.level-b .summary-num { color: var(--color-warning); }
.summary-card.level-c .summary-num { color: var(--color-danger); }
.hint { margin-top: var(--space-3); font-size: 12px; line-height: 1.6; color: var(--color-text-tertiary); }

.deep-toolbar { display: flex; gap: var(--space-2); margin-top: var(--space-5); }
.text-input {
  flex: 1; min-width: 0; min-height: 36px;
  padding: 8px 12px; font-size: 13px;
  border: 1px solid var(--color-border); border-radius: var(--radius-md);
  background: var(--color-bg); color: var(--color-text);
}
.text-input:focus { outline: none; border-color: var(--color-primary); }
.toolbar-hint { margin-top: var(--space-2); font-size: 12px; line-height: 1.6; color: var(--color-text-tertiary); }

.action-btn {
  min-height: 36px; display: inline-flex; align-items: center; justify-content: center;
  padding: 8px 12px; font-size: 13px; white-space: nowrap;
  color: var(--color-text);
}
.action-btn:hover:not(:disabled) { background: var(--color-bg-hover); }
.action-btn:disabled { opacity: 0.52; cursor: not-allowed; }
.action-btn.primary { background: var(--color-primary); border-color: var(--color-primary); color: #fff; }
.action-btn.primary:hover:not(:disabled) { background: var(--color-primary-dark); border-color: var(--color-primary-dark); }
.action-btn.stop-btn {
  color: var(--color-danger);
  border-color: color-mix(in srgb, var(--color-danger) 45%, transparent);
  background: color-mix(in srgb, var(--color-danger) 8%, transparent);
}
.action-btn.stop-btn:hover {
  background: color-mix(in srgb, var(--color-danger) 16%, transparent);
}

.filter-row { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-5); align-items: center; }
.filter-row .text-input { flex: 1 1 220px; }
.level-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
.tab-btn {
  min-height: 34px; padding: 6px 12px; font-size: 12px;
  border: 1px solid var(--color-border); border-radius: var(--radius-full);
  background: transparent; color: var(--color-text-secondary); cursor: pointer;
}
.tab-btn.active { background: var(--color-primary-bg); border-color: var(--color-primary-border); color: var(--color-primary); font-weight: 600; }

.result-list { display: flex; flex-direction: column; gap: var(--space-3); margin-top: var(--space-4); }
.result-item { border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: var(--space-3); }
.result-head { display: flex; align-items: center; gap: var(--space-3); }
.level-badge {
  flex-shrink: 0; min-width: 44px; height: 24px; padding: 0 8px;
  border-radius: var(--radius-full);
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 600; color: #fff; white-space: nowrap;
}
.level-badge.level-a { background: var(--color-success); }
.level-badge.level-b { background: var(--color-warning); }
.level-badge.level-c { background: var(--color-danger); }
.result-title { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.result-title strong { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.result-title small { font-size: 11px; color: var(--color-text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.result-head .action-btn { flex-shrink: 0; min-height: 32px; padding: 6px 10px; font-size: 12px; }

.issue-list { list-style: none; margin-top: var(--space-3); display: flex; flex-direction: column; gap: 6px; }
.issue-list li {
  font-size: 12px; line-height: 1.6; color: var(--color-text-secondary);
  padding: 6px 10px; border-left: 3px solid var(--color-border);
  background: var(--color-bg-sunken); border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
}
.issue-list li.issue-c { border-left-color: var(--color-danger); }
.issue-list li.issue-b { border-left-color: var(--color-warning); }
.issue-list b { color: var(--color-text); }
.ok-hint { margin-top: var(--space-3); font-size: 12px; color: var(--color-success); }

.deep-result { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: var(--space-3); }
.deep-result.testing { font-size: 12px; color: var(--color-text-tertiary); }
.step-chip, .overall {
  font-size: 11px; padding: 3px 8px; border-radius: var(--radius-full);
  border: 1px solid var(--color-border); color: var(--color-text-secondary);
}
.step-pass { background: rgba(82, 196, 26, 0.1); border-color: rgba(82, 196, 26, 0.3); color: var(--color-success); }
.step-warn { background: rgba(250, 173, 20, 0.1); border-color: rgba(250, 173, 20, 0.35); color: var(--color-warning); }
.step-fail { background: rgba(245, 34, 45, 0.1); border-color: rgba(245, 34, 45, 0.3); color: var(--color-danger); }
.step-skip { background: var(--color-bg-sunken); }
.overall { font-weight: 600; }
.empty, .state-hint { padding: var(--space-8); text-align: center; color: var(--color-text-tertiary); font-size: 13px; }
.state-hint.error { color: var(--color-danger); display: flex; flex-direction: column; align-items: center; gap: var(--space-3); }

/* 底部与书源管理 .modal-footer 同款 */
.modal-footer {
  min-height: 44px;
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 8px 24px 14px;
  border-top: 1px solid var(--color-border-light);
  flex-shrink: 0;
}
.count-info { font-size: 12px; color: var(--color-text-tertiary); }

.fade-enter-active, .fade-leave-active { transition: opacity var(--duration-normal); }
.fade-enter-from, .fade-leave-to { opacity: 0; }
.scale-enter-active, .scale-leave-active { transition: opacity var(--duration-normal), transform var(--duration-normal); }
.scale-enter-from, .scale-leave-to { opacity: 0; transform: scale(0.96); }

@media (max-width: 640px) {
  .modal-container { align-items: stretch; padding: 8px; }
  .compat-modal {
    width: 100%;
    height: calc(var(--app-height, 100dvh) - 16px);
    max-height: calc(var(--app-height, 100dvh) - 16px);
    border-radius: 24px;
  }
  .source-manager-header {
    position: relative;
    flex-direction: column;
    padding: calc(var(--space-4) + var(--safe-area-top)) var(--space-4) var(--space-4);
  }
  .header-actions {
    position: absolute;
    top: calc(var(--space-4) + var(--safe-area-top));
    right: var(--space-4);
  }
  .title-block p { padding-right: 84px; }
  .modal-body { padding-left: var(--space-4); padding-right: var(--space-4); }
  .modal-footer { padding: 10px 16px 14px; }
  .deep-toolbar { flex-direction: column; }
  .summary-num { font-size: var(--text-xl); }
}
</style>
