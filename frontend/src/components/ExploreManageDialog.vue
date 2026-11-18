<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="modelValue" class="modal-overlay" @click="close"></div>
    </Transition>
    <Transition name="scale">
      <div v-if="modelValue" class="modal-container" @click.self="close">
        <section class="explore-manage-modal">
          <header class="modal-header">
            <div>
              <h2>发现管理</h2>
              <p class="subtitle">配置发现页默认书源，选择后即时生效并同步至其他设备</p>
            </div>
            <button class="icon-btn" @click="close" aria-label="关闭">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </header>

          <div class="modal-body">
            <!-- 发现概览：仿用户管理弹窗「总览」，展示当前发现默认书源的名称与网址 -->
            <section class="overview-panel">
              <div class="overview-head">
                <h3>发现概览</h3>
                <p>当前发现页默认使用的书源</p>
              </div>
              <!-- 统计卡片复刻用户管理「总览」的 .summary-card 排版 -->
              <div class="summary-grid">
                <div class="summary-card">
                  <span>{{ exploreSourceCount }}</span>
                  <small>发现可用书源</small>
                </div>
              </div>
              <div class="current-source-banner">
                <span class="banner-label">当前默认书源</span>
                <strong class="banner-name">
                  <span v-if="currentSourceIcon" class="banner-icon">{{ currentSourceIcon }}</span>{{ currentSourceName }}
                </strong>
                <span class="banner-url">{{ currentSourceUrl || '未设置' }}</span>
              </div>
            </section>

            <section class="work-area">
              <div class="field">
                <div class="field-head">
                  <span class="field-label">切换书源</span>
                </div>
                <!-- 一个组合框：左侧输入过滤、右侧原生下拉选中，共用同一个外边框。
                     原生 <select> 不能输入，故把搜索放在同一框的左半边。 -->
                <div class="source-picker">
                  <label class="picker-search">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" aria-hidden="true">
                      <circle cx="11" cy="11" r="8" />
                      <path d="m21 21-4.3-4.3" />
                    </svg>
                    <input
                      v-model="sourceQuery"
                      type="text"
                      class="picker-search-input"
                      placeholder="搜索书源名称或网址"
                      aria-label="搜索发现书源"
                      autocomplete="off"
                    />
                  </label>
                  <select
                    class="native-select source-select"
                    :value="exploreStore.activeSourceUrl"
                    aria-label="选择发现书源"
                    @change="onSelectSource(($event.target as HTMLSelectElement).value)"
                  >
                    <option
                      v-for="row in displayRows"
                      :key="row.source.bookSourceUrl"
                      :value="row.source.bookSourceUrl"
                    >{{ row.label }}</option>
                  </select>
                </div>
                <p class="field-hint">快速切换书源，在左侧输入名称或网址筛选，再到右侧下拉里选中即永久生效。</p>
              </div>
            </section>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useSourceStore } from '../stores/source'
import { useExploreStore } from '../stores/explore'
import { fetchExploreSourcePreference, saveExploreSourcePreference } from '../api/user'

const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const sourceStore = useSourceStore()
const exploreStore = useExploreStore()

const sourceQuery = ref('')

// 开头「图标区」：允许前导空白后，以 emoji 图形字符 / 区域指示符起始，随后允许连续的
// 图形字符、变体选择符(VS15/VS16)、ZWJ、肤色修饰、键帽组合符、组合标记与空白；遇普通文字即停止。
// 仅用于「提取 / 剥离」书源字段里已经存在的前缀图案，不做任何分类判定、映射、替换或兜底；
// 书源字段由人工检测与格式化，代码只按数据呈现。
const LEADING_ICON_RE = /^\s*[\p{Extended_Pictographic}\p{Regional_Indicator}](?:[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\p{Mark}\uFE0E\uFE0F\u200D\u20E3\s])*/u

// 提取字段开头的图标（去掉空白、保留组合符）；无图标时返回空串（图标位留空）。
function extractIcon(value: string): string {
  const m = LEADING_ICON_RE.exec(value || '')
  return m ? m[0].replace(/\s+/g, '') : ''
}

// 剥离字段开头的前缀图标，只保留文字；无图标时返回原值（仅 trim）。
function stripIcon(value: string): string {
  const raw = value || ''
  const rest = LEADING_ICON_RE.test(raw) ? raw.replace(LEADING_ICON_RE, '') : raw
  return rest.trim() || raw.trim()
}

