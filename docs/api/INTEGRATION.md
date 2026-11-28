# 前端对接完整指南（INTEGRATION）

> 本文是面向「其他前端 / 第三方客户端」的一站式对接文档，把散落在 `docs/api/` 下各分类文档
> 以及历次接口变动归档**融合为一份**，方便开发同学只需看这一篇即可完成对接。
> 各分类文档仍然保留，用于按主题细查；本文以「能直接用」为目标，含鉴权、通用约定、
> 全接口速查、关键接口详解、变更历史与易错点。
>
> 最后更新：v1.0.48.217（2026-11-28）

---

## 1. 基础信息

| 项 | 值 |
|------|------|
| 服务前缀 | 所有业务接口均以 `/reader3` 开头 |
| 本机默认地址 | `http://localhost:7777/reader3` |
| 数据格式 | 请求/响应均为 JSON（`application/json`），个别接口支持表单/查询串 |
| 编码 | UTF-8 |

### 1.1 统一响应包

所有接口返回同一外层结构：

```json
{
  "success": true,
  "data": { ... },
  "errorMsg": null
}
```

失败时：

```json
{
  "success": false,
  "data": null,
  "errorMsg": "错误信息"
}
```

> 前端务必先判断 `success`，再读 `data`；`errorMsg` 可能为空。

### 1.2 HTTP 方法

| 方法 | 用途 |
|------|------|
| GET | 读取资源（列表、详情、正文等，参数多放查询串） |
| POST | 写入 / 变更 / 触发任务（参数放 JSON body） |

部分接口（如 `getBookContent`）**GET 与 POST 都支持**，见后文详解。

---

## 2. 鉴权

### 2.1 三种凭证

| 凭证 | 传递方式 | 使用场景 |
|------|----------|----------|
| `accessToken` | Header `Authorization: Bearer <token>` | 登录后各大业务接口 |
| `secureKey` | Header / 特定字段 | 开启管理密码（安全模式）时 |
| query 鉴权参数 | `?accessToken=&secureKey=` | **无法设置 Header 的资源请求**（如 `<img>`、SSE、封面） |

```http
Authorization: Bearer <token>
```

