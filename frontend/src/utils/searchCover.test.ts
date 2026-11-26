import { describe, expect, it } from 'vitest'
import { unifySearchCovers } from './searchCover'

type Row = { name: string; coverUrl?: string; origin?: string }

describe('unifySearchCovers', () => {
  it('缺封面的条目复用同书其他书源的有效封面', () => {
    const rows: Row[] = [
      { name: '九转混沌诀', coverUrl: undefined, origin: '八零小说' },
      { name: '九转混沌诀', coverUrl: 'https://img.a/correct.jpg', origin: '鸟书网' },
    ]
    const out = unifySearchCovers(rows)
    expect(out[0].coverUrl).toBe('https://img.a/correct.jpg')
    expect(out[1].coverUrl).toBe('https://img.a/correct.jpg')
  })

  it('串图的错误封面被同书第一个有效封面覆盖', () => {
    const rows: Row[] = [
      { name: '九转混沌诀', coverUrl: 'https://img.a/correct.jpg' },
      { name: '九转混沌诀', coverUrl: 'https://img.b/wrong-book-cover.jpg' },
    ]
    const out = unifySearchCovers(rows)
    expect(out[0].coverUrl).toBe('https://img.a/correct.jpg')
    expect(out[1].coverUrl).toBe('https://img.a/correct.jpg')
  })

  it('书名带书名号/空格/大小写差异仍视为同一本', () => {
    const rows: Row[] = [
      { name: '《九转 混沌诀》', coverUrl: 'https://img.a/cover.jpg' },
      { name: '九转混沌诀', coverUrl: undefined },
    ]
    const out = unifySearchCovers(rows)
    expect(out[1].coverUrl).toBe('https://img.a/cover.jpg')
  })

  it('不同书名互不干扰', () => {
    const rows: Row[] = [
      { name: '九转混沌诀', coverUrl: 'https://img.a/cover.jpg' },
      { name: '五行元灵', coverUrl: undefined },
    ]
    const out = unifySearchCovers(rows)
    expect(out[0].coverUrl).toBe('https://img.a/cover.jpg')
    expect(out[1].coverUrl).toBeUndefined()
  })

  it('全是无效封面时保持原样，不引入 data URL', () => {
    const rows: Row[] = [
      { name: '九转混沌诀', coverUrl: 'data:image/png;base64,xxx' },
      { name: '九转混沌诀', coverUrl: 'x' },
    ]
    const out = unifySearchCovers(rows)
    expect(out[0].coverUrl).toBe('data:image/png;base64,xxx')
    expect(out[1].coverUrl).toBe('x')
  })
})
