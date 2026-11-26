<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="modelValue" class="modal-overlay" @click="close"></div>
    </Transition>

    <Transition name="scale">
      <div v-if="modelValue" class="modal-container" @click.self="close">
        <div class="source-modal">
          <SourceManagerHeader
            :total="sourceStats.total"
            :enabled="sourceStats.enabled"
            :filtered="sourceStats.filtered"
            :selected="selectedFilteredSources.length"
            :loading="loading"
            :testing="testingSources"
            :progress-text="progressText"
            :invalid-count="invalidSources.length"
            @refresh="loadSources"
            @import-local="triggerFileImport"
            @open-subscriptions="subscriptionPanelVisible = true"
            @test-sources="testSources"
            @delete-invalid="removeInvalidSources"
            @create="createSource"
            @close="close"
          />

          <input
            ref="fileInputRef"
            type="file"
            accept=".json,.txt"
            class="hidden-input"
            @change="handleFileImport"
          />

          <SourceFilterBar
            :filter-text="filterText"
            :filter-group="filterGroup"
            :groups="groupList"
            :all-selected="allFilteredSelected"
            :partially-selected="partiallyFilteredSelected"
            :selected-count="selectedFilteredSources.length"
            :has-sources="filteredSources.length > 0"
            @update:filter-text="filterText = $event"
            @update:filter-group="filterGroup = $event"
            @toggle-current-selection="toggleFilteredSelection"
            @clear-selection="clearSelection"
            @export-selection="exportSources"
            @clear-compat-marks="clearSelectedCompatMarks"
            @delete-selection="removeSelectedSources"
          />

          <div class="content-grid">
            <SourceList
              class="source-list-slot"
              :sources="filteredSources"
              :loading="loading"
              :selected-urls="selectedSourceUrls"
              :active-url="editingSource?.bookSourceUrl"
              :empty-title="sources.length ? '没有匹配的书源' : '暂无书源'"
              :empty-description="sources.length ? '调整搜索关键词或分组筛选后再试' : '可以本地导入、远程同步或手动新增'"
              @edit="editSource"
              @toggle-enabled="toggleSource"
              @toggle-selection="toggleSourceSelection"
              @delete="removeSource"
            />

            <SourceEditorPanel
              class="editor-slot"
              :source="editingSource"
              :editor-text="editorText"
              :can-login="canLoginSource"
              :login-loading="sourceLoginLoading"
              @update:editor-text="editorText = $event"
              @format="formatEditor"
              @save="saveEditor"
              @login="handleSourceLogin"
              @create="createSource"
              @import-local="triggerFileImport"
            />
          </div>

          <footer class="modal-footer">
            <span class="count-info">显示 {{ filteredSources.length }} / {{ sources.length }}</span>
          </footer>
        </div>
      </div>
    </Transition>

    <SourceSubscriptionPanel
      v-model:remote-url="remoteUrl"
      :visible="subscriptionPanelVisible"
      :subscriptions="subscriptions"
      @sync="importRemoteSource"
      @save="saveSubscription"
      @sync-subscription="syncSubscription"
      @remove-subscription="removeSubscription"
      @close="subscriptionPanelVisible = false"
    />

    <Transition name="scale">
      <div v-if="loginPreviewVisible" class="login-preview-container" @click.self="loginPreviewVisible = false">
        <div class="login-preview-modal">
          <div class="login-preview-header">
            <div>
              <h3>书源登录页</h3>
              <p>{{ loginPreviewUrl }}</p>
            </div>
            <button class="icon-btn" type="button" @click="loginPreviewVisible = false" title="关闭">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          <iframe class="login-preview-frame" :src="loginPreviewFrameUrl"></iframe>
        </div>
      </div>
    </Transition>

    <!-- JS 登录书源（光遇等）账号密码弹窗 -->
    <Transition name="scale">
      <div v-if="credentialLoginVisible" class="login-preview-container" @click.self="credentialLoginVisible = false">
        <div class="login-preview-modal credential-modal">
          <div class="login-preview-header">
            <div>
              <h3>书源账号登录</h3>
              <p>{{ pendingLoginSource?.bookSourceName || pendingLoginSource?.bookSourceUrl }}</p>
            </div>
            <button class="icon-btn" type="button" @click="credentialLoginVisible = false" title="关闭">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          <form class="credential-form" @submit.prevent="submitCredentialLogin">
            <label>
              <span>账号 / 邮箱</span>
              <input v-model="credentialUsername" type="text" placeholder="请输入账号或邮箱" autocomplete="username" />
            </label>
            <label>
              <span>密码</span>
              <input v-model="credentialPassword" type="password" placeholder="请输入密码" autocomplete="current-password" />
            </label>
            <button class="credential-submit" type="submit" :disabled="credentialSubmitting">
              {{ credentialSubmitting ? '登录中…' : '登 录' }}
            </button>
          </form>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import {
  getBookSources,
  deleteBookSource,
  deleteBookSources,
  deleteInvalidBookSources,
  loginBookSource,
  saveBookSource,
  saveBookSources,
  testBookSources,
  readRemoteSourceFile,
  readSourceFile,
} from '../api/source'
import { useAppStore } from '../stores/app'
import type { BookSource, BookSourceTestResponse } from '../types'
import {
  dedupeBookSources,
  filterBookSources,
  getBookSourceGroupOptions,
  getBookSourceStats,
  getVisibleSelection,
  SOURCE_GROUP_INVALID,
  toBookSourceDeletePayload,
} from '../utils/sourceSelection'
import { applyDeepGroup } from '../utils/sourceCompatibility'
import { appendAuthQueryParams } from '../utils/secureAccess'
import {
  chunkBookSourceUrls,
  mergeBookSourceTestResponses,
  runBisectSourceTest,
  type BisectTestOutcome,
} from '../utils/sourceTesting'
import SourceEditorPanel from './source-manager/SourceEditorPanel.vue'
import SourceFilterBar from './source-manager/SourceFilterBar.vue'
import SourceList from './source-manager/SourceList.vue'
import SourceManagerHeader from './source-manager/SourceManagerHeader.vue'
import SourceSubscriptionPanel from './source-manager/SourceSubscriptionPanel.vue'

