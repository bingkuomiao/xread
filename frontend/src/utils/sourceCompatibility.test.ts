import { describe, expect, it } from 'vitest'
import {
  checkSourceCompatibility,
  summarizeCompatibility,
  deepTestLevelsFor,
  compatGroupLabelFor,
  applyDeepGroup,
  isComicSource,
  DEEP_GROUP_WARN,
  DEEP_GROUP_BAD,
  type CompatResult,
} from './sourceCompatibility'

// 一个纯 CSS/JsonPath、无缺失 java、有目录规则的「原生兼容」源
function plainSource(): Record<string, unknown> {
  return {
    bookSourceName: '测试小说源',
    bookSourceUrl: 'https://novel.example',
    bookSourceGroup: '📚小说',
    searchUrl: '/search?key={{key}}',
    ruleSearch: { bookList: '$.data.list', name: '$.name', bookUrl: '$.url' },
    ruleToc: { chapterList: '$.data.chapters', chapterName: '$.title' },
    ruleContent: { content: 'class.content@html' },
  }
}

function codes(r: CompatResult): string[] {
  return r.issues.map((i) => i.code)
}

describe('checkSourceCompatibility', () => {
  it('纯规则源判 A 原生兼容，无问题', () => {
    const r = checkSourceCompatibility(plainSource())
    expect(r.level).toBe('A')
    expect(r.issues).toEqual([])
  })

  it('缺失 java 方法判 C，并列出具体方法', () => {
    const s = plainSource()
    s.ruleContent = { content: '@js:\njava.getString("x");\njava.t2s(result)' }
    const r = checkSourceCompatibility(s)
    expect(r.level).toBe('C')
    expect(codes(r)).toContain('JAVA_MISSING')
    expect(r.issues.find((i) => i.code === 'JAVA_MISSING')?.detail).toContain('getString')
  })

  it('已实现的 java 方法（get/put/md5Encode）不判 C', () => {
    const s = plainSource()
    s.ruleContent = { content: '@js:\nvar v = java.get("k"); java.put("k", java.md5Encode(v))' }
    const r = checkSourceCompatibility(s)
    expect(codes(r)).not.toContain('JAVA_MISSING')
  })

  it('依赖 Java Jsoup 判 C', () => {
    const s = plainSource()
    s.ruleContent = { content: '@js:\nvar d = Packages.org.jsoup.Jsoup.parse(result)' }
    const r = checkSourceCompatibility(s)
    expect(r.level).toBe('C')
    expect(codes(r)).toContain('JSOUP')
  })

  it('URL options 含 webView 判 C', () => {
    const s = plainSource()
    s.searchUrl = '/search?key={{key}},{"webView":true}'
    const r = checkSourceCompatibility(s)
    expect(r.level).toBe('C')
    expect(codes(r)).toContain('WEBVIEW')
  })

  it('列表 @tag 链判 B（可降级，不误判 C）', () => {
    const s = plainSource()
    s.ruleToc = { chapterList: '@tag.li@tag.a@text' }
    const r = checkSourceCompatibility(s)
    expect(r.level).toBe('B')
    expect(codes(r)).toContain('TAG_CHAIN')
  })

  it('正文规则用 @get 判 B', () => {
    const s = plainSource()
    s.ruleContent = { content: '@get:{cid}' }
    const r = checkSourceCompatibility(s)
    expect(r.level).toBe('B')
    expect(codes(r)).toContain('CONTENT_VAR')
  })

  it('单花括号 {$.x} 模板判 B', () => {
    const s = plainSource()
    s.ruleSearch = { bookList: '$.data', name: '{$.name}' }
    const r = checkSourceCompatibility(s)
    expect(codes(r)).toContain('SINGLE_BRACE')
  })

  it('JS 模板字符串 ${$.x} 与双花括号 {{$.x}} 不误判为单花括号', () => {
    const s = plainSource()
    s.ruleToc = {
      chapterList: 'list.map($=>`https://x.com/bookId=${$.bookid}&cid=${$.id}`)',
    }
    s.ruleSearch = { bookList: '$.data', name: '{{$.name}}' }
    const r = checkSourceCompatibility(s)
    expect(codes(r)).not.toContain('SINGLE_BRACE')
  })

  it('需登录判 B（不是 C，可登录后使用）', () => {
    const s = plainSource()
    s.loginUrl = 'https://novel.example/login'
    const r = checkSourceCompatibility(s)
    expect(r.level).toBe('B')
    expect(codes(r)).toContain('LOGIN_REQUIRED')
  })

  it('关键回归：漫画/图片源若正文无任何图片渲染信号，判 B「需人工确认」，绝不误判 C', () => {
    const s = plainSource()
    s.bookSourceType = 2
    s.bookSourceGroup = '🎨漫画'
    // 显式图片类型 + 媒体分组，但正文是纯文本规则、既无 <img>/imageDecode 也无真实 imageStyle
    s.ruleContent = { content: '#content@html' }
    const r = checkSourceCompatibility(s)
    expect(r.level).toBe('B') // 不是 C
    expect(codes(r)).toContain('NON_TEXT')
  })

  it('关键回归：正文含 <img> 的漫画源视为已验证渲染路径，判 A 兼容（不误标需留意）', () => {
    const s = plainSource()
    s.bookSourceType = 2
    s.bookSourceGroup = '🎨漫画'
    s.ruleContent = { content: '<img src="{{$.url}}">' }
    const r = checkSourceCompatibility(s)
    expect(r.level).toBe('A')
    expect(codes(r)).not.toContain('NON_TEXT')
  })

  it('关键回归：纯文本小说源带 imageStyle 字段（含 "0"/FULL）不算图片源，判 A 兼容', () => {
    // 修复：imageStyle 在文本小说源里很常见，且 "0" 表示未配置；单凭该字段存在
    // 就把小说源误判成「图片/非文本源 → 需留意」是错误降级。
    for (const v of ['0', 'FULL', 'TEXT', '']) {
      const s = plainSource()
      s.bookSourceGroup = '📚小说'
      s.ruleContent = { content: '#content@html', imageStyle: v }
      const r = checkSourceCompatibility(s)
      expect(r.level, `imageStyle=${JSON.stringify(v)} 应判 A`).toBe('A')
      expect(codes(r), `imageStyle=${JSON.stringify(v)} 不应有 NON_TEXT`).not.toContain('NON_TEXT')
    }
  })

  it('已验证的漫画渲染路径（@js 产出 <img> + imageStyle）判 A 兼容并给出小结', () => {
    const s = plainSource()
    s.bookSourceType = 2
    s.bookSourceGroup = '🎨漫画'
    s.ruleContent = {
      content:
        "@js:\n(function(){var d=JSON.parse(input);var arr=(d&&d.data)||[];return arr.map(function(p){return '<img src=\"'+p.url+'\">';}).join('\\n');})()",
      imageStyle: 'FULL',
    }
    const r = checkSourceCompatibility(s)
    expect(r.level).toBe('A')
    expect(codes(r)).not.toContain('NON_TEXT')
    expect(r.note).toContain('漫画/图片源')
  })

  it('漫画源即便有 imageStyle，若叠加缺失 java 方法仍判 C', () => {
    const s = plainSource()
    s.bookSourceType = 2
    s.bookSourceGroup = '🎨漫画'
    s.ruleContent = {
      content: "@js:\njava.t2s(result)\nreturn '<img src=\"'+result+'\">'",
      imageStyle: 'FULL',
    }
    const r = checkSourceCompatibility(s)
    expect(r.level).toBe('C')
    expect(codes(r)).toContain('JAVA_MISSING')
  })

  it('无目录规则判 B（下载类源）', () => {
    const s = plainSource()
    s.ruleToc = {}
    const r = checkSourceCompatibility(s)
    expect(codes(r)).toContain('NO_TOC')
  })

  it('同时有 C 与 B 问题时按 C 定级', () => {
    const s = plainSource()
    s.loginUrl = 'https://novel.example/login'
    s.ruleContent = { content: 'java.getElement("x")' }
    const r = checkSourceCompatibility(s)
    expect(r.level).toBe('C')
    expect(codes(r)).toContain('JAVA_MISSING')
    expect(codes(r)).toContain('LOGIN_REQUIRED')
  })
})

