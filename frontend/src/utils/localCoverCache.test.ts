import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearLocalCoverCache,
  getCachedCover,
  localCoverKey,
  setCachedCover,
} from './localCoverCache'

class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}

describe('localCoverCache 本地书封面复用', () => {
  beforeEach(() => {
    ;(globalThis as any).localStorage = new MemStorage()
    vi.restoreAllMocks()
  })

  it('缓存键：真实作者用书名+作者，占位作者仅用书名', () => {
    expect(localCoverKey('皇明', '雨落未敢愁')).not.toBe(localCoverKey('皇明', '张三'))
    expect(localCoverKey('皇明', '本地导入')).toBe(localCoverKey('皇明', '佚名'))
    expect(localCoverKey('《皇明》', '雨落未敢愁')).toBe(localCoverKey('皇明', '雨落未敢愁'))
  })

  it('无缓存时返回 null', () => {
    expect(getCachedCover('皇明', '雨落未敢愁')).toBeNull()
  })

  it('命中缓存后复用封面，不同 bookUrl 也能拿到', () => {
    setCachedCover('皇明', '雨落未敢愁', {
      coverUrl: 'http://img/cover.jpg',
      intro: '简介',
      author: '雨落未敢愁',
    })
    // 模拟重复导入：书名作者相同、bookUrl 不同
    const hit = getCachedCover('皇明', '雨落未敢愁')
    expect(hit?.coverUrl).toBe('http://img/cover.jpg')
    expect(hit?.intro).toBe('简介')
  })

  it('无效封面 URL 不写入缓存', () => {
    setCachedCover('皇明', '', { coverUrl: '' })
    expect(getCachedCover('皇明', '')).toBeNull()
  })

  it('作者不同不误配', () => {
    setCachedCover('同名书', '作者A', { coverUrl: 'http://img/a.jpg' })
    expect(getCachedCover('同名书', '作者B')).toBeNull()
  })

  it('清空缓存后全部失效', () => {
    setCachedCover('皇明', '', { coverUrl: 'http://img/cover.jpg' })
    clearLocalCoverCache()
    expect(getCachedCover('皇明', '')).toBeNull()
  })
})
