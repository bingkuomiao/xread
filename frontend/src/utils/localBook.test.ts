import { describe, expect, it } from 'vitest'
import {
  isLocalBook,
  isLocalEpubBook,
  isLocalTxtBook,
  isStandardLocalFileName,
  normalizeLocalBookFileName,
  parseNameAuthorFromFileName,
  parseNameAuthorFromText,
  parseIntroFromText,
  buildStorageFileName,
  parseLocalBookMeta,
} from './localBook'

describe('isLocalTxtBook', () => {
  it('detects uploaded local txt books by origin or url', () => {
    expect(isLocalTxtBook({ origin: 'local-txt', bookUrl: 'anything' })).toBe(true)
    expect(isLocalTxtBook({ origin: 'remote', bookUrl: 'local-txt:abc' })).toBe(true)
    expect(isLocalTxtBook({ origin: 'remote', bookUrl: 'https://example.test/book' })).toBe(false)
    expect(isLocalTxtBook(null)).toBe(false)
  })

  it('detects uploaded local epub books and all local books', () => {
    expect(isLocalEpubBook({ origin: 'local-epub', bookUrl: 'anything' })).toBe(true)
    expect(isLocalEpubBook({ origin: 'remote', bookUrl: 'local-epub:abc' })).toBe(true)
    expect(isLocalBook({ origin: 'local-txt', bookUrl: 'anything' })).toBe(true)
    expect(isLocalBook({ origin: 'remote', bookUrl: 'local-epub:abc' })).toBe(true)
    expect(isLocalBook({ origin: 'remote', bookUrl: 'https://example.test/book' })).toBe(false)
  })
})

describe('isStandardLocalFileName', () => {
  it('accepts names wrapped in book-title marks, including trailing text and author', () => {
    expect(isStandardLocalFileName('《皇明》.txt')).toBe(true)
    expect(isStandardLocalFileName('《书名》中间有其他文字 作者：某某.txt')).toBe(true)
    expect(isStandardLocalFileName('《书名》中间有其他文字  作者：某某.txt')).toBe(true)
    expect(isStandardLocalFileName('《皇明》 作者：雨落见愁.txt')).toBe(true)
    expect(isStandardLocalFileName('《皇明》 作者:雨落见愁.TXT')).toBe(true)
    expect(isStandardLocalFileName('《不灭剑体》（校对版全本）作者：十步行.txt')).toBe(true)
  })

  it('accepts plain names with optional author', () => {
    expect(isStandardLocalFileName('皇明.txt')).toBe(true)
    expect(isStandardLocalFileName('皇明 作者：雨落见愁.txt')).toBe(true)
  })

  it('rejects noisy names without book-title marks', () => {
    expect(isStandardLocalFileName('[某某站]皇明（校对版）.txt')).toBe(false)
    expect(isStandardLocalFileName('皇明【全本】.txt')).toBe(false)
  })
})

describe('normalizeLocalBookFileName', () => {
  it('normalizes standard and noisy file names to one canonical form', () => {
    // 规范格式原样保留语义
    expect(normalizeLocalBookFileName('《皇明》 作者：雨落见愁.txt')).toBe('《皇明》 作者：雨落见愁.txt')
    expect(normalizeLocalBookFileName('《仙河风暴》 作者:快餐店.txt')).toBe('《仙河风暴》 作者：快餐店.txt')
    // 书名号中间有其他文字：取书名号内的书名，丢弃其后文字
    expect(normalizeLocalBookFileName('《书名》中间有其他文字  作者：某某.txt')).toBe('《书名》 作者：某某.txt')
    // 带版本括号
    expect(normalizeLocalBookFileName('《不灭剑体》（校对版全本）作者：十步行.txt')).toBe('《不灭剑体》 作者：十步行.txt')
    // 无书名号：取作者标记前的主干
    expect(normalizeLocalBookFileName('仙河风暴（校对版全本）作者：快餐店.txt')).toBe('《仙河风暴》 作者：快餐店.txt')
    expect(normalizeLocalBookFileName('皇明 作者：雨落见愁.txt')).toBe('《皇明》 作者：雨落见愁.txt')
  })

  it('drops author when missing or placeholder', () => {
    expect(normalizeLocalBookFileName('皇明.txt')).toBe('《皇明》.txt')
    expect(normalizeLocalBookFileName('《皇明》.txt')).toBe('《皇明》.txt')
    expect(normalizeLocalBookFileName('《皇明》 作者：佚名.txt')).toBe('《皇明》.txt')
  })
})