type SourceSubscription = {
  url: string
  lastSyncedAt?: number
}

const SUBSCRIPTION_KEY = 'reader-source-subscriptions'

const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const appStore = useAppStore()

const sources = ref<BookSource[]>([])
const loading = ref(false)
const testingSources = ref(false)
// 导入 / 同步 / 测试过程的动态进度，统一显示在书源管理统计行「当前筛选」后
const progressActive = ref(false)
const progressLabel = ref('')
const progressDone = ref(0)
const progressTotal = ref(0)
const progressText = computed(() => {
  if (!progressActive.value) return ''
  return progressTotal.value > 0
    ? `${progressLabel.value} ${progressDone.value}/${progressTotal.value}`
    : `${progressLabel.value}…`
})

// 统计行进度标签统一用「…中」，后面跟 X/Y 数字进度（导入中 / 同步中 / 测试中）
function startProgress(label: string, total = 0) {
  progressLabel.value = label
  progressDone.value = 0
  progressTotal.value = total
  progressActive.value = true
}
function bumpProgress(n: number) {
  progressDone.value += n
}
function endProgress() {
  progressActive.value = false
  progressLabel.value = ''
  progressDone.value = 0
  progressTotal.value = 0
}

// 每批数量：拆小批次才能实时反馈进度；后端 /saveBookSources 为批量 upsert，结果不变
const PROGRESS_BATCH_SIZE = 10

async function saveSourcesWithProgress(list: BookSource[], label: string) {
  startProgress(label, list.length)
  for (let i = 0; i < list.length; i += PROGRESS_BATCH_SIZE) {
    const batch = list.slice(i, i + PROGRESS_BATCH_SIZE)
    await saveBookSources(batch)
    bumpProgress(batch.length)
  }
}
const filterText = ref('')
const filterGroup = ref('')
const fileInputRef = ref<HTMLInputElement | null>(null)
const selectedSourceUrls = ref(new Set<string>())

const subscriptionPanelVisible = ref(false)
const remoteUrl = ref('')
const subscriptions = ref<SourceSubscription[]>(loadSubscriptions())

const editingSource = ref<BookSource | null>(null)
const editorText = ref(JSON.stringify(createEmptySource(), null, 2))
const sourceLoginLoading = ref(false)
const loginPreviewVisible = ref(false)
const loginPreviewUrl = ref('')
const loginPreviewFrameUrl = ref('')

// JS 登录书源（光遇等）的账号密码输入弹窗
const credentialLoginVisible = ref(false)
const credentialSubmitting = ref(false)
const credentialUsername = ref('')
const credentialPassword = ref('')
const pendingLoginSource = ref<BookSource | null>(null)

