# 章节内容 API

## 获取章节正文

```
POST /reader3/getBookContent   （也支持 GET，参数放查询串）
```

请求参数（JSON body 或查询参数均可）:

| 参数 | 类型 | 说明 |
|------|------|------|
| `chapterUrl` | string | 章节 URL。别名 `url`、`href`（兼容） |
| `bookUrl` | string | **书籍 URL（v1.0.48.214 新增，可选）**。用于精确计算服务端缓存 key；导出/批量等已知书籍的场景应显式传入，避免反查失败导致缓存未命中而重新联网抓取 |
| `bookSourceUrl` | string | 书源 URL。别名 `origin`（兼容） |
| `bookSource` | object | 书源对象（可选） |
| `index` | number | 章节序号，与 `chapterUrl` 二选一 |
| `refresh` | number | 传非 0 时强制刷新、绕过缓存（默认走缓存） |

> **缓存 key 规则（v1.0.48.214 起）**：正文缓存 key 由 `md5(book_url)` 决定。`bookUrl` 的取值优先级为：① 请求显式传入的 `bookUrl`；② 未传时从书架按章节反查；③ 反查失败退回用 `chapterUrl` 作 key。因此**只要调用方已知书籍 URL，都应传 `bookUrl`** 以保证稳定命中缓存。未传时行为与旧版一致（对阅读器无影响，其反查通常成功）。

响应:
```json
{
  "success": true,
  "data": {
    "title": "章节标题",
    "content": "正文内容...",
    "nextUrl": "下一章URL",
    "prevUrl": "上一章URL"
  },
  "errorMsg": null
}
```

## 缓存章节

```
POST /reader3/cacheBookContent
```

请求体:
```json
{
  "urls": ["https://...", "https://..."]
}
```

## 获取阅读进度

```
GET /reader3/getReadProgress
```

查询参数:
- `bookUrl` - 书籍URL

响应:
```json
{
  "success": true,
  "data": {
    "bookUrl": "https://...",
    "chapterUrl": "https://...",
    "chapterTitle": "章节标题",
    "readProgress": 50.5,
    "updateTime": 1699999999999
  },
  "errorMsg": null
}
```

## 保存阅读进度

```
POST /reader3/saveReadProgress
```

请求体:
```json
{
  "bookUrl": "https://...",
  "chapterUrl": "https://...",
  "chapterTitle": "章节标题",
  "readProgress": 50.5
}
```
