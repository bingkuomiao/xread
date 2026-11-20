<template>
  <div class="filter-wrap">
    <section class="filter-bar">
      <label class="bulk-check" :class="{ muted: !hasSources }">
        <input
          type="checkbox"
          :checked="allSelected"
          :disabled="!hasSources"
          :aria-checked="partiallySelected ? 'mixed' : allSelected"
          @change="$emit('toggle-current-selection')"
        />
        <span>{{ allSelected ? '取消全选' : '全选当前' }}</span>
      </label>
      <div class="search-field">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <input
          :value="filterText"
          type="text"
          placeholder="搜索书源名称或 URL"
          @input="$emit('update:filterText', ($event.target as HTMLInputElement).value)"
        />
      </div>
      <!-- 原生 <select>：外观由 global.css 的 .native-select 统一定义，
           与发现管理「切换书源」、发现页筛选下拉共用一套样式；展开后的
           选项列表由系统渲染（PC 浅色 / iOS 深色带勾选）。
           标记分组的 <option> 文本自带符号与数量， iOS 系统下拉里同样可见。 -->
      <select
        :value="filterGroup"
        class="native-select group-select"
        :class="activeTone ? 'group-select-' + activeTone : ''"
        @change="$emit('update:filterGroup', ($event.target as HTMLSelectElement).value)"
      >
        <option value="">全部分组</option>
        <option
          v-for="group in groups"
          :key="group.value"
          :value="group.value"
          :class="group.tone ? 'group-option-' + group.tone : ''"
        >{{ group.label }}</option>
      </select>
      <div v-if="selectedCount > 0" class="selection-tools">
        <span>已选 {{ selectedCount }}</span>
        <button class="mini-btn" type="button" @click="$emit('clear-selection')">清空</button>
        <button class="mini-btn danger" type="button" @click="$emit('delete-selection')">删除选中</button>
        <button class="mini-btn" type="button" @click="$emit('clear-compat-marks')">取消选中</button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { BookSourceGroupOption } from '../../utils/sourceSelection'

const props = defineProps<{
  filterText: string
  filterGroup: string
  groups: BookSourceGroupOption[]
  allSelected: boolean
  partiallySelected: boolean
  selectedCount: number
  hasSources: boolean
}>()

defineEmits<{
  'update:filterText': [value: string]
  'update:filterGroup': [value: string]
  'toggle-current-selection': []
  'clear-selection': []
  'delete-selection': []
  'clear-compat-marks': []
}>()

// 选中标记分组时，让闭合态下拉框跟着变色（下拉自身样式，不新增控件）
const activeTone = computed(
  () => props.groups.find((g) => g.value === props.filterGroup)?.tone ?? null,
)
</script>

<style scoped>
.filter-wrap {
  padding: 0;
}

.filter-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 24px 0;
}

/* ── 标记分组下拉项：置顶、带图标与数量 ─────────────────────────────
   <option> 文本自带符号 + 名称 + 数量，iOS 系统渲染时同样可读；
   PC 浏览器可给 option 上色，这里附加一层，不影响系统渲染的下拉。 */
.group-option-bad {
  color: var(--color-danger);
  font-weight: 600;
}
.group-option-warn {
  color: #b26a00;
  font-weight: 600;
}

/* 选中标记分组时，闭合态下拉框跟着变色，一眼可见当前筛选 */
.group-select-bad {
  border-color: var(--color-danger);
  color: var(--color-danger);
  background-color: color-mix(in srgb, var(--color-danger) 8%, var(--color-bg-sunken));
}
.group-select-warn {
  border-color: var(--color-warning);
  color: #b26a00;
  background-color: color-mix(in srgb, var(--color-warning) 10%, var(--color-bg-sunken));
}

.bulk-check {
  min-height: 40px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg);
  color: var(--color-text-secondary);
  font-size: 13px;
  white-space: nowrap;
}

.bulk-check.muted {
  opacity: 0.5;
}

.bulk-check input {
  width: 16px;
  height: 16px;
  accent-color: var(--color-primary);
}

.search-field {
  flex: 1;
  min-width: 180px;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  padding: 0 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg);
}

.search-field input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  outline: none;
}

/* 闭合态样式全部来自 global.css 的 .native-select（与发现页下拉共用），
   这里只补一个宽度约束，避免分组名过长时把布局撑开。 */
.group-select {
  max-width: 220px;
}

.selection-tools {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  padding: 4px 6px 4px 10px;
  border: 1px solid color-mix(in srgb, var(--color-primary) 22%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
  color: var(--color-text-secondary);
  font-size: 12px;
  white-space: nowrap;
}

.selection-tools span {
  color: var(--color-text-secondary);
}

.mini-btn {
  min-height: 36px;
  padding: 7px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: transparent;
  font-size: 12px;
  white-space: nowrap;
}

.mini-btn:hover {
  background: var(--color-bg-hover);
}

.mini-btn.danger {
  color: var(--color-danger);
  border-color: rgba(245, 34, 45, 0.22);
}

.mini-btn.danger:hover {
  background: rgba(245, 34, 45, 0.08);
}

@media (max-width: 760px) {
  .filter-bar {
    flex-direction: column;
    align-items: stretch;
    padding-left: 16px;
    padding-right: 16px;
  }

  .group-select {
    max-width: none;
  }

  .selection-tools {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    padding: 10px;
  }

  .selection-tools span {
    grid-column: 1 / -1;
  }

  .selection-tools .mini-btn {
    min-height: 42px;
  }
}
</style>