// 分组下拉改为带「数量 + 置顶 + 标记」的选项：深度测试写回的
// 「不兼容 / 需留意」永远排在最前，并附带该分组下的书源数量。
const groupList = computed(() => getBookSourceGroupOptions(sources.value))

const filteredSources = computed(() =>
  filterBookSources(sources.value, filterText.value, filterGroup.value)
)

const sourceStats = computed(() => getBookSourceStats(sources.value, filteredSources.value))

const selectedFilteredSources = computed(() =>
  getVisibleSelection(filteredSources.value, selectedSourceUrls.value, (source) => source.bookSourceUrl)
)

const invalidSources = computed(() =>
  sources.value.filter((source) => hasSourceGroup(source, SOURCE_GROUP_INVALID))
)

const allFilteredSelected = computed(() =>
  filteredSources.value.length > 0 && selectedFilteredSources.value.length === filteredSources.value.length
)

const partiallyFilteredSelected = computed(() =>
  selectedFilteredSources.value.length > 0 && !allFilteredSelected.value
)

const canLoginSource = computed(() => {
  try {
    const parsed = JSON.parse(editorText.value) as BookSource
    return Boolean(parsed.bookSourceUrl?.trim() && parsed.loginUrl?.trim())
  } catch {
    return false
  }
})

function createEmptySource(): BookSource {
  return {
    bookSourceName: '新增书源',
    bookSourceUrl: '',
    enabled: true,
  }
}

