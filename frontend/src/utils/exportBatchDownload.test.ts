import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginBatchExport,
  takeBatchFiles,
  makeBatchDownloadItems,
  revokeBatchDownloadItems,
  abortBatchExport,
  downloadTextAsFile,
} from './exportBook'

let clicks: string[] = []
let createdUrls: string[] = []
let revokedUrls: string[] = []

/** Node 环境下的最小 DOM 下载桩：记录 a.click 与 objectURL 的创建/释放。 */
function stubDom() {
  clicks = []
  createdUrls = []
  revokedUrls = []
  const makeAnchor = () => ({
    href: '', download: '', target: '', rel: '',
    click() { clicks.push(this.download) },
    setAttribute() {},
  })
  vi.stubGlobal('document', {
    createElement: (tag: string) => (tag === 'a' ? makeAnchor() : {}),
    body: { appendChild() {}, removeChild() {} },
  })
  vi.stubGlobal('Blob', class {
    parts: unknown[]
    constructor(parts: unknown[]) { this.parts = parts }
    async arrayBuffer(): Promise<ArrayBuffer> { return new ArrayBuffer(0) }
  })
  vi.stubGlobal('URL', {
    createObjectURL: () => {
      const url = `blob:stub-${createdUrls.length}`
      createdUrls.push(url)
      return url
    },
    revokeObjectURL: (url: string) => { revokedUrls.push(url) },
  })
  vi.stubGlobal('window', { setTimeout: () => 0 })
}

describe('批量导出下载清单（规避 iOS Safari 多次下载拦截）', () => {
  beforeEach(() => stubDom())

  it('收集期间不触发下载，takeBatchFiles 取出后逐个书隔离', () => {
    beginBatchExport()
    downloadTextAsFile('内容甲', '甲.txt')
    downloadTextAsFile('内容乙', '乙.txt')
    expect(clicks).toHaveLength(0) // 收集阶段无 a.click

    const first = takeBatchFiles()
    expect(first.map((f) => f.fileName)).toEqual(['甲.txt', '乙.txt'])
    expect(takeBatchFiles()).toEqual([]) // 取出后清空

    // 下一本继续入列，互不影响
    downloadTextAsFile('丙', '丙.txt')
    expect(takeBatchFiles().map((f) => f.fileName)).toEqual(['丙.txt'])
    expect(clicks).toHaveLength(0) // 全程无程序化下载
  })

  it('makeBatchDownloadItems 为每个文件生成独立 objectURL，供原生 <a download> 点击', () => {
    beginBatchExport()
    downloadTextAsFile('甲', '甲.txt')
    downloadTextAsFile('乙', '乙.txt')
    const files = takeBatchFiles()

    const items = makeBatchDownloadItems(files)
    expect(items.map((it) => it.fileName)).toEqual(['甲.txt', '乙.txt'])
    expect(items.map((it) => it.url)).toEqual(['blob:stub-0', 'blob:stub-1'])
    expect(new Set(items.map((it) => it.url)).size).toBe(2) // URL 互不相同
    expect(clicks).toHaveLength(0) // 生成链接不等于触发下载
  })

  it('revokeBatchDownloadItems 释放清单 URL', () => {
    beginBatchExport()
    downloadTextAsFile('甲', '甲.txt')
    const items = makeBatchDownloadItems(takeBatchFiles())
    revokeBatchDownloadItems(items)
    expect(revokedUrls).toEqual(items.map((it) => it.url))
  })

  it('abort 丢弃已收集文件且不下载（异常兜底）', () => {
    beginBatchExport()
    downloadTextAsFile('内容', 'x.txt')
    abortBatchExport()
    expect(takeBatchFiles()).toEqual([])
    expect(clicks).toHaveLength(0)
  })

  it('未开启收集时，download* 走原本的直接下载（单本导出行为不变）', () => {
    abortBatchExport() // 确保关闭
    downloadTextAsFile('内容', 'single.txt')
    expect(clicks).toEqual(['single.txt'])
  })
})
