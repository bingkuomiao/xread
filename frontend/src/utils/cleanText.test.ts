import { describe, it, expect } from 'vitest'
import { cleanHtmlText, sanitizeBook, sanitizeBooks } from './cleanText'

describe('cleanHtmlText', () => {
  it('空值返回空串', () => {
    expect(cleanHtmlText('')).toBe('')
    expect(cleanHtmlText(null)).toBe('')
    expect(cleanHtmlText(undefined)).toBe('')
  })

  it('纯文本原样返回', () => {
    expect(cleanHtmlText('佚名')).toBe('佚名')
    expect(cleanHtmlText('  Jack  ')).toBe('Jack')
  })

  it('清洗无限小说式的脏 author（字体图标标签 + 实体 + 混排空白）', () => {
    const dirty = '<p><i class="fa fa-user-circle-o">&nbsp;佚名&nbsp;&nbsp; class="s_gray">460 万字&nbsp;&nbsp;3个月前</span></p>'
    // 说明：源码里 `class="s_gray">` 那段是书源拼接错误，被当作文本一部分；清洗后保留可读文字。
    const result = cleanHtmlText(dirty)
    expect(result).not.toContain('<')
    expect(result).not.toContain('>')
    expect(result).not.toContain('&nbsp;')
    expect(result).toContain('佚名')
    expect(result).toContain('460 万字')
    expect(result).toContain('3个月前')
  })

  it('解码常见实体', () => {
    expect(cleanHtmlText('A&nbsp;&amp;&nbsp;B')).toBe('A & B')
    expect(cleanHtmlText('&lt;tag&gt;')).toBe('<tag>')
    expect(cleanHtmlText('&#39;quote&#39;')).toBe("'quote'")
    expect(cleanHtmlText('&#x4F60;&#x597D;')).toBe('你好')
  })

  it('还原字面量转义', () => {
    expect(cleanHtmlText('第一行\\n第二行', { lineBreaks: true })).toBe('第一行\n第二行')
    expect(cleanHtmlText('a\\tb')).toBe('a b')
  })

  it('短字段模式：块级标签转空格（适合作者等单行字段）', () => {
    expect(cleanHtmlText('<p>武侠</p>')).toBe('武侠')
    expect(cleanHtmlText('<div>武侠</div><div>仙侠</div>')).toBe('武侠 仙侠')
  })

  it('长文本模式：br 与块级标签保留换行（适合简介）', () => {
    expect(cleanHtmlText('<p>第一段</p><p>第二段</p>', { lineBreaks: true })).toBe('第一段\n第二段')
    expect(cleanHtmlText('甲<br>乙', { lineBreaks: true })).toBe('甲\n乙')
  })

  it('压缩多余空白与连续换行', () => {
    expect(cleanHtmlText('a    b')).toBe('a b')
    expect(cleanHtmlText('a\n\n\n\nb', { lineBreaks: true })).toBe('a\n\nb')
  })
})

describe('sanitizeBook', () => {
  const dirtyBook = {
    name: '<p>皇明</p>',
    author: '<i class="fa">佚名</i>&nbsp;460 万字',
    intro: '<div class="intro">第一段</div><p>第二段</p>',
    kind: '<span>武侠</span>',
    bookUrl: 'http://x.com/a?b=1&amp;c=2',
    origin: 'https://source.com',
    totalChapterNum: 637,
  }

  it('清洗展示文本字段', () => {
    const out = sanitizeBook(dirtyBook)
    expect(out.name).toBe('皇明')
    expect(out.author).toBe('佚名 460 万字')
    expect(out.kind).toBe('武侠')
    expect(out.intro).toBe('第一段\n第二段')
  })

  it('不清洗 URL / 标识字段（避免破坏查询串与匹配）', () => {
    const out = sanitizeBook(dirtyBook)
    expect(out.bookUrl).toBe('http://x.com/a?b=1&amp;c=2')
    expect(out.origin).toBe('https://source.com')
  })

  it('保留非文本字段原样', () => {
    expect(sanitizeBook(dirtyBook).totalChapterNum).toBe(637)
  })

  it('不修改原对象', () => {
    const orig = { ...dirtyBook }
    sanitizeBook(dirtyBook)
    expect(dirtyBook).toEqual(orig)
  })

  it('sanitizeBooks 批量清洗', () => {
    const out = sanitizeBooks([dirtyBook, dirtyBook])
    expect(out).toHaveLength(2)
    expect(out[0].author).toBe('佚名 460 万字')
  })

  it('空值安全', () => {
    expect(sanitizeBooks(null)).toEqual([])
    expect(sanitizeBooks(undefined)).toEqual([])
  })
})