function loadSubscriptions(): SourceSubscription[] {
  try {
    const raw = localStorage.getItem(SUBSCRIPTION_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function persistSubscriptions() {
  localStorage.setItem(SUBSCRIPTION_KEY, JSON.stringify(subscriptions.value))
}

// 记录最近一次加载对应的书源数据版本，用于弹窗关闭期间发生写回时，
// 下次打开能识别出数据已过期并重新拉库。
let lastLoadedVersion = appStore.sourceGroupVersion

async function loadSources() {
  loading.value = true
  try {
    lastLoadedVersion = appStore.sourceGroupVersion
    const loaded = await getBookSources()
    // 加载/刷新时兜底：把库中已存在但 bookSourceGroup 为空的书源补为「🎃缺失」并回写。
    const fixed = fillMissingGroup(loaded)
    const changed = fixed.filter(
      (source, i) => source.bookSourceGroup !== (loaded[i].bookSourceGroup || ''),
    )
    if (changed.length) {
      await saveBookSources(changed)
      appStore.showToast(`已为 ${changed.length} 个书源补全缺失分组`, 'success')
    }
    sources.value = fixed
    pruneSelection()
  } catch (e: unknown) {
    appStore.showToast((e as Error).message, 'error')
  } finally {
    loading.value = false
  }
}

async function toggleSource(source: BookSource) {
  const next = { ...source, enabled: source.enabled === false ? true : false }
  try {
    await saveBookSource(next)
    Object.assign(source, next)
    appStore.showToast('书源状态已更新', 'success')
  } catch (e: unknown) {
    appStore.showToast((e as Error).message, 'error')
  }
}

async function removeSource(source: BookSource) {
  if (!confirm(`确定删除书源 "${source.bookSourceName}"？`)) return
  try {
    await deleteBookSource(source.bookSourceUrl)
    sources.value = sources.value.filter((s) => s.bookSourceUrl !== source.bookSourceUrl)
    selectedSourceUrls.value.delete(source.bookSourceUrl)
    if (editingSource.value?.bookSourceUrl === source.bookSourceUrl) {
      createSource()
    }
    appStore.showToast('已删除', 'success')
  } catch (e: unknown) {
    appStore.showToast((e as Error).message, 'error')
  }
}

async function removeSelectedSources() {
  const targets = selectedFilteredSources.value
  if (!targets.length) {
    appStore.showToast('请先选择要删除的书源', 'warning')
    return
  }
  if (!confirm(`确定删除选中的 ${targets.length} 个书源？`)) return
  try {
    await deleteBookSources(toBookSourceDeletePayload(targets))
    const targetUrls = new Set(targets.map((source) => source.bookSourceUrl))
    sources.value = sources.value.filter((source) => !targetUrls.has(source.bookSourceUrl))
    selectedSourceUrls.value.clear()
    if (editingSource.value && targetUrls.has(editingSource.value.bookSourceUrl)) {
      createSource()
    }
    appStore.showToast(`已删除 ${targets.length} 个书源`, 'success')
  } catch (e: unknown) {
    appStore.showToast((e as Error).message || '批量删除失败', 'error')
  }
}

/**
 * 取消选中书源的兼容标记（需留意 / 不兼容），保留其余分组不变。
 * 只改 bookSourceGroup，不触碰书源其它字段；写回服务端后同步本地镜像，
 * 并自增分组版本号让弹窗/管理页的分组下拉同步刷新。
 */
async function clearSelectedCompatMarks() {
  const targets = selectedFilteredSources.value
  if (!targets.length) {
    appStore.showToast('请先选择要取消标记的书源', 'warning')
    return
  }
  // 仅对确实带「需留意 / 不兼容」标记的书源发起写回
  const marked = targets.filter(
    (source) => applyDeepGroup(source.bookSourceGroup || '', null) !== (source.bookSourceGroup || ''),
  )
  const toUpdate: BookSource[] = marked.map((source) => ({
    ...source,
    bookSourceGroup: applyDeepGroup(source.bookSourceGroup || '', null),
  }))
  if (!toUpdate.length) {
    appStore.showToast('选中的书源没有兼容标记', 'warning')
    return
  }
  try {
    await saveBookSources(toUpdate)
    const groups = new Map(toUpdate.map((s) => [s.bookSourceUrl, s.bookSourceGroup]))
    sources.value = sources.value.map((source) =>
      groups.has(source.bookSourceUrl)
        ? { ...source, bookSourceGroup: groups.get(source.bookSourceUrl) }
        : source,
    )
    appStore.bumpSourceGroupVersion()
    appStore.showToast(`已取消 ${toUpdate.length} 个书源的兼容标记`, 'success')
  } catch (e: unknown) {
    appStore.showToast((e as Error).message || '取消标记失败', 'error')
  }
}

// axios 客户端超时被 http 拦截器转成 Error("timeout of 60000ms exceeded")，
// 用该专有文案精确识别，避免把后端业务错误（可能含中文「超时」）误判为超时。
function isTimeoutError(e: unknown): boolean {
  const msg = (e as Error)?.message || ''
  return /timeout of \d+ms exceeded|ECONNABORTED/i.test(msg)
}

// 追加「失效」分组：保留原有分组、英文逗号连接、去重。
// hasSourceGroup 按 /[,;；、]/ 切分，中文逗号「，」不被识别，故统一用英文逗号。
function withInvalidGroup(group: string | undefined): string {
  const parts = (group || '')
    .split(/[,;；、]/)
    .map((item) => item.trim())
    .filter(Boolean)
  if (!parts.includes(SOURCE_GROUP_INVALID)) parts.push(SOURCE_GROUP_INVALID)
  return parts.join(',')
}

type BatchTestOutcome = BisectTestOutcome<BookSourceTestResponse>

// 单批测试：交给递归二分编排（utils/sourceTesting.ts）。超时不再只拆一层，
// 而是拆到单源——只有「单独测试仍超时」的源才标记失效，避免同批正常源被误伤。
// markInvalid 仍为 true：后端对返回 valid 的源会自动清除「失效」分组，可修复历史误标。
async function testBatchWithRetry(batch: string[]): Promise<BatchTestOutcome> {
  return runBisectSourceTest<BookSourceTestResponse>(batch, {
    request: (urls) =>
      testBookSources({ bookSourceUrls: urls, markInvalid: true, concurrent: 12 }),
    isTimeout: isTimeoutError,
    onSplit: () => {
      // 细分期间进度数字不动，给个标签反馈，避免看起来又卡死
      progressLabel.value = '超时细分中'
    },
  })
}

async function testSources() {
  const targets = selectedFilteredSources.value.length ? selectedFilteredSources.value : sources.value
  if (!targets.length) {
    appStore.showToast('没有可测试的书源', 'warning')
    return
  }
  const scopeText = selectedFilteredSources.value.length ? `选中的 ${targets.length}` : `全部 ${targets.length}`
  if (!confirm(`将测试${scopeText} 个书源。测试会请求外部站点，耗时可能较长，是否继续？`)) return

  testingSources.value = true
  startProgress('测试中', targets.length)
  try {
    // 每批 10 个，便于在统计行实时显示「测试中 X/Y」；后端仍按 12 并发逐批处理
    const batches = chunkBookSourceUrls(targets.map((source) => source.bookSourceUrl), PROGRESS_BATCH_SIZE)
    const allResponses: BookSourceTestResponse[] = []
    const timeoutUrls: string[] = []
    const untestedUrls: string[] = []
    for (const batch of batches) {
      progressLabel.value = '测试中'
      const outcome = await testBatchWithRetry(batch)
      allResponses.push(...outcome.responses)
      timeoutUrls.push(...outcome.timeoutUrls)
      untestedUrls.push(...outcome.untestedUrls)
      // 成功、超时重试、非超时失败都要推进，避免进度 X/N 卡住不动
      bumpProgress(batch.length)
    }

    // 先拉最新态：后端对成功批次可能已写入分组，避免用旧对象覆盖这些变更
    await loadSources()
    if (timeoutUrls.length) {
      try {
        const timeoutSet = new Set(timeoutUrls)
        const toMark = sources.value
          .filter((source) => timeoutSet.has(source.bookSourceUrl))
          .map((source) => ({ ...source, bookSourceGroup: withInvalidGroup(source.bookSourceGroup) }))
        if (toMark.length) {
          await saveBookSources(toMark)
          await loadSources()
        }
      } catch (e: unknown) {
        appStore.showToast(`超时书源标记失效失败：${(e as Error).message}`, 'error')
      }
    }

    const result = mergeBookSourceTestResponses(allResponses)
    if (result.invalid > 0 || timeoutUrls.length > 0) {
      filterGroup.value = SOURCE_GROUP_INVALID
    }
    const parts = [
      `有效 ${result.valid} 个`,
      `失效 ${result.invalid} 个`,
      `超时标记失效 ${timeoutUrls.length} 个`,
    ]
    if (untestedUrls.length) parts.push(`未测 ${untestedUrls.length} 个`)
    appStore.showToast(
      `测试完成：${parts.join('，')}`,
      result.invalid > 0 || timeoutUrls.length > 0 || untestedUrls.length > 0 ? 'warning' : 'success'
    )
  } catch (e: unknown) {
    appStore.showToast((e as Error).message || '书源测试失败', 'error')
  } finally {
    testingSources.value = false
    endProgress()
  }
}

async function removeInvalidSources() {
  if (!invalidSources.value.length) {
    appStore.showToast('没有失效书源', 'warning')
    return
  }
  if (!confirm(`确定删除 ${invalidSources.value.length} 个失效书源？此操作不可撤销。`)) return
  try {
    const result = await deleteInvalidBookSources()
    const invalidUrls = new Set(invalidSources.value.map((source) => source.bookSourceUrl))
    sources.value = sources.value.filter((source) => !invalidUrls.has(source.bookSourceUrl))
    selectedSourceUrls.value.clear()
    if (editingSource.value && invalidUrls.has(editingSource.value.bookSourceUrl)) {
      createSource()
    }
    appStore.showToast(`已删除 ${result.deleted} 个失效书源`, 'success')
  } catch (e: unknown) {
    appStore.showToast((e as Error).message || '删除失效书源失败', 'error')
  }
}

function toggleSourceSelection(source: BookSource) {
  const selected = selectedSourceUrls.value
  if (selected.has(source.bookSourceUrl)) {
    selected.delete(source.bookSourceUrl)
  } else {
    selected.add(source.bookSourceUrl)
  }
}

function toggleFilteredSelection() {
  const selected = selectedSourceUrls.value
  if (allFilteredSelected.value) {
    filteredSources.value.forEach((source) => selected.delete(source.bookSourceUrl))
    return
  }
  filteredSources.value.forEach((source) => selected.add(source.bookSourceUrl))
}

function clearSelection() {
  selectedSourceUrls.value.clear()
}

function pruneSelection() {
  const availableUrls = new Set(sources.value.map((source) => source.bookSourceUrl))
  Array.from(selectedSourceUrls.value).forEach((url) => {
    if (!availableUrls.has(url)) {
      selectedSourceUrls.value.delete(url)
    }
  })
}

function hasSourceGroup(source: BookSource, groupName: string) {
  return (source.bookSourceGroup || '')
    .split(/[,;；、]/)
    .map((group) => group.trim())
    .filter(Boolean)
    .includes(groupName)
}

function createSource() {
  editingSource.value = null
  editorText.value = JSON.stringify(createEmptySource(), null, 2)
}

function editSource(source: BookSource) {
  editingSource.value = source
  editorText.value = JSON.stringify(source, null, 2)
}

function formatEditor() {
  try {
    const parsed = JSON.parse(editorText.value)
    editorText.value = JSON.stringify(parsed, null, 2)
  } catch {
    appStore.showToast('JSON 格式错误，无法格式化', 'error')
  }
}

async function saveEditor() {
  try {
    const parsed = JSON.parse(editorText.value) as BookSource
    if (!parsed.bookSourceName?.trim()) {
      throw new Error('书源名称不能为空')
    }
    if (!parsed.bookSourceUrl?.trim()) {
      throw new Error('书源链接不能为空')
    }
    await saveBookSource(parsed)
    appStore.showToast('保存书源成功', 'success')
    await loadSources()
    const latest = sources.value.find((item) => item.bookSourceUrl === parsed.bookSourceUrl)
    if (latest) {
      editSource(latest)
    }
  } catch (e: unknown) {
    appStore.showToast((e as Error).message || '保存失败', 'error')
  }
}

async function handleSourceLogin() {
  try {
    const parsed = JSON.parse(editorText.value) as BookSource
    if (!parsed.bookSourceUrl?.trim()) {
      throw new Error('书源链接不能为空')
    }
    if (!parsed.loginUrl?.trim()) {
      throw new Error('当前书源未配置 loginUrl')
    }

    // JS 登录书源（如光遇聚合：loginUrl 是脚本而非登录页 URL）→ 弹出账号密码输入
    if (isJsLoginUrl(parsed.loginUrl)) {
      pendingLoginSource.value = parsed
      credentialLoginVisible.value = true
      return
    }

    sourceLoginLoading.value = true
    if (!editingSource.value || editingSource.value.bookSourceUrl !== parsed.bookSourceUrl) {
      await saveBookSource(parsed)
      await loadSources()
      const latest = sources.value.find((item) => item.bookSourceUrl === parsed.bookSourceUrl)
      if (latest) {
        editSource(latest)
      }
    }

    const result = await loginBookSource(parsed.bookSourceUrl)
    const check = typeof result.checkResult === 'string' && result.checkResult.trim()
      ? `，校验结果：${result.checkResult}`
      : ''
    if (result.url?.trim()) {
      loginPreviewUrl.value = result.url
      loginPreviewFrameUrl.value = buildLoginProxyUrl(parsed.bookSourceUrl, result.url)
      loginPreviewVisible.value = true
    }
    appStore.showToast(`书源登录请求已完成，状态 ${result.status}${check}`, 'success')
  } catch (e: unknown) {
    appStore.showToast((e as Error).message || '书源登录失败', 'error')
  } finally {
    sourceLoginLoading.value = false
  }
}

/** 判断 loginUrl 是否为 JS 登录脚本（而非登录页 URL）。 */
function isJsLoginUrl(loginUrl: string): boolean {
  const t = loginUrl.trim()
  // 仅“以” http(s):// 开头才是真实登录页 URL；
  // 不能用 t.includes('://') 判断——光遇等 JS 脚本内部可能含 http://(用于跳转/浏览器打开)
  if (t.startsWith('http://') || t.startsWith('https://')) return false
  if (t.startsWith('@js:') || t.startsWith('<js>')) return true
  return (
    (t.startsWith('//') && t.includes('function ')) ||
    t.includes('function login') ||
    t.includes('function register')
  )
}

/** 提交 JS 登录的账号密码 */
async function submitCredentialLogin() {
  const src = pendingLoginSource.value
  if (!src || !credentialUsername.value.trim() || !credentialPassword.value) {
    appStore.showToast('请输入账号和密码', 'error')
    return
  }
  credentialSubmitting.value = true
  try {
    if (!editingSource.value || editingSource.value.bookSourceUrl !== src.bookSourceUrl) {
      await saveBookSource(src)
      await loadSources()
      const latest = sources.value.find((item) => item.bookSourceUrl === src.bookSourceUrl)
      if (latest) editSource(latest)
    }
    const result = await loginBookSource(src.bookSourceUrl, {
      username: credentialUsername.value.trim(),
      password: credentialPassword.value,
    })
    if (result.success) {
      appStore.showToast(result.message || '登录成功', 'success')
      credentialLoginVisible.value = false
    } else {
      appStore.showToast(result.message || '登录未成功', 'error')
    }
  } catch (e: unknown) {
    appStore.showToast((e as Error).message || '登录失败', 'error')
  } finally {
    credentialSubmitting.value = false
  }
}

function buildLoginProxyUrl(bookSourceUrl: string, targetUrl: string) {
  const params = new URLSearchParams()
  appendAuthQueryParams(params)
  params.set('bookSourceUrl', bookSourceUrl)
  params.set('url', targetUrl)
  return `/reader3/bookSourceProxy?${params.toString()}`
}

function triggerFileImport() {
  fileInputRef.value?.click()
}

// 导入书源时，把 bookSourceGroup 为空的书源自动补为「🎃缺失」，避免空分组不可见。
function fillMissingGroup(sources: BookSource[]): BookSource[] {
  return sources.map((source) => {
    if (!(source.bookSourceGroup || '').trim()) {
      return { ...source, bookSourceGroup: '🎃缺失' }
    }
    return source
  })
}

async function handleFileImport(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  startProgress('解析书源文件')
  try {
    const imported = fillMissingGroup(await readSourceFile(file))
    if (!imported.length) {
      throw new Error('文件中没有可导入的书源')
    }
    const { toSave, skipped } = dedupeBookSources(imported, sources.value)
    if (!toSave.length) {
      appStore.showToast(`没有可导入的书源（已跳过 ${skipped.length} 个重复）`, 'warning')
    } else {
      await saveSourcesWithProgress(toSave, '导入中')
      const msg = `成功导入 ${toSave.length} 个书源`
        + (skipped.length ? `，跳过重复 ${skipped.length} 个` : '')
      appStore.showToast(msg, 'success')
    }
    await loadSources()
  } catch (e: unknown) {
    appStore.showToast((e as Error).message || '导入失败', 'error')
  } finally {
    endProgress()
    input.value = ''
  }
}

async function importRemoteSource() {
  if (!remoteUrl.value) {
    appStore.showToast('请输入远程书源链接', 'warning')
    return
  }
  startProgress('读取远程书源')
  try {
    const raw = await readRemoteSourceFile(remoteUrl.value)
    const parsed = raw.flatMap((item) => {
      try {
        const value = JSON.parse(item)
        return Array.isArray(value) ? value : [value]
      } catch {
        return []
      }
    }) as BookSource[]
    if (!parsed.length) {
      throw new Error('远程书源文件为空或格式错误')
    }
    const { toSave, skipped } = dedupeBookSources(fillMissingGroup(parsed), sources.value)
    if (!toSave.length) {
      appStore.showToast(`没有可同步的书源（已跳过 ${skipped.length} 个重复）`, 'warning')
    } else {
      await saveSourcesWithProgress(toSave, '同步中')
      touchSubscription(remoteUrl.value)
      const msg = `成功同步 ${toSave.length} 个书源`
        + (skipped.length ? `，跳过重复 ${skipped.length} 个` : '')
      appStore.showToast(msg, 'success')
    }
    await loadSources()
  } catch (e: unknown) {
    appStore.showToast((e as Error).message || '远程同步失败', 'error')
  } finally {
    endProgress()
  }
}

function saveSubscription() {
  if (!remoteUrl.value) {
    appStore.showToast('请输入远程书源链接', 'warning')
    return
  }
  if (!subscriptions.value.find((item) => item.url === remoteUrl.value)) {
    subscriptions.value.unshift({ url: remoteUrl.value })
    persistSubscriptions()
    appStore.showToast('订阅已保存', 'success')
  }
}

async function syncSubscription(url: string) {
  remoteUrl.value = url
  await importRemoteSource()
}

function removeSubscription(url: string) {
  subscriptions.value = subscriptions.value.filter((item) => item.url !== url)
  persistSubscriptions()
}

function touchSubscription(url: string) {
  const existing = subscriptions.value.find((item) => item.url === url)
  if (existing) {
    existing.lastSyncedAt = Date.now()
  } else {
    subscriptions.value.unshift({ url, lastSyncedAt: Date.now() })
  }
  persistSubscriptions()
}

function exportSources() {
  // 仅导出选中的书源：要导出全部，需先在筛选栏「全选当前」勾选所有书源。
  const targets = selectedFilteredSources.value
  if (!targets.length) {
    appStore.showToast('请先选择要导出的书源', 'warning')
    return
  }
  const blob = new Blob([JSON.stringify(targets, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `reader-book-sources-${targets.length}-${formatDateForFile()}.json`
  anchor.click()
  URL.revokeObjectURL(url)
  appStore.showToast(`已导出选中的 ${targets.length} 个书源`, 'success')
}

function formatDateForFile() {
  const date = new Date()
  const pad = (v: number) => `${v}`.padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function close() {
  emit('update:modelValue', false)
}

watch(() => props.modelValue, (v) => {
  if (v) {
    // 首次打开、或兼容检测在关闭期间写回了分组，都重新拉库。
    if (sources.value.length === 0 || lastLoadedVersion !== appStore.sourceGroupVersion) {
      loadSources()
    }
    if (!editingSource.value && !editorText.value.trim()) {
      createSource()
    }
  }
}, { immediate: true })

// 兼容检测深度测试写回 bookSourceGroup 后，书源管理页若正打开则立即刷新，
// 分组下拉立刻出现「不兼容 / 需留意」两项，无需手动点刷新按钮。
watch(() => appStore.sourceGroupVersion, () => {
  if (props.modelValue) loadSources()
})
</script>

<style scoped>
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

.source-modal {
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

.hidden-input {
  display: none;
}

.content-grid {
  display: grid;
  grid-template-columns: minmax(320px, 42%) minmax(420px, 58%);
  gap: 14px;
  min-height: 0;
  flex: 1;
  padding: 14px 24px 0;
  overflow: hidden;
}

.source-list-slot,
.editor-slot {
  min-height: 0;
}

.modal-footer {
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 12px;
  padding: 8px 24px 14px;
  flex-shrink: 0;
}

.count-info {
  font-size: 12px;
  color: var(--color-text-tertiary);
}

.mini-btn,
.icon-btn {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: transparent;
  transition: all var(--duration-fast);
}

.mini-btn {
  min-height: 32px;
  padding: 0 10px;
  font-size: 12px;
  white-space: nowrap;
}

.mini-btn.danger {
  color: var(--color-danger);
  border-color: rgba(245, 34, 45, 0.2);
}

.icon-btn {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-secondary);
}

.icon-btn svg {
  width: 18px;
  height: 18px;
}

.mini-btn:hover,
.icon-btn:hover {
  background: var(--color-bg-hover);
}

.login-preview-container {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-modal) + 2);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.35);
}

.login-preview-modal {
  width: min(980px, 100%);
  height: min(86vh, 900px);
  background: var(--color-bg-elevated);
  border-radius: var(--radius-xl);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-xl);
}

.login-preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border-light);
}

.login-preview-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
}

