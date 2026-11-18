<template>
  <div class="reader-book-card" :class="{ active }" @click="$emit('click')">
    <div class="rbc-cover">
      <img
        v-if="cover && !coverFailed"
        :src="cover"
        :alt="title"
        loading="lazy"
        @error="coverFailed = true"
      />
      <div v-else class="rbc-cover-ph">{{ placeholder || (title || '书').slice(0, 1) }}</div>
      <span
        v-if="badge"
        class="rbc-badge"
        :class="{ 'rbc-badge-status': badgeType === 'status', 'rbc-badge-current': badgeType === 'current' }"
      >{{ badge }}</span>
    </div>
    <div class="rbc-info">
      <div class="rbc-title">{{ title }}</div>
      <div class="rbc-meta" v-if="meta">{{ meta }}</div>
      <div class="rbc-line" v-if="primaryLine">{{ primaryLine }}</div>
      <div class="rbc-line" v-if="latest">最新：{{ latest }}</div>
      <div class="rbc-source" v-if="sourceName || sourceUrl">
        <span class="rbc-source-name" v-if="sourceName">{{ sourceName }}</span>
        <span class="rbc-source-url" v-if="sourceUrl">{{ sourceUrl }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'

// 两页共用的书籍卡片：封面 + 详情样式完全一致，仅传入内容不同。
const props = withDefaults(defineProps<{
  cover?: string
  placeholder?: string
  title: string
  meta?: string            // 作者 · 共N章
  primaryLine?: string     // 已读/字数等主详情行（普通色，与其他信息一致）
  latest?: string          // 最新章节标题
  sourceName?: string      // 书源名
  sourceUrl?: string       // 书源域名
  badge?: string                              // 封面右上角角标（推荐 / 状态 / 当前）
  badgeType?: 'primary' | 'status' | 'current'
  active?: boolean         // 双击进入：单击选中后显示同主题色蓝框
}>(), {
  badgeType: 'primary',
  active: false,
})

defineEmits<{ click: [] }>()

const coverFailed = ref(false)
watch(() => props.cover, () => { coverFailed.value = false })
</script>

<style scoped>
.reader-book-card {
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
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: background 0.2s, transform 0.2s;
}
.reader-book-card:hover {
  background: var(--glass-bg-hover, rgba(255,255,255,0.72));
  transform: translateY(-1px);
}
/* 双击进入：单击选中后用同主题色描边提示「再点一次进入」 */
.reader-book-card.active {
  background: color-mix(in srgb, var(--color-primary) 12%, var(--glass-bg, rgba(255,255,255,0.55)));
  box-shadow: 0 0 0 2px var(--color-primary, #f43f5e), var(--glass-shadow, 0 6px 18px rgba(0,0,0,0.06));
}

.rbc-cover {
  width: 62px;
  height: 86px;
  border-radius: 6px;
  overflow: hidden;
  position: relative;
  flex-shrink: 0;
  background: var(--color-bg-sunken, rgba(0,0,0,0.05));
  box-shadow: 0 4px 10px rgba(0,0,0,0.14), 0 0 0 1px rgba(0,0,0,0.04);
}
.rbc-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.rbc-cover-ph {
  width: 100%; height: 100%;
  display: flex; align-items: center; justify-content: center;
  font-size: 22px; font-weight: 700;
  color: var(--color-primary, #f43f5e);
  background: linear-gradient(160deg, color-mix(in srgb, var(--color-primary) 14%, transparent), rgba(70,134,121,0.08));
}
.rbc-badge {
  position: absolute; top: 0; right: 0;
  padding: 2px 5px;
  font-size: 9px; font-weight: 700;
  color: #fff;
  background: var(--color-primary, #f43f5e);
  border-bottom-left-radius: 6px;
}
.rbc-badge-status { background: rgba(0,0,0,0.55); }
.rbc-badge-current { background: #1aa36b; }

.rbc-info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 2px 0;
}
.rbc-title {
  font-size: 15px;
  font-weight: 800;
  color: var(--color-text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  line-height: 1.25;
}
.rbc-meta, .rbc-line {
  font-size: 12px;
  opacity: 0.72;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.rbc-source {
  display: flex; align-items: center; gap: 6px;
  min-width: 0; margin-top: 2px;
}
.rbc-source-name {
  flex-shrink: 0;
  font-size: 11px; font-weight: 600;
  padding: 1px 7px;
  border-radius: var(--radius-full, 999px);
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  color: var(--color-primary, #f43f5e);
  max-width: 60%;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.rbc-source-url {
  min-width: 0;
  font-size: 10px; opacity: 0.48;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

@media (max-width: 380px) {
  .reader-book-card { grid-template-columns: 54px minmax(0, 1fr); gap: 9px; }
  .rbc-cover { width: 54px; height: 74px; }
  .rbc-title { font-size: 14px; }
}
</style>
