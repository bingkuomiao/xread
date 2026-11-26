import { describe, expect, it } from 'vitest'
import type { SearchBook } from '../types'
import {
  isPlaceholderAuthor,
  nameMatchScore,
  relevanceScore,
  pickBestMetadata,
  pickConsensusCover,
} from './localBookMatch'

function book(name: string, author: string, coverUrl?: string, intro?: string): SearchBook {
  return { name, author, bookUrl: `${name}-${author}`, origin: 'src', coverUrl, intro }
}

describe('isPlaceholderAuthor', () => {
  it('treats empty and placeholder authors as placeholder', () => {
    expect(isPlaceholderAuthor('')).toBe(true)
    expect(isPlaceholderAuthor('佚名')).toBe(true)
    expect(isPlaceholderAuthor('本地导入')).toBe(true)
    expect(isPlaceholderAuthor('unknown')).toBe(true)
  })
  it('keeps real authors', () => {
    expect(isPlaceholderAuthor('雨落见愁')).toBe(false)
  })
})

describe('nameMatchScore', () => {
  it('ranks exact above contains above prefix above none', () => {
    expect(nameMatchScore('皇明', '皇明')).toBe(3)
    expect(nameMatchScore('皇明风云录', '皇明')).toBe(2)
    expect(nameMatchScore('皇', '皇明')).toBe(1)
    expect(nameMatchScore('三体', '皇明')).toBe(0)
  })
})

describe('relevanceScore', () => {
  it('prefers exact name match', () => {
    expect(relevanceScore(book('皇明', '雨落见愁'), '皇明')).toBeGreaterThan(
      relevanceScore(book('皇明风云录', '某某'), '皇明'),
    )
  })
})

describe('pickBestMetadata', () => {
  it('picks exact match over similar-name books and its cover/intro/author', () => {
    const candidates = [
      book('皇明皇太孙', '甲', 'http://x/wrong.jpg', '错误简介'),
      book('皇明', '雨落见愁', 'http://x/cover.jpg', '一部讲述皇明兴衰的小说。'),
      book('皇明风云录', '乙', 'http://x/other.jpg', '另一个故事'),
    ]
    const result = pickBestMetadata(candidates, '皇明', '本地导入')
    expect(result.coverUrl).toBe('http://x/cover.jpg')
    expect(result.intro).toBe('一部讲述皇明兴衰的小说。')
    expect(result.author).toBe('雨落见愁')
  })

  it('locks known real author among same-name candidates', () => {
    const candidates = [
      book('皇明', '甲作者', 'http://x/a.jpg', '甲的简介'),
      book('皇明', '雨落见愁', 'http://x/b.jpg', '雨落的简介'),
    ]
    const result = pickBestMetadata(candidates, '皇明', '雨落见愁')
    expect(result.coverUrl).toBe('http://x/b.jpg')
    expect(result.intro).toBe('雨落的简介')
    expect(result.author).toBeUndefined() // 已知真实作者，无需补全
  })

  it('skips placeholder cover urls and falls back to next candidate', () => {
    const candidates = [
      book('皇明', '甲', 'http://x/nocover.jpg', '简介甲'),
      book('皇明', '甲', 'http://x/real-cover.webp', '简介乙'),
    ]
    const result = pickBestMetadata(candidates, '皇明', '甲')
    expect(result.coverUrl).toBe('http://x/real-cover.webp')
  })

  it('returns empty when nothing matches', () => {
    expect(pickBestMetadata([book('三体', '刘慈欣')], '皇明', '')).toEqual({})
  })

  it('uses consensus cover: majority cover wins over scattered wrong covers', () => {
    const candidates = [
      book('皇明', '雨落见愁', 'http://cdn.a/x/cover.jpg'),
      book('皇明', '雨落见愁', 'http://cdn.a/x/cover.jpg?size=300'), // 同图不同参数
      book('皇明', '雨落见愁', 'http://cdn.a/x/cover.jpg?size=600'),
      book('皇明', '雨落见愁', 'http://other.b/wrong1.jpg'),
      book('皇明', '雨落见愁', 'http://other.c/wrong2.jpg'),
    ]
    const result = pickBestMetadata(candidates, '皇明', '雨落见愁')
    // 三票同图（指纹相同）胜出，两个各 1 票的串图被淹没
    expect(result.coverUrl).toContain('cover.jpg')
  })
})

describe('pickConsensusCover', () => {
  it('picks the cover appearing most often and ignores placeholders', () => {
    const covers = [
      book('x', 'a', 'http://cdn/common.jpg'),
      book('x', 'b', 'http://cdn/common.jpg'),
      book('x', 'c', 'http://cdn/common.jpg'),
      book('x', 'd', 'http://cdn/rare.jpg'),
      book('x', 'e', 'http://cdn/nocover.jpg'), // 占位，忽略
    ]
    expect(pickConsensusCover(covers)).toBe('http://cdn/common.jpg')
  })

  it('breaks ties by earliest occurrence', () => {
    const covers = [
      book('x', 'a', 'http://cdn/first.jpg'),
      book('x', 'b', 'http://cdn/second.jpg'),
    ]
    expect(pickConsensusCover(covers)).toBe('http://cdn/first.jpg')
  })

  it('returns empty when no effective cover', () => {
    expect(pickConsensusCover([book('x', 'a', 'http://cdn/nocover.jpg')])).toBe('')
  })
})