// 每个 <option> 的文本：分组图标 + 去图标的书源名 + 当前标记。
// 原生 <select> 的选中值必须存在于选项列表中，否则闭合态会显示空白，
// 因此搜索过滤时始终把「当前书源」保留在列表里。
const displayRows = computed(() => {
  const q = sourceQuery.value.trim().toLowerCase()
  const list = exploreStore.exploreSources
  let matched = q
    ? list.filter(
        (s) =>
          (s.bookSourceName || '').toLowerCase().includes(q) ||
          (s.bookSourceUrl || '').toLowerCase().includes(q),
      )
    : list
  const activeUrl = exploreStore.activeSourceUrl
  if (q && activeUrl && !matched.some((s) => s.bookSourceUrl === activeUrl)) {
    const active = list.find((s) => s.bookSourceUrl === activeUrl)
    if (active) matched = [active, ...matched]
  }
  return matched.map((s) => {
    const icon = extractIcon(s.bookSourceGroup || '')
    const name = stripIcon(s.bookSourceName || '') || s.bookSourceUrl
    const active = s.bookSourceUrl === activeUrl
    return {
      source: s,
      label: [icon, name, active ? '（当前）' : ''].filter(Boolean).join(' '),
    }
  })
})

// 发现概览：当前发现默认书源的名称与网址。
// 名称优先取书源自身字段（与下拉选项一样剥离分组前缀图标）；书源已不在
// 发现可用列表里（被删 / 尚未加载）时退回展示网址，避免概览出现空白。
const currentSource = computed(() => {
  const url = exploreStore.activeSourceUrl
  if (!url) return null
  return exploreStore.exploreSources.find((s) => s.bookSourceUrl === url) || null
})

const currentSourceIcon = computed(() => extractIcon(currentSource.value?.bookSourceGroup || ''))

const currentSourceName = computed(() => {
  const url = exploreStore.activeSourceUrl
  if (!url) return '未设置'
  const s = currentSource.value
  return s ? stripIcon(s.bookSourceName || '') || url : url
})

const currentSourceUrl = computed(() => exploreStore.activeSourceUrl || '')

// 发现页可用书源数量（enabledExplore + exploreUrl），用于「发现概览」统计卡片
const exploreSourceCount = computed(() => exploreStore.exploreSources.length)

function onSelectSource(url: string) {
  if (!url) return
  exploreStore.setSource(url)
  // 写回服务端，供其他设备（电脑浏览器 / 手机）自动跟随。
  void saveExploreSourcePreference(url)
  sourceQuery.value = ''
}

watch(
  () => props.modelValue,
  async (visible) => {
    if (!visible) return
    // 先立即把本地偏好（书源工作区刚点过「设为默认」）应用到当前发现源，
    // 让「发现概览」的当前默认书源与「切换书源」下拉的当前值不等网络就更新。
    exploreStore.applyLocalPreference()
    if (sourceStore.sources.length === 0) {
      await sourceStore.fetchSources().catch(() => undefined)
    }
    if (!exploreStore.activeSourceUrl) {
      await exploreStore.init().catch(() => undefined)
    }
    // 服务端偏好仅作多设备跟随；本会话用户已主动选择过时不再覆盖
    const url = await fetchExploreSourcePreference()
    exploreStore.applyServerPreference(url)
  },
)

function close() {
  emit('update:modelValue', false)
}
</script>

<style scoped>
/* 与「书源管理」弹窗 .source-modal / .source-manager-header 同一套风格：
   容器用半透明 --color-bg-elevated（不加模糊、内高光与边框，自然透出遮罩背景）；
   标题栏同底色 + 下边框 + 三级灰 13px 提示；按钮透明描边；内容区靠留白分层、
   不再套实色卡片，输入控件自身实色描边 —— 该透明的透明，该留白的留白。 */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  backdrop-filter: blur(6px);
  z-index: var(--z-overlay);
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

.explore-manage-modal {
  width: min(520px, 100%);
  max-height: min(90vh, 720px);
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-light);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-xl);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.modal-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: calc(var(--space-5) + var(--safe-area-top)) var(--space-6) var(--space-5);
  border-bottom: 1px solid var(--color-divider);
  background: var(--color-bg-elevated);
  flex-shrink: 0;
}

.modal-header h2 {
  font-size: var(--text-xl);
  font-weight: 700;
}

.subtitle {
  margin-top: var(--space-1);
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
}

.icon-btn {
  width: 38px;
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border: none;
  background: none;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all var(--duration-fast);
}

.icon-btn:hover {
  background: var(--color-bg-hover);
}

