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
- **AVIF/HEIC 兼容转码**（v1.0.48+8 起）：若真实字节是 AVIF/HEIC（如 `qbnovel.qq.com` 部分封面返回 `image/avif`），后端用内置 ffmpeg 转成 **JPEG** 再返回（响应 `Content-Type: image/jpeg`），并把 JPEG 回写缓存，后续命中零开销。这解决了 KOReader / PW3 等**无 libavif 的客户端无法解码、只能长期占位**的问题。转码失败时降级返回原字节，不影响可用性；
- 响应头 `Cache-Control: 86400`。

> **Content-Type 透传规则**：`Content-Type` 始终以**真实字节**为准（魔数识别），不是照抄上游响应头——部分站点声明与实际内容不符（如声明 `image/png` 实际是 AVIF）。非 AVIF/HEIC 图片原样透传其真实类型；仅 AVIF/HEIC 会被转成 `image/jpeg`。

### 错误码与鉴权说明

| 场景 | HTTP 状态 | 说明 |
|------|-----------|------|
| `path` 为空 | 404 | 缺少必需参数 |
| 远程封面下载失败 / 上游非 2xx | 404 | 统一返回 NOT_FOUND |
| 本地 EPUB 资源未登录 | **400** | `AppError::BadRequest("NEED_LOGIN")`，**不是 401** |
| 本地 EPUB 资源路径非法 | 404 | `bookUrl`/`path` 缺失 |

> 对接注意：鉴权失败走统一 `AppError` → **`400 Bad Request`（body 为 `{isSuccess:false, errorMsg:"NEED_LOGIN"}`）**，不是 `401`。前端/插件不要用 401 判断是否登录，应看响应体 `errorMsg === 'NEED_LOGIN'` 或 HTTP 400。远程封面接口本身走 `public` 命名空间，无需鉴权。

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

## 兼容性变更

| 版本 | 变更 |
|------|------|
| v1.0.48+8 | 新增 AVIF/HEIC → JPEG 服务端转码（内置 ffmpeg），修复 KOReader/PW3 无法解码 AVIF 封面问题；转码结果回写缓存 |
| v1.0.48+6 | 封面统一到 `GET /reader3/cover`，`Content-Type` 按文件魔数识别，兼容无扩展名 URL 与 AVIF 字节标注 |

## 相关源码

| 位置 | 说明 |
|------|------|
| `src/api/router.rs` | `/reader3/cover`、`/reader3/localEpubAsset` 路由 |
| `src/api/handlers/book.rs` | `get_book_cover` handler（含转码兜底） |
| `src/service/book_service.rs` | `get_cover` 代下载与缓存（含转码+回写） |
| `src/util/image_compat.rs` | 图片兼容模块（ffmpeg 定位、AVIF/HEIC 检测、转 JPEG） |
| `src/service/local_epub_book.rs` | `get_asset` 本地资源读取 |
| `frontend/src/api/bookshelf.ts` | `getCoverUrl` 前端封装 |
