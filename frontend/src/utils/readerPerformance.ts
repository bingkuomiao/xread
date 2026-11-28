/**
 * 阅读器性能工具（纯逻辑，不依赖 DOM，便于单测）。
 */

/**
 * 有界 LRU 缓存：命中提升为最近使用，超过上限淘汰最早条目。
 * 用于缓存正文清洗结果（key 为整章原文），避免同一章重复做昂贵的 DOM 清洗。
 */
export class BoundedCache<V> {
  private readonly map = new Map<string, V>()
  private readonly maxEntries: number

  constructor(maxEntries: number = 8) {
    this.maxEntries = maxEntries
  }

  /** 读取但不改变最近使用顺序。 */
  peek(key: string): V | undefined {
    return this.map.get(key)
  }

  /** 读取并提升为最近使用。 */
  get(key: string): V | undefined {
    if (!this.map.has(key)) return undefined
    const value = this.map.get(key) as V
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key)
    } else if (this.map.size >= this.maxEntries) {
      // 删除最早插入（Map 保持插入顺序）的条目。
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    this.map.set(key, value)
  }

  get size(): number {
    return this.map.size
  }

  clear(): void {
    this.map.clear()
  }
}

export interface ImageLoadingAttrs {
  loading: 'eager' | 'lazy'
  decoding: 'async'
  fetchpriority?: 'high'
}

/**
 * 图片加载策略：首张图立即高优先级加载（保证首屏有画面），
 * 其余图片懒加载 + 异步解码（避免一次性向远程书源请求整章图片阻塞首开）。
 */
export function imageLoadingAttrs(index: number): ImageLoadingAttrs {
  if (index === 0) {
    return { loading: 'eager', decoding: 'async', fetchpriority: 'high' }
  }
  return { loading: 'lazy', decoding: 'async' }
}