.login-preview-header p {
  margin-top: 6px;
  font-size: 12px;
  color: var(--color-text-tertiary);
  word-break: break-all;
}

.login-preview-frame {
  flex: 1;
  width: 100%;
  border: none;
  background: #fff;
}

.credential-modal {
  display: flex;
  flex-direction: column;
  max-width: 420px;
}

.credential-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 4px 2px 8px;
}

.credential-form label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--color-text-secondary, #555);
}

.credential-form input {
  padding: 10px 12px;
  border: 1.5px solid var(--color-border, #ddd);
  border-radius: 8px;
  font-size: 14px;
  outline: none;
  background: var(--color-bg, #fff);
}

.credential-form input:focus {
  border-color: var(--color-primary, #4a90d9);
}

.credential-submit {
  margin-top: 6px;
  padding: 10px;
  border: none;
  border-radius: 8px;
  background: var(--color-primary, #4a90d9);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}

.credential-submit:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

@media (max-width: 900px) {
  .modal-container {
    align-items: stretch;
    padding: 8px;
  }

  .source-modal {
    width: 100%;
    height: calc(var(--app-height, 100dvh) - 16px);
    max-height: calc(var(--app-height, 100dvh) - 16px);
    border-radius: 24px;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }

  .content-grid {
    display: flex;
    flex-direction: column;
    overflow: visible;
    flex: none;
    padding-left: 16px;
    padding-right: 16px;
  }

  .editor-slot {
    order: -1;
    min-height: 360px;
    max-height: min(58vh, 560px);
  }

  .source-list-slot {
    max-height: min(46vh, 460px);
  }

  .modal-footer {
    padding: 10px 16px 14px;
    background: var(--color-bg-elevated);
    border-top: 1px solid var(--color-border-light);
  }
}

@media (max-width: 420px) {
  .modal-container {
    padding:
      calc(8px + var(--safe-area-top))
      calc(8px + var(--safe-area-right))
      calc(8px + var(--safe-area-bottom))
      calc(8px + var(--safe-area-left));
  }

  .source-modal {
    border-radius: 20px;
  }
}
</style>
