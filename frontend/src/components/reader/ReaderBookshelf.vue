<template>
  <div class="reader-bookshelf" :style="{ background: theme.popup, color: theme.fontColor }">
    <div class="shelf-header">
      <h3>切换书籍 ({{ store.books.length }})</h3>
      <!-- 与缓存页一致的返回按钮：直接返回首页书架页 -->
      <button class="back-btn" @click="$emit('goHome')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 18-6-6 6-6" /></svg>
      </button>
    </div>

    <div class="shelf-list">
      <ReaderBookCard
        v-for="book in store.books"
        :key="book.bookUrl"
        :card-bg="theme.popup"
        :card-fg="theme.fontColor"
        :cover="getCoverUrl(book.customCoverUrl || book.coverUrl)"
        :title="book.name"
        :meta="bookMeta(book)"
        :primary-line="book.durChapterTitle ? `已读：${book.durChapterTitle}` : ''"
        :latest="book.latestChapterTitle"
        :badge="book.bookUrl === readerStore.book?.bookUrl ? '当前' : undefined"
        badge-type="current"
        :active="armedKey === book.bookUrl"
        @click="onCardClick(book)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import ReaderBookCard from './ReaderBookCard.vue'
import { useBookshelfStore } from '../../stores/bookshelf'
import { useReaderStore } from '../../stores/reader'
import { getCoverUrl } from '../../api/bookshelf'
import type { Book } from '../../types'
const store = useBookshelfStore()
const readerStore = useReaderStore()
const theme = computed(() => readerStore.currentTheme)

defineEmits<{ goHome: [] }>()

// 与附件书架卡片一致的「作者 · 共X章」副标题
function bookMeta(book: Book) {
  const author = (book.author || '').trim() || '未知作者'
  const count = book.totalChapterNum || 0
  return count ? `${author} · 共${count}章` : author
}

if (!store.books.length) {
  store.fetchBooks()
}

// 双击进入：第一次点击仅选中（蓝框），再次点击同一本才真正打开
const armedKey = ref<string | null>(null)
function onCardClick(book: Book) {
  if (armedKey.value === book.bookUrl) {
    openBook(book)
  } else {
    armedKey.value = book.bookUrl
  }
}

async function openBook(book: Book) {
  if (book.bookUrl !== readerStore.book?.bookUrl) {
    readerStore.clear()
    await readerStore.loadBook(book)
    await readerStore.loadChapter(book.durChapterIndex || 0)
  }
  readerStore.closePanel()
}
</script>

<style scoped>
.reader-bookshelf {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.shelf-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid rgba(0,0,0,0.06);
  flex-shrink: 0;
}

.shelf-header h3 {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}

.back-btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  color: inherit;
  opacity: 0.6;
  background: transparent;
  border: none;
  cursor: pointer;
}
.back-btn:hover {
  opacity: 1;
  background: rgba(0,0,0,0.05);
}
.back-btn svg {
  width: 18px;
  height: 18px;
}

.shelf-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
}
</style>
