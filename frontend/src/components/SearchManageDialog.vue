<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="modelValue" class="modal-overlay" @click="close"></div>
    </Transition>
    <Transition name="scale">
      <div v-if="modelValue" class="modal-container" @click.self="close">
        <section class="search-manage-modal">
          <header class="modal-header">
            <div>
              <h2>搜索管理</h2>
              <p class="subtitle">调整结果匹配方式与搜索范围</p>
            </div>
            <button class="icon-btn" @click="close" aria-label="关闭">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </header>

          <div class="modal-body">
            <section class="work-area">
              <div class="field">
                <div class="field-head">
                  <span class="field-label">精确匹配</span>
                  <button
                    type="button"
                    class="action-btn search-toggle"
                    :class="{ active: appStore.exactMatch }"
                    role="switch"
                    :aria-checked="appStore.exactMatch"
                    @click="appStore.toggleExactMatch()"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" aria-hidden="true">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                    {{ appStore.exactMatch ? '已开启' : '已关闭' }}
                  </button>
                </div>
                <p class="field-hint">只想看「书名或作者」和关键词一模一样的结果，把近似的都过滤掉。</p>
              </div>
            </section>
            <section class="work-area">
              <div class="field">
                <div class="field-head">
                  <span class="field-label">全部书源</span>
                  <button
                    type="button"
                    class="action-btn search-toggle"
                    :class="{ active: appStore.searchAllByDefault }"
                    role="switch"
                    :aria-checked="appStore.searchAllByDefault"
                    @click="appStore.toggleSearchAllByDefault()"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" aria-hidden="true">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                    {{ appStore.searchAllByDefault ? '已开启' : '已关闭' }}
                  </button>
                </div>
                <p class="field-hint">打开后，从顶部搜索框发起搜索会一次性搜遍所有书源，而不只在当前书源里找。</p>
              </div>
            </section>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { useAppStore } from '../stores/app'

const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const appStore = useAppStore()

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

.search-manage-modal {
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

/* 精确搜索区做成与「书源管理」弹窗 .source-list-wrapper（书源工作区）同款的
   半透明描边面板：圆角 + 1px 浅边框 + 自然透出遮罩背景，内部留白排版。 */
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

/* 开关按钮：与「备份与恢复」页 .action-btn 一致，浅边框 + 沉底背景，激活态为蓝色实心 */
.action-btn {
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: 8px 12px;
  font-size: var(--text-sm);
  font-weight: 600;
  white-space: nowrap;
  border: 1px solid var(--color-border-light);
  border-radius: var(--radius-md);
  background: var(--color-bg-sunken);
  color: var(--color-text);
  cursor: pointer;
  transition: all var(--duration-fast);
}

.action-btn svg {
  width: 14px;
  height: 14px;
}

.action-btn:hover {
  background: var(--color-bg-hover);
}

.action-btn.search-toggle.active {
  color: #fff;
  background: var(--color-primary);
  border-color: var(--color-primary);
}

.action-btn.search-toggle.active:hover {
  background: var(--color-primary-dark);
  color: #fff;
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

  .search-manage-modal {
    max-height: 92vh;
  }
}
</style>