登录接口见 [3.1 用户](#31-用户与鉴权-usermd)。

### 2.2 资源类请求走 query

封面、章节内本地图片由浏览器 `<img>` / SSE 直接加载，无法注入 Header，故鉴权参数**拼在 URL 查询串**。前端请统一用封装函数：

- 封面：`getCoverUrl()` → `/reader3/cover?path=...&accessToken=...`（详见 [cover.md](./cover)）
- 本地书资源：`/reader3/localEpubAsset?bookUrl=...&path=...&accessToken=...`

### 2.3 单用户 / 公开读

未开启用户系统时为单用户模式，接口通常无需 token；开启 `publicRead` 后部分读接口可匿名访问，写接口仍需授权。以 `getUserInfo` 返回的权限字段判断：

```json
{ "isLoggedIn": true, "isAdmin": false, "publicRead": true, "needSecureKey": false }
```

---

## 3. 接口分类速查

> 下表按主题分组，给出「路径 · 方法 · 一句话说明」。详细参数见对应分类文档或本文第 4 节。

### 3.1 用户与鉴权（user.md）

| 路径 | 方法 | 说明 |
|------|------|------|
| `/reader3/login` | POST | 登录，返回 token |
| `/reader3/register` | POST | 注册用户 |
| `/reader3/logout` | POST | 登出（会使 token 缓存失效） |
| `/reader3/getUserInfo` | GET | 当前用户信息与权限 |
| `/reader3/getUserList` | GET | 用户列表（管理） |
| `/reader3/addUser` | POST | 新增用户（管理） |
| `/reader3/updateUser` | POST | 更新用户（管理） |
| `/reader3/deleteUsers` | POST | 删除用户（管理） |
| `/reader3/changePassword` | POST | 修改密码 |
| `/reader3/resetPassword` | POST | 重置密码（管理） |
| `/reader3/getUserConfig` | GET | 读取用户阅读配置 |
| `/reader3/saveUserConfig` | POST | 保存用户阅读配置 |

登录请求/响应：

```jsonc
// POST /reader3/login
{ "username": "用户名", "password": "密码" }
// →
{ "success": true, "data": { "token": "jwt-string", "username": "用户名" }, "errorMsg": null }
```

### 3.2 书源管理（book-source.md）

| 路径 | 方法 | 说明 |
|------|------|------|
| `/reader3/getBookSources` | GET | 书源列表 |
| `/reader3/getBookSource` | GET | 单个书源 |
| `/reader3/saveBookSource` | POST | 新增/更新书源 |
| `/reader3/saveBookSources` | POST | 批量保存 |
| `/reader3/deleteBookSource` | POST | 删除（`{url}`） |
| `/reader3/deleteBookSources` | POST | 批量删除（`{urls}`） |
| `/reader3/deleteAllBookSources` | POST | 删除全部 |
| `/reader3/deleteInvalidBookSources` | POST | 清理失效源 |
| `/reader3/setAsDefaultBookSources` | POST | 设为默认源 |
| `/reader3/getDefaultBookSourceOwner` | GET | 默认源归属 |
| `/reader3/importBookSources` | POST | 导入（body 为书源数组） |
| `/reader3/exportBookSources` | POST | 导出 |
| `/reader3/testBookSources` | POST | 测试可用性 |
| `/reader3/loginBookSource` | POST | 书源登录 |
| `/reader3/getAvailableBookSource` | GET | 可用来源（换源页用） |
| `/reader3/getAvailableBookSourceSSE` | GET | 可用来源 SSE（换源页实时流） |
| `/reader3/searchBookSourceSSE` | GET | 按关键词搜源 SSE |
| `/reader3/bookSourceDebugSSE` | GET | 书源调试 SSE |
| `/reader3/bookSourceProxy` | GET | 书源网络请求代理（携带源 cookies/UA） |
| `/reader3/bookSourceClientLog` | POST | 书源运行日志上报 |

### 3.3 搜索 / 详情 / 目录（search.md）

| 路径 | 方法 | 说明 |
|------|------|------|
| `/reader3/searchBook` | GET | 单源搜索（`key` / `page` / `bookSourceUrl`） |
| `/reader3/searchBookMulti` | GET | 多源搜索 |
| `/reader3/searchBookMultiSSE` | GET | 多源搜索 SSE（边搜边返回） |
| `/reader3/exploreBook` | GET | 发现/分类列表 |
| `/reader3/getExploreKinds` | GET | 发现分类 |
| `/reader3/getBookInfo` | GET | 书籍详情（`url`） |
| `/reader3/getChapterList` | GET | 目录（`url`=目录页或书 URL，返回章节数组含 `title/url/index`） |

### 3.4 章节内容 / 正文（chapter.md）

| 路径 | 方法 | 说明 |
|------|------|------|
| `/reader3/getBookContent` | GET + POST | **获取章节正文**（含缓存，详见第 4.1 节） |
| `/reader3/cacheBookSSE` | GET | 批量缓存章节 SSE（进度流） |
| `/reader3/deleteBookCache` | POST | 删除服务端章节缓存 |
| `/reader3/getShelfBookWithCacheInfo` | GET | 书架 + 各书已缓存章节数 |

### 3.5 书架 / 书籍 / 书签 / 分组

| 路径 | 方法 | 说明 |
|------|------|------|
| `/reader3/getBookshelf` | GET | 书架列表 |
| `/reader3/getShelfBook` | GET | 单本书 |
| `/reader3/saveBook` | POST | 保存/新增书 |
| `/reader3/saveBooks` | POST | 批量保存（**用于顺序/置顶持久化**） |
| `/reader3/deleteBook` | POST | 删书 |
| `/reader3/deleteBooks` | POST | 批量删书 |
| `/reader3/setBookSource` | POST | 换源（改写 `book_url`/`origin`，**本地书禁用**） |
| `/reader3/saveBookProgress` | POST | 保存阅读进度 |
| `/reader3/getBookmarks` | GET | 书签列表 |
| `/reader3/saveBookmark` / `saveBookmarks` | POST | 保存书签 |
| `/reader3/deleteBookmark(s)` | POST | 删除书签 |
| `/reader3/getBookGroups` | GET | 分组列表 |
| `/reader3/saveBookGroup` / `saveBookGroupId` / `saveBookGroupOrder` | POST | 分组增删改序 |
| `/reader3/deleteBookGroup` | POST | 删除分组 |
| `/reader3/addBookGroupMulti` / `removeBookGroupMulti` | POST | 批量加入/移出分组 |

> 置顶逻辑：前端把书移到数组首位后调用 `saveBooks(next)` 全量写回；后端不提供单一「置顶」接口。

### 3.6 封面 / 本地资源（cover.md）

| 路径 | 方法 | 说明 |
|------|------|------|
| `/reader3/cover` | GET | **统一封面**（远程 URL 或本地 EPUB 内嵌图，详见第 4.2 节） |
| `/reader3/localEpubAsset` | GET | 读取本地 EPUB 内部资源（封面等） |

### 3.7 本地书导入 / 导出

| 路径 | 方法 | 说明 |
|------|------|------|
| `/reader3/uploadTxtBook` | POST | 导入本地 TXT |
| `/reader3/uploadEpubBook` | POST | 导入本地 EPUB |
| `/reader3/importLocalBooks` | POST | 批量导入 |
| `/reader3/exportLocalBook(s)` | GET/POST | 导出本地书 |
| `/reader3/uploadFile` | POST | 通用文件上传 |
| `/reader3/deleteFile` | POST | 删除文件 |
| `/reader3/readSourceFile` | GET | 读取书源文件 |
| `/reader3/readRemoteSourceFile` / `readRemoteRssSourceFile` | GET | 读取远程文件 |
| `/reader3/getTxtTocRules` | GET | TXT 目录识别规则 |

### 3.8 替换规则

| 路径 | 方法 | 说明 |
|------|------|------|
| `/reader3/getReplaceRules` | GET | 规则列表 |
| `/reader3/saveReplaceRule(s)` | POST | 保存规则 |
| `/reader3/deleteReplaceRule(s)` | POST | 删除规则 |

### 3.9 RSS（rss.md）

| 路径 | 方法 | 说明 |
|------|------|------|
| `/reader3/getRssSources` | GET | 源列表 |
| `/reader3/saveRssSource(s)` | POST | 保存源 |
| `/reader3/deleteRssSource(s)` | POST | 删除源 |
| `/reader3/getRssContent` / `getRssArticles` | GET | 内容/文章 |
| `/reader3/readRssSourceFile` / `readRemoteRssSourceFile` | GET | 读取订阅源文件 |

### 3.10 WebDAV

| 路径 | 方法 | 说明 |
|------|------|------|
| `/reader3/webdav/*path` | GET | 列目录/读文件（`*path` 为相对路径） |
| `/reader3/uploadFileToWebdav` | POST | 上传 |
| `/reader3/deleteWebdavFile(List)` | POST | 删除 |
| `/reader3/getWebdavFile(List)` | GET | 读取 |

### 3.11 AI / 视频 / 版本 / 健康

| 路径 | 方法 | 说明 |
|------|------|------|
| `/reader3/aiProxy` / `aiProxyImage` | POST | AI 文本/图片代理 |
| `/reader3/getAiModelConfig` / `saveAiModelConfig` | GET/POST | AI 模型配置 |
| `/reader3/getAiBookMemory` / `saveAiBookMemory` / `deleteAiBookMemory` | GET/POST | AI 书摘记忆 |
| `/reader3/convertVideoToMp4` | POST | 视频转码（m3u8 下载） |
| `/reader3/convertVideoProgress` / `convertVideoResult` / `convertVideoCancel` | GET/POST | 转码进度/结果/取消 |
| `/reader3/videoDownloadStatus` | GET | 下载状态 |
| `/reader3/getVersionUpdate` | GET | 检查新版本 |
| `/reader3/dismissVersionUpdate` | POST | 忽略该版本提示 |
| `/health` | GET | 健康检查 |

---

## 4. 关键接口详解（易错点）

### 4.1 获取章节正文 `getBookContent` ★v214 变动

**GET 与 POST 都支持**（参数可放查询串或 JSON / form body）。

| 参数 | 类型 | 说明 |
|------|------|------|
| `chapterUrl` | string | 章节 URL；别名 `url`、`href`（兼容旧调用） |
| `bookUrl` | string | **v214 新增（可选）**：书籍 URL，用于精确计算服务端缓存 key |
| `bookSourceUrl` | string | 书源 URL；别名 `origin` |
| `bookSource` | object | 书源对象（可选） |
| `index` | number | 章节序号，与 `chapterUrl` 二选一 |
| `refresh` | number | 非 0 时强制刷新、绕过缓存 |

```jsonc
// 推荐：显式传 bookUrl，稳定命中缓存
{ "chapterUrl": "https://.../ch1.html", "bookUrl": "https://.../book.html", "refresh": 0 }
// → { "success": true, "data": { "title": "第一章", "content": "...", "nextUrl": "...", "prevUrl": "..." }, "errorMsg": null }
```

> **缓存 key 规则（v214 起）**：正文缓存 key = `md5(book_url)`。`bookUrl` 取值优先级：
> ① 请求显式传入 → ② 服务端从书架按章节反查 → ③ 反查失败退回用 `chapterUrl`。
> **调用方已知书籍 URL 时务必传 `bookUrl`**（导出、批量缓存等场景），否则可能缓存未命中、
> 重复联网抓取。阅读器主流程走反查通常成功，行为与旧版一致。

### 4.2 统一封面 `getCoverUrl` ★已归档 cover.md

```
GET /reader3/cover?path=<来源>&accessToken=<token>&secureKey=<key>
```

`path` 两种形式：

1. **远程图片 URL**（网络书封面、本地书匹配到的封面）：
   `path=https%3A%2F%2Fimg.example.com%2Fcover.jpg`
   - 服务端先查本地缓存 `storage/cache/public/cover/{md5(url)}.{ext}`，未命中代下载（带 UA/Referer 破防盗链）；
   - **按文件魔数识别真实 content-type**（兼容 AVIF/JPEG 与无扩展名 URL），非 AVIF 原样透传；
   - **v1.0.48+8 起**：真实字节为 AVIF/HEIC 时后端用内置 ffmpeg 转 JPEG 返回（`Content-Type: image/jpeg`）并回写缓存，解决 KOReader/PW3 无 libavif 无法解码问题；转码失败降级返回原字节；
   - 响应头 `Cache-Control: 86400`。
2. **本地 EPUB 内嵌封面**：`path` 传内层路径整体再编码一次：
   `/reader3/localEpubAsset?bookUrl=<enc>&path=<enc>`（需登录解析用户命名空间），
   响应头 `Cache-Control: private, max-age=3600`；内嵌图若为 AVIF/HEIC 同样转 JPEG。

> 错误码：本地资源未登录返回 **400**（`errorMsg=NEED_LOGIN`），**不是 401**；远程封面下载失败返回 404。判断登录态请看响应体 `errorMsg`，不要用 401。

字段取值：前端按 `customCoverUrl || coverUrl`。本地书无封面时由「换源页搜索结果」静默匹配写回 `customCoverUrl`（见第 5 节）。

### 4.3 缓存 / 导出任务（SSE）

`cacheBookSSE` 是 SSE 进度流，事件：
- `message`：进度，`data` 含 `cachedCount / successCount / failedCount`；
- `end`：完成；
- `error`：中断。

前端缓存任务状态为模块级单例，关闭面板后任务仍在后台运行，进度事件继续。

### 4.4 阅读进度

```
GET /reader3/getReadProgress?bookUrl=...   （部分实现经 getShelfBook 返回 durChapterIndex/durChapterTitle）
POST /reader3/saveBookProgress  { bookUrl, chapterUrl, chapterTitle, readProgress }
```

书架书籍对象含 `durChapterIndex` / `durChapterTitle` / `totalChapterNum`，前端据此定位续读章节。

---

## 5. 本地书特别说明（重要易错点）

1. **本地书（origin=`local-txt` / `local-epub`，或 bookUrl 以 `local-txt:` / `local-epub:` 开头）禁止切换书源。**
   `setBookSource` 会改写 `book_url`/`origin`，一旦把本地书改成网络书，服务端就再也读不到本地文件。
   - v218 起：换源页对本地书**禁止执行切换**（点击提示原因），但**搜索/补封面照常工作**——
     换源页搜索结果仍用于「顺手补封面」（`maybeFillCoverFromCandidates`：取严格匹配候选的共识封面写回 `customCoverUrl`）。
   - 第三方前端请同样遵守：本地书**不要调用 `setBookSource`**。
2. 本地书正文/封面读取走本地文件服务（`local_txt_book` / `local_epub_book`），不联网。
3. 本地书封面两种来源：书源匹配得到的远程 URL（走 `cover` 形式一），或 EPUB 内嵌封面（形式二）。

---

## 6. 变更历史（融合历次接口归档）

| 版本 | 接口变动 | 说明 |
|------|----------|------|
| v1.0.48.214 | `getBookContent` 新增 `bookUrl` 参数 | GET+POST 均支持；缓存 key=md5(book_url)；取值优先级 显式 > 反查 > chapterUrl。已归档 chapter.md |
| v1.0.48.213 及之前 | 封面统一接口 `cover` + `localEpubAsset` | 远程/本地内嵌封面收敛到一处；按魔数识别 content-type；已归档 cover.md（2026-11-27） |
| v1.0.48.216 | 无接口变动 | 章节目录缓存 + 认证缓存，纯内部性能优化，请求/响应结构不变 |
| v1.0.48.217 | 无接口变动 | 章节列表进程内缓存 + 正文格式化缓存 + 图片懒加载，纯前端/内部 |
| v1.0.48.218 | 无接口变动 | 本地书禁止切换书源（前端拦截）、书架排序同步、暗色白边、缓存页返回栈调整；**后端代码零改动，后端版本保持 1.0.48+7** |
| v1.0.48+8（前端 v1.0.48.219） | `GET /reader3/cover` 响应内容变动 | AVIF/HEIC 封面由后端用内置 ffmpeg 转 JPEG 返回（`Content-Type: image/jpeg`），解决 KOReader/PW3 无 libavif 无法解码问题；请求结构不变，仅响应类型对 AVIF/HEIC 变化。**后端版本升至 1.0.48+8**；已归档 cover.md |

> 归档规则（长期）：**只要后端接口有任何变动，必须同步更新 `docs/api/` 对应文档**，
> 并在本表追加一行。另：**每次修改后端代码必须提升后端版本号**（`Cargo.toml` 的 `1.0.48+N` 加 1）并重编双架构二进制。

---

## 7. 对接检查清单

- [ ] 统一按 `{success, data, errorMsg}` 解析响应，先判 `success`。
- [ ] 登录后业务接口带 `Authorization: Bearer <token>`；资源类请求（封面/图片/SSE）鉴权走 query。
- [ ] 获取正文时传 `bookUrl`（若已知），避免缓存未命中。
- [ ] 封面用 `cover` 统一接口，按 `customCoverUrl || coverUrl` 取值，`<img>` 无法带 Header 时拼 query。
- [ ] 书架顺序调整后调 `saveBooks` 全量写回；打开书籍后置顶同样走 `saveBooks`。
- [ ] 本地书**不调用 `setBookSource`**；换源页仅用其搜索结果补封面。
- [ ] SSE 类接口用 EventSource / 流式读取，处理 `message` / `end` / `error`。
- [ ] 视频/AI 代理等长任务接口做好取消与进度轮询。

---

## 8. 相关文档

| 文档 | 主题 |
|------|------|
| [index](./index) | 概述 |
| [book-source](./book-source) | 书源管理细则 |
| [search](./search) | 搜索/详情/目录细则 |
| [chapter](./chapter) | 章节正文/缓存/进度细则 |
| [cover](./cover) | 封面与本地资源细则 |
| [user](./user) | 用户管理细则 |
| [rss](./rss) | RSS 细则 |