describe('isComicSource', () => {
  it('bookSourceType=2 视为漫画源', () => {
    expect(isComicSource({ bookSourceType: 2 })).toBe(true)
  })
  it('分组含「漫画」视为漫画源', () => {
    expect(isComicSource({ bookSourceGroup: '🎨漫画' })).toBe(true)
  })
  it('正文含 imageStyle 视为漫画源', () => {
    expect(isComicSource({ ruleContent: { imageStyle: 'FULL' } })).toBe(true)
  })
  it('普通小说源不是漫画源', () => {
    expect(isComicSource(plainSource())).toBe(false)
  })
})

describe('summarizeCompatibility', () => {
  it('汇总 A/B/C 数量与总数', () => {
    const results: CompatResult[] = [
      { level: 'A', issues: [] },
      { level: 'B', issues: [] },
      { level: 'B', issues: [] },
      { level: 'C', issues: [] },
    ]
    expect(summarizeCompatibility(results)).toEqual({ A: 1, B: 2, C: 1, total: 4 })
  })
})

describe('deepTestLevelsFor', () => {
  it('选中「全部」时测试全部书源（A+B+C）', () => {
    expect(deepTestLevelsFor('ALL')).toEqual(['A', 'B', 'C'])
  })
  it('点选某一类卡片时只测该等级', () => {
    expect(deepTestLevelsFor('A')).toEqual(['A'])
    expect(deepTestLevelsFor('B')).toEqual(['B'])
    expect(deepTestLevelsFor('C')).toEqual(['C'])
  })
})

