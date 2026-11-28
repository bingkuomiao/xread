import { describe, expect, it } from 'vitest'
import { BoundedCache, imageLoadingAttrs } from './readerPerformance'

describe('BoundedCache', () => {
  it('set/get 命中并提升为最近使用', () => {
    const c = new BoundedCache<string>(3)
    c.set('a', '1')
    c.set('b', '2')
    c.set('c', '3')
    expect(c.get('a')).toBe('1')
    // a 被提升为最近使用，淘汰时 b 应最先出局
    c.set('d', '4')
    expect(c.peek('b')).toBeUndefined()
    expect(c.peek('a')).toBe('1')
    expect(c.peek('c')).toBe('3')
    expect(c.peek('d')).toBe('4')
  })

  it('peek 不改变最近使用顺序', () => {
    const c = new BoundedCache<number>(2)
    c.set('a', 1)
    c.set('b', 2)
    expect(c.peek('a')).toBe(1) // peek 不应把 a 提升
    c.set('c', 3)
    expect(c.peek('a')).toBeUndefined()
    expect(c.peek('b')).toBe(2)
  })

  it('更新已有 key 不增加条目数', () => {
    const c = new BoundedCache<number>(2)
    c.set('a', 1)
    c.set('a', 11)
    expect(c.size).toBe(1)
    expect(c.get('a')).toBe(11)
  })

  it('超过上限淘汰最早条目', () => {
    const c = new BoundedCache<number>(2)
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3)
    expect(c.size).toBe(2)
    expect(c.peek('a')).toBeUndefined()
  })

  it('clear 清空所有条目', () => {
    const c = new BoundedCache<number>(2)
    c.set('a', 1)
    c.clear()
    expect(c.size).toBe(0)
    expect(c.peek('a')).toBeUndefined()
  })
})

describe('imageLoadingAttrs', () => {
  it('首张图立即高优先级加载', () => {
    expect(imageLoadingAttrs(0)).toEqual({ loading: 'eager', decoding: 'async', fetchpriority: 'high' })
  })

  it('后续图片懒加载 + 异步解码', () => {
    expect(imageLoadingAttrs(1)).toEqual({ loading: 'lazy', decoding: 'async' })
    expect(imageLoadingAttrs(50)).toEqual({ loading: 'lazy', decoding: 'async' })
  })
})