describe('parseNameAuthorFromFileName', () => {
  it('extracts name and author exactly for backend upload fields', () => {
    expect(parseNameAuthorFromFileName('《皇明》 作者：雨落见愁.txt')).toEqual({ name: '皇明', author: '雨落见愁' })
    expect(parseNameAuthorFromFileName('《书名》中间有其他文字  作者：某某.txt')).toEqual({ name: '书名', author: '某某' })
    expect(parseNameAuthorFromFileName('仙河风暴（校对版全本）作者：快餐店.txt')).toEqual({ name: '仙河风暴', author: '快餐店' })
    expect(parseNameAuthorFromFileName('皇明.txt')).toEqual({ name: '皇明', author: '' })
    expect(parseNameAuthorFromFileName('《皇明》 作者：佚名.txt')).toEqual({ name: '皇明', author: '' })
  })
})

describe('parseNameAuthorFromText', () => {
  it('parses name and author labels and standalone title line from head text', () => {
    expect(
      parseNameAuthorFromText('书名：皇明\n作者：雨落见愁\n简介：一段简介。\n\n第1章 穿越'),
    ).toEqual({ name: '皇明', author: '雨落见愁' })
    expect(parseNameAuthorFromText('《仙河风暴》\n作者: 快餐店\n第一章')).toEqual({
      name: '仙河风暴',
      author: '快餐店',
    })
  })

  it('ignores placeholder author and returns empty when body starts directly', () => {
    expect(parseNameAuthorFromText('作者：佚名\n第1章')).toEqual({ name: '', author: '' })
    expect(parseNameAuthorFromText('万历四十八年，秋九月。\n第1章')).toEqual({ name: '', author: '' })
  })
})

describe('buildStorageFileName', () => {
  it('builds canonical storage file name with and without author', () => {
    expect(buildStorageFileName('皇明', '雨落见愁')).toBe('《皇明》 作者：雨落见愁.txt')
    expect(buildStorageFileName('皇明', '')).toBe('《皇明》.txt')
    expect(buildStorageFileName('', '')).toBe('《本地小说》.txt')
    expect(buildStorageFileName('A/B', '某:某')).toBe('《A_B》 作者：某_某.txt')
  })
})

describe('parseLocalBookMeta', () => {
  const head = '书名：皇明\n作者：雨落见愁\n简介：一部讲述皇明兴衰的小说。\n\n第1章 穿越'

  it('uses file name when the file name is standard, filling missing author from head', () => {
    expect(parseLocalBookMeta('《仙河风暴》 作者：快餐店.txt', head)).toEqual({
      name: '仙河风暴',
      author: '快餐店',
      intro: '一部讲述皇明兴衰的小说。',
      storedFileName: '《仙河风暴》 作者：快餐店.txt',
    })
  })

  it('falls back to head text when the file name is not standard (e.g. boot.txt)', () => {
    expect(parseLocalBookMeta('boot.txt', head)).toEqual({
      name: '皇明',
      author: '雨落见愁',
      intro: '一部讲述皇明兴衰的小说。',
      storedFileName: '《皇明》 作者：雨落见愁.txt',
    })
  })

  it('falls back to file name when neither source has complete metadata', () => {
    expect(parseLocalBookMeta('boot.txt', '万历四十八年，秋九月。\n第1章')).toEqual({
      name: 'boot',
      author: '',
      intro: '',
      storedFileName: '《boot》.txt',
    })
  })
})

describe('parseIntroFromText', () => {
  it('parses intro with aliases and stops at blank line or chapter', () => {
    expect(parseIntroFromText('《皇明》\n作者：某某\n简介：一部讲述皇明兴衰的小说。\n\n第1章 穿越')).toBe('一部讲述皇明兴衰的小说。')
    expect(parseIntroFromText('书名：仙河风暴\n内容简介：这是第一行。\n这是第二行。\n第一章')).toBe('这是第一行。\n这是第二行。')
    expect(parseIntroFromText('内容介绍：被书源收录过的故事。')).toBe('被书源收录过的故事。')
  })

  it('returns empty when no intro label', () => {
    expect(parseIntroFromText('万历四十八年，秋九月。\n第1章 穿越')).toBe('')
  })
})
