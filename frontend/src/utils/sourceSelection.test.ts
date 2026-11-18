import { describe, expect, it } from 'vitest'
import {
  dedupeBookSources,
  filterBookSources,
  getBookSourceGroups,
  getBookSourceGroupOptions,
  getBookSourceOverview,
  getBookSourceStats,
  getVisibleSelection,
  normalizeSourceUrl,
  SOURCE_GROUP_INVALID,
  toBookSourceDeletePayload,
  toRssSourceDeletePayload,
} from './sourceSelection'
import type { BookSource, RssSource } from '../types'

describe('sourceSelection', () => {
  const bookSources: BookSource[] = [
    { bookSourceName: 'Alpha', bookSourceUrl: 'https://alpha.example', enabled: true },
    { bookSourceName: 'Beta', bookSourceUrl: 'https://beta.example', enabled: true },
  ]

  const rssSources: RssSource[] = [
    { sourceName: 'News', sourceUrl: 'https://news.example', enabled: true },
    { sourceName: 'Tech', sourceUrl: 'https://tech.example', enabled: true },
  ]

  it('keeps bulk selection scoped to currently visible source urls', () => {
    const selected = new Set(['https://alpha.example', 'https://hidden.example'])

    expect(getVisibleSelection(bookSources, selected, (source) => source.bookSourceUrl)).toEqual([
      bookSources[0],
    ])
  })

  it('builds batch delete payloads using stable source identifiers', () => {
    expect(toBookSourceDeletePayload(bookSources)).toEqual([
      { bookSourceUrl: 'https://alpha.example' },
      { bookSourceUrl: 'https://beta.example' },
    ])
    expect(toRssSourceDeletePayload(rssSources)).toEqual([
      { sourceName: 'News', sourceUrl: 'https://news.example' },
      { sourceName: 'Tech', sourceUrl: 'https://tech.example' },
    ])
  })

  it('extracts sorted groups from comma-like source group separators', () => {
    const grouped: BookSource[] = [
      { bookSourceName: 'A', bookSourceUrl: 'a', bookSourceGroup: '小说, API' },
      { bookSourceName: 'B', bookSourceUrl: 'b', bookSourceGroup: 'API；精选、小说' },
      { bookSourceName: 'C', bookSourceUrl: 'c' },
    ]

    expect(getBookSourceGroups(grouped)).toEqual(['API', '小说', '精选'])
  })

  it('puts compat marker groups first with counts and pure option values', () => {
    const grouped: BookSource[] = [
      { bookSourceName: 'A', bookSourceUrl: 'a', bookSourceGroup: '⭐笔趣,不兼容' },
      { bookSourceName: 'B', bookSourceUrl: 'b', bookSourceGroup: '🎉精选；需留意' },
      { bookSourceName: 'C', bookSourceUrl: 'c', bookSourceGroup: '⭐笔趣、不兼容' },
      { bookSourceName: 'D', bookSourceUrl: 'd', bookSourceGroup: '📚小说' },
      { bookSourceName: 'E', bookSourceUrl: 'e' },
    ]

    const options = getBookSourceGroupOptions(grouped)
    expect(options.slice(0, 2)).toEqual([
      { value: '不兼容', label: '⛔ 不兼容 (2)', count: 2, tone: 'bad', icon: '⛔', pinned: true },
      { value: '需留意', label: '⚠️ 需留意 (1)', count: 1, tone: 'warn', icon: '⚠️', pinned: true },
    ])
    // 其余分组保持原字典序、纯分组名，label 与 value 一致
    expect(options.slice(2)).toEqual([
      { value: '⭐笔趣', label: '⭐笔趣', count: 2, tone: null, icon: null, pinned: false },
      { value: '🎉精选', label: '🎉精选', count: 1, tone: null, icon: null, pinned: false },
      { value: '📚小说', label: '📚小说', count: 1, tone: null, icon: null, pinned: false },
    ])
    // 置顶项的 value 必须是纯分组名，筛选才能按 includes 命中
    expect(filterBookSources(grouped, '', options[0].value).map((s) => s.bookSourceUrl))
      .toEqual(['a', 'c'])
  })

  it('pins the invalid group from source testing with its own icon and count', () => {
    const grouped: BookSource[] = [
      { bookSourceName: 'A', bookSourceUrl: 'a', bookSourceGroup: '⭐笔趣,失效' },
      { bookSourceName: 'B', bookSourceUrl: 'b', bookSourceGroup: '失效' },
      { bookSourceName: 'C', bookSourceUrl: 'c', bookSourceGroup: '不兼容' },
      { bookSourceName: 'D', bookSourceUrl: 'd', bookSourceGroup: '📚小说' },
    ]

    const options = getBookSourceGroupOptions(grouped)
    expect(options.slice(0, 2)).toEqual([
      { value: '不兼容', label: '⛔ 不兼容 (1)', count: 1, tone: 'bad', icon: '⛔', pinned: true },
      { value: '失效', label: '❌ 失效 (2)', count: 2, tone: 'bad', icon: '❌', pinned: true },
    ])
    // 「失效」不会重复出现在普通分组里
    expect(options.filter((o) => o.value === SOURCE_GROUP_INVALID)).toHaveLength(1)
    // 在分组下拉里筛「失效」能命中含该分组的书源，且不带星号的原分组仍保留
    expect(filterBookSources(grouped, '', SOURCE_GROUP_INVALID).map((s) => s.bookSourceUrl))
      .toEqual(['a', 'b'])
    expect(filterBookSources(grouped, '', '⭐笔趣').map((s) => s.bookSourceUrl))
      .toEqual(['a'])
  })

  it('falls back to plain sorted groups when no compat markers exist', () => {
    const grouped: BookSource[] = [
      { bookSourceName: 'A', bookSourceUrl: 'a', bookSourceGroup: '小说, API' },
      { bookSourceName: 'B', bookSourceUrl: 'b', bookSourceGroup: 'API；精选、小说' },
    ]
    expect(getBookSourceGroupOptions(grouped).map((o) => o.value))
      .toEqual(getBookSourceGroups(grouped))
    expect(getBookSourceGroupOptions(grouped).every((o) => !o.pinned && o.tone === null))
      .toBe(true)
  })

  it('filters book sources by text and group', () => {
    const grouped: BookSource[] = [
      { bookSourceName: '猫眼看书', bookSourceUrl: 'https://maoyan.example', bookSourceGroup: 'API' },
      { bookSourceName: '笔趣阁', bookSourceUrl: 'https://biqu.example', bookSourceGroup: '网页' },
    ]

    expect(filterBookSources(grouped, 'mao', '')).toEqual([grouped[0]])
    expect(filterBookSources(grouped, '', '网页')).toEqual([grouped[1]])
  })

  it('summarizes source counts and selected source metadata', () => {
    const list: BookSource[] = [
      { bookSourceName: 'Enabled', bookSourceUrl: 'enabled', enabled: true, ruleSearch: {}, ruleToc: {} },
      { bookSourceName: 'Disabled', bookSourceUrl: 'disabled', enabled: false },
    ]

    expect(getBookSourceStats(list, [list[0]])).toEqual({
      total: 2,
      enabled: 1,
      filtered: 1,
    })
    expect(getBookSourceOverview(list[0])).toMatchObject({
      group: '未分组',
      statusText: '启用',
      hasSearch: true,
      hasToc: true,
    })
  })

  describe('normalizeSourceUrl', () => {
    it('treats http/https, trailing slash and case as the same', () => {
      expect(normalizeSourceUrl('https://Example.com/Path/')).toBe('example.com/path')
      expect(normalizeSourceUrl('HTTP://example.com/path')).toBe('example.com/path')
      expect(normalizeSourceUrl('  https://example.com/  ')).toBe('example.com')
    })

    it('returns empty string for missing url', () => {
      expect(normalizeSourceUrl('')).toBe('')
      expect(normalizeSourceUrl(undefined)).toBe('')
      expect(normalizeSourceUrl(null)).toBe('')
    })
  })

  describe('dedupeBookSources', () => {
    const existing: BookSource[] = [
      { bookSourceName: '已有A', bookSourceUrl: 'https://a.example' },
      { bookSourceName: '已有B', bookSourceUrl: 'http://b.example/' },
    ]

    it('skips exact same url without overwriting', () => {
      const incoming: BookSource[] = [
        { bookSourceName: '新名A', bookSourceUrl: 'https://a.example' },
        { bookSourceName: '新C', bookSourceUrl: 'https://c.example' },
      ]
      const { toSave, skipped } = dedupeBookSources(incoming, existing)
      expect(toSave.map((s) => s.bookSourceUrl)).toEqual(['https://c.example'])
      expect(skipped).toEqual([{ source: incoming[0], reason: 'url' }])
    })

    it('skips url-similar (http/https, trailing slash, case)', () => {
      const incoming: BookSource[] = [
        { bookSourceName: 'X', bookSourceUrl: 'https://b.example/' },
        { bookSourceName: 'Y', bookSourceUrl: 'HTTP://B.Example' },
      ]
      const { toSave, skipped } = dedupeBookSources(incoming, existing)
      expect(toSave).toHaveLength(0)
      expect(skipped.map((s) => s.reason)).toEqual(['url-similar', 'url-similar'])
    })

    it('skips same name (case/space insensitive)', () => {
      const incoming: BookSource[] = [
        { bookSourceName: '  已有A  ', bookSourceUrl: 'https://new.example' },
      ]
      const { toSave, skipped } = dedupeBookSources(incoming, existing)
      expect(toSave).toHaveLength(0)
      expect(skipped[0].reason).toBe('name')
    })

    it('dedupes duplicates inside the incoming batch, keeping the first', () => {
      const incoming: BookSource[] = [
        { bookSourceName: 'C1', bookSourceUrl: 'https://c.example' },
        { bookSourceName: 'C2', bookSourceUrl: 'https://c.example' },
        { bookSourceName: 'C3', bookSourceUrl: 'https://C.example/' },
      ]
      const { toSave, skipped } = dedupeBookSources(incoming, [])
      expect(toSave).toHaveLength(1)
      expect(toSave[0].bookSourceName).toBe('C1')
      expect(skipped).toHaveLength(2)
    })

    it('keeps distinct sources untouched', () => {
      const incoming: BookSource[] = [
        { bookSourceName: '新D', bookSourceUrl: 'https://d.example' },
      ]
      const { toSave, skipped } = dedupeBookSources(incoming, existing)
      expect(toSave).toHaveLength(1)
      expect(skipped).toHaveLength(0)
    })
  })
})