describe('compatGroupLabelFor', () => {
  it('C→不兼容、B→需留意、A→清除标记：只认静态等级，与链路结果无关', () => {
    expect(compatGroupLabelFor('C')).toBe(DEEP_GROUP_BAD)
    expect(compatGroupLabelFor('B')).toBe(DEEP_GROUP_WARN)
    expect(compatGroupLabelFor('A')).toBeNull()
  })

  it('静态「需留意」源无论链路 fail/skip 都不会被标成「不兼容」', () => {
    // 回归：旧实现按链路 overall 映射，B 级源一步失败即被写成不兼容。
    // 现在标记只来自静态等级，链路结果不参与。
    const source = { bookSourceGroup: '⭐笔趣', ruleToc: { chapterList: '' } }
    const level = checkSourceCompatibility(source).level
    expect(level).toBe('B')
    expect(compatGroupLabelFor(level)).toBe(DEEP_GROUP_WARN)
    expect(applyDeepGroup('⭐笔趣', compatGroupLabelFor(level))).toBe('⭐笔趣,需留意')
  })

  it('书源测试写的「失效」标记不会被兼容检测写回清除', () => {
    // applyDeepGroup 只移除「需留意/不兼容」，保留其它分组
    expect(applyDeepGroup('⭐笔趣,失效', compatGroupLabelFor('A'))).toBe('⭐笔趣,失效')
    expect(applyDeepGroup('⭐笔趣,失效', compatGroupLabelFor('B'))).toBe('⭐笔趣,失效,需留意')
    expect(applyDeepGroup('⭐笔趣,失效', compatGroupLabelFor('C'))).toBe('⭐笔趣,失效,不兼容')
  })
})

describe('applyDeepGroup', () => {
  it('在原有分组后追加标记，不破坏原分组', () => {
    expect(applyDeepGroup('📚小说', DEEP_GROUP_BAD)).toBe('📚小说,不兼容')
    expect(applyDeepGroup('📚小说', DEEP_GROUP_WARN)).toBe('📚小说,需留意')
  })
  it('切换结论时去掉旧标记，不重复追加', () => {
    expect(applyDeepGroup('📚小说,需留意', DEEP_GROUP_BAD)).toBe('📚小说,不兼容')
    expect(applyDeepGroup('📚小说,不兼容', DEEP_GROUP_WARN)).toBe('📚小说,需留意')
    expect(applyDeepGroup('📚小说,不兼容', DEEP_GROUP_BAD)).toBe('📚小说,不兼容')
  })
  it('测试通过后清除标记，保留原分组', () => {
    expect(applyDeepGroup('📚小说,需留意', null)).toBe('📚小说')
    expect(applyDeepGroup('不兼容', null)).toBe('')
  })
  it('兼容分号/顿号分隔，且无标记时不改动原格式', () => {
    expect(applyDeepGroup('漫画;小说、精品', DEEP_GROUP_BAD)).toBe('漫画,小说,精品,不兼容')
    expect(applyDeepGroup('漫画;小说', null)).toBe('漫画;小说')
    expect(applyDeepGroup('', null)).toBe('')
  })
})