.icon-btn svg {
  width: 18px;
  height: 18px;
}

.modal-body {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: var(--space-5) var(--space-6);
  display: grid;
  gap: var(--space-6);
  /* 关键：Grid 行顶对齐，避免多余高度把内容拉伸撑满，
     否则首次打开会看不到内容 / 出现大块空白 */
  align-content: start;
}

/* 内容区不再套实色卡片：文字直接落在弹窗半透明底色上，
   与书源管理弹窗的内容区一致，靠留白分层、控件自身描边区分层级。 */

/* 发现概览：仿用户管理弹窗「总览」的 banner 与统计卡片排版 */
.overview-panel {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  border: 1px solid var(--color-border-light);
  border-radius: 14px;
  background: var(--color-bg-elevated);
}

.overview-head h3 {
  font-size: var(--text-base);
  font-weight: 700;
}

.overview-head p {
  margin-top: 4px;
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
}

/* 统计卡片与用户管理「总览」的 .summary-card 同款：大数字 + 小标签 */
.summary-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--space-3);
}

.summary-card {
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border: 1px solid var(--color-border-light);
  border-radius: var(--radius-lg);
  background: var(--color-bg);
}

.summary-card span {
  font-size: 24px;
  font-weight: 700;
  line-height: 1.1;
}

.summary-card small {
  font-size: 13px;
  color: var(--color-text-tertiary);
}

.current-source-banner {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
}

.banner-label {
  color: var(--color-text-secondary);
  font-size: 13px;
}

.banner-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 15px;
  font-weight: 700;
  overflow-wrap: anywhere;
}

.banner-icon {
  flex-shrink: 0;
}

.banner-url {
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
  word-break: break-all;
}

/* 切换书源区做成与「书源管理」弹窗 .source-list-wrapper（书源工作区）同款、
   也与搜索弹窗 .work-area 一致的半透明描边面板：圆角 + 1px 浅边框 +
   自然透出遮罩背景，内部留白排版。 */
.work-area {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border-light);
  border-radius: 14px;
  background: var(--color-bg-elevated);
  overflow: hidden;
}

.field {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
}

.field-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.field-label {
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--color-text);
}

.field-hint {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--color-text-tertiary);
}

/* 一个组合框：搜索输入 + 原生下拉共用同一个外边框，中间仅一条细分隔线。
   闭合态外观与 .native-select / 书源工作区「全部分组」下拉同款；展开后的
   选项列表仍由系统渲染（PC 浅色系统列表 / iOS 深色带勾选的系统列表）。 */
/* 边缘样式与书源管理弹窗 .search-field 一致：实色底 + 更清晰的 1px 边框，
   避免半透明 --color-bg-sunken 叠在半透明弹窗底色上显得过浅、边缘发虚。 */
.source-picker {
  display: flex;
  align-items: stretch;
  min-height: 40px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background-color: var(--color-bg);
  overflow: hidden;
  transition: border-color var(--duration-fast), box-shadow var(--duration-fast);
}

.source-picker:focus-within {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px var(--color-primary-bg);
}

.picker-search {
  flex: 1 1 55%;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  border-right: 1px solid var(--color-border);
  color: var(--color-text-tertiary);
  cursor: text;
}

.picker-search svg {
  flex-shrink: 0;
}

.picker-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-sm);
}

/* 覆盖 global.css .native-select 的边框/圆角/底色，让它融进同一个外框；
   background-image（下拉箭头）与右侧内边距保留。 */
.source-select {
  flex: 0 0 45%;
  min-width: 0;
  width: auto;
  min-height: 40px;
  border: none;
  border-radius: 0;
  background-color: transparent;
}

@media (max-width: 640px) {
  .modal-container {
    padding:
      calc(var(--space-3) + var(--safe-area-top))
      var(--space-3)
      calc(var(--space-3) + var(--safe-area-bottom));
  }

  .modal-header {
    padding: calc(var(--space-4) + var(--safe-area-top)) var(--space-4) var(--space-4);
  }

  .modal-body {
    padding: var(--space-4);
  }

  .explore-manage-modal {
    max-height: 92vh;
  }

  /* 窄屏改为上下两行，仍是同一个外框 */
  .source-picker {
    flex-direction: column;
  }

  .picker-search {
    flex: 0 0 auto;
    min-height: 40px;
    border-right: none;
    border-bottom: 1px solid var(--color-border);
  }

  .source-select {
    flex: 0 0 auto;
    width: 100%;
  }
}
</style>
