# 封面 API

封面统一走 `GET /reader3/cover`，网络书远程封面与本地书内嵌封面由 `path` 参数的形式区分，由后端收敛处理（前端不判断来源）。

## 统一封面接口

```
GET /reader3/cover?path=<封面来源>&accessToken=<token>&secureKey=<key>
```

### 查询参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `path` | 是 | 封面来源，两种形式见下（需 URL 编码） |
| `accessToken` | 否 | 登录令牌，通过 query 传递（`<img src>` 无法带 Header） |
| `secureKey` | 否 | 管理密码，同上 |

鉴权参数经 query 传递，因为封面由 `<img>` 标签直接加载，无法设置请求头。前端封装 `getCoverUrl()`（见文末）会自动拼装。

### `path` 形式一：远程图片 URL

网络书、以及本地书经书源匹配得到的自定义封面，直接传 `http(s)` 图片地址。

```
GET /reader3/cover?path=https%3A%2F%2Fimg.example.com%2Fcover.jpg&accessToken=xxx
```

后端处理：

- 先查本地缓存 `storage/cache/public/cover/{md5(url)}.{ext}`，命中直接返回；
- 未命中则代下载，带 `User-Agent` / `Referer` 绕过防盗链；番茄图床失效时自动降级公共 CDN；
- 按**文件魔数**识别真实 content-type（兼容 AVIF/JPEG 与无扩展名 URL）；
- 响应头 `Cache-Control: 86400`。

### `path` 形式二：本地 EPUB 内嵌封面（导入的本地书）

`path` 传一个内层资源路径，形如：

```
/reader3/localEpubAsset?bookUrl=<本地书URL编码>&path=<EPUB内封面路径编码>
```

该整体再作为 `path` 的值被编码一次后传给统一接口。后端识别到 `/reader3/localEpubAsset` 前缀后，解析出 `bookUrl` 与内部路径，按**当前用户命名空间**直接读本地文件，不经过网络下载。

```
GET /reader3/cover?path=%2Freader3%2FlocalEpubAsset%3FbookUrl%3D...%26path%3DOEBPS%2FImages%2Fcover.jpg&accessToken=xxx
```

- 需登录（解析 `user_ns`），失败返回鉴权错误；
- 响应头 `Cache-Control: private, max-age=3600`。

## 底层本地资源接口

```
GET /reader3/localEpubAsset?bookUrl=<本地书URL>&path=<内部路径>&accessToken=xxx
```

| 参数 | 说明 |
|------|------|
| `bookUrl` | 本地书 URL |
| `path` | EPUB 内部资源路径 |

直接读取本地 EPUB 内部资源（封面是其中一种）。一般不直接调用，而是包在统一 `/reader3/cover` 的 `path` 里，使鉴权与缓存策略收敛到一处。

## 书籍封面字段

书籍对象提供两个封面字段，前端按 `customCoverUrl || coverUrl` 取值：

| 字段 | 来源 |
|------|------|
| `coverUrl` | 书源返回的封面（网络书）；EPUB 解析时提取的内嵌封面路径（本地书） |
| `customCoverUrl` | 多书源搜索匹配到的封面 / 用户手动设置；本地书无封面时由匹配流程写回 |

本地书按「书名 + 作者」建立封面复用缓存（前端 `localCoverCache`），重复导入时命中缓存直接复用 `customCoverUrl`，避免反复搜索。这些最终仍是普通远程 URL，走「形式一」；只有 EPUB 内嵌封面走「形式二」。

## 前端封装

`frontend/src/api/bookshelf.ts` 的 `getCoverUrl(coverUrl)`：

```ts
const params = new URLSearchParams({ path: coverUrl })
appendAuthQueryParams(params) // 附加 accessToken / secureKey
return `/reader3/cover?${params.toString()}`
```

## 相关源码

| 位置 | 说明 |
|------|------|
| `src/api/router.rs:179` | `/reader3/cover` 路由 |
| `src/api/router.rs:181` | `/reader3/localEpubAsset` 路由 |
| `src/api/handlers/book.rs:1747` | `get_book_cover` handler |
| `src/api/handlers/book.rs:1813` | `get_local_epub_asset` handler |
| `src/service/book_service.rs:1216` | `get_cover` 代下载与缓存 |
| `src/service/local_epub_book.rs` | `get_asset` 本地资源读取 |
| `frontend/src/api/bookshelf.ts:282` | `getCoverUrl` 前端封装 |
