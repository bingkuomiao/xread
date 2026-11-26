import { describe, it, expect } from 'vitest'
import { cleanExportedBody } from './cleanText'

describe('cleanExportedBody：导出正文统一清洗', () => {
  it('移除下载站广告、分隔线与自带「内容介绍」重复简介块（用户附图场景）', () => {
    const raw = [
      '======',
      '更多精校小说尽在星舞藏书下载：',
      'http://www.xwcs8.com/',
      '======',
      '内容介绍',
      '地球大学生萧凌宇，意外穿越到修真界，这是一段自带的简介文字。',
      '',
      '正文第一章的内容从这里开始，这段必须原样保留。',
      '这是正文第二行。',
    ].join('\n')

    const result = cleanExportedBody(raw, { dropHeadIntro: true })

    expect(result).not.toContain('======')
    expect(result).not.toContain('xwcs8')
    expect(result).not.toContain('更多精校小说')
    expect(result).not.toContain('内容介绍')
    expect(result).not.toContain('自带的简介文字')
    expect(result).toContain('正文第一章的内容从这里开始')
    expect(result).toContain('这是正文第二行')
  })

  it('标题与正文同行时只删标题几个字、保留正文（用户附图场景）', () => {
    const raw = [
      '内容简介：“早知道要穿越，我一定将那些火……秀儿走到江哲身边。”',
      '这是紧随其后的正文内容，必须保留。',
    ].join('\n')
    const result = cleanExportedBody(raw, { dropHeadIntro: true })
    expect(result).not.toContain('内容简介')
    expect(result).toContain('早知道要穿越')
    expect(result).toContain('这是紧随其后的正文内容')
  })

  it('书头不放简介时（原文自带简介）保留正文里的简介块', () => {
    const raw = [
      '内容简介：',
      '这是原文自带的简介，需要保留。',
      '',
      '正文内容。',
    ].join('\n')
    const result = cleanExportedBody(raw, { dropHeadIntro: false })
    expect(result).toContain('这是原文自带的简介，需要保留')
    expect(result).toContain('正文内容')
  })

  it('清洗 HTML 与双重转义', () => {
    const raw = '&lt;p&gt;第一段&lt;br&gt;第二段&nbsp;结尾&lt;/p&gt;'
    const result = cleanExportedBody(raw, { dropHeadIntro: true })
    expect(result).not.toContain('&lt;')
    expect(result).not.toContain('&nbsp;')
    expect(result).toContain('第一段')
    expect(result).toContain('第二段')
  })

  it('不触碰开头扫描区之外的正文里的分隔线与广告样式文字', () => {
    const lines = Array.from({ length: 45 }, (_, i) => `正文第${i}行`)
    lines[42] = '======'
    lines[43] = 'http://example.com 这是正文里引用的网址'
    const result = cleanExportedBody(lines.join('\n'), { dropHeadIntro: true })
    expect(result).toContain('正文第0行')
    expect(result).toContain('正文第44行')
    expect(result).toContain('======') // 扫描区之外的分隔线保留（正文不重写）
    expect(result).toContain('http://example.com')
  })
})
