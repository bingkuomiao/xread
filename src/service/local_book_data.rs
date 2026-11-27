use crate::error::error::AppError;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use tokio::fs;

/// 单个本地书文件（内容为 base64 编码的原始字节）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBookFile {
    /// 相对书目录的路径，统一用 '/' 分隔，例如 "《书名》.txt"、"chapters.json"、"assets/cover.jpg"
    pub path: String,
    /// 原始文件字节的 base64 编码
    pub content: String,
}

/// 一本书的完整正文备份：bookUrl 保持不变，恢复时按其中的 hash 原样写回。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBookBackup {
    pub book_url: String,
    pub files: Vec<LocalBookFile>,
}

/// 单文件解码后上限（略大于 epub 上传上限 80MB）。
const MAX_FILE_BYTES: usize = 120 * 1024 * 1024;
/// 单本书文件数量上限（与 epub 解包上限一致）。
const MAX_FILES_PER_BOOK: usize = 3000;
/// 单次备份/恢复的总字节上限，避免异常数据撑爆内存。
const MAX_TOTAL_BYTES: usize = 600 * 1024 * 1024;

#[derive(Clone)]
pub struct LocalBookDataService {
    storage_dir: PathBuf,
}

impl LocalBookDataService {
    pub fn new(storage_dir: impl AsRef<Path>) -> Self {
        Self {
            storage_dir: storage_dir.as_ref().to_path_buf(),
        }
    }

    fn local_root(&self, user_ns: &str) -> PathBuf {
        self.storage_dir
            .join("data")
            .join(user_ns)
            .join("local_books")
    }

    /// 从 bookUrl 提取 32 位十六进制 hash，严格校验前缀，防止路径穿越。
    fn hash_from_url(book_url: &str) -> Result<&str, AppError> {
        let value = book_url
            .strip_prefix("local-txt:")
            .or_else(|| book_url.strip_prefix("local-epub:"))
            .filter(|v| v.len() == 32 && v.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or_else(|| AppError::BadRequest("本地书地址无效".to_string()))?;
        Ok(value)
    }

    fn book_dir(&self, user_ns: &str, book_url: &str) -> Result<PathBuf, AppError> {
        let hash = Self::hash_from_url(book_url)?;
        Ok(self.local_root(user_ns).join(hash))
    }

    /// 导出若干本地书的全部文件。非本地书 / 目录不存在的书直接跳过（返回空 files）。
    pub async fn export_books(
        &self,
        user_ns: &str,
        book_urls: &[String],
    ) -> Result<Vec<LocalBookBackup>, AppError> {
        let mut result = Vec::with_capacity(book_urls.len());
        for book_url in book_urls {
            let dir = match self.book_dir(user_ns, book_url) {
                Ok(d) => d,
                Err(_) => continue, // 非本地书：跳过
            };
            let mut files = Vec::new();
            if dir.exists() {
                let mut stack = vec![dir.clone()];
                let mut total = 0usize;
                while let Some(current) = stack.pop() {
                    let mut entries = fs::read_dir(&current)
                        .await
                        .map_err(|e| AppError::Internal(e.into()))?;
                    let mut children = Vec::new();
                    while let Some(entry) = entries
                        .next_entry()
                        .await
                        .map_err(|e| AppError::Internal(e.into()))?
                    {
                        children.push(entry.path());
                    }
                    // 稳定顺序：目录在前无所谓，最后统一排序
                    for path in children {
                        let ty = fs::metadata(&path)
                            .await
                            .map_err(|e| AppError::Internal(e.into()))?;
                        if ty.is_dir() {
                            stack.push(path);
                        } else if ty.is_file() {
                            let rel = path
                                .strip_prefix(&dir)
                                .unwrap_or(&path)
                                .to_string_lossy()
                                .replace('\\', "/");
                            let bytes = fs::read(&path)
                                .await
                                .map_err(|e| AppError::Internal(e.into()))?;
                            total = total.saturating_add(bytes.len());
                            if total > MAX_TOTAL_BYTES || bytes.len() > MAX_FILE_BYTES {
                                continue; // 超大文件跳过，避免备份异常膨胀
                            }
                            files.push(LocalBookFile {
                                path: rel,
                                content: STANDARD.encode(&bytes),
                            });
                            if files.len() >= MAX_FILES_PER_BOOK {
                                break;
                            }
                        }
                    }
                }
            }
            files.sort_by(|a, b| a.path.cmp(&b.path));
            result.push(LocalBookBackup {
                book_url: book_url.clone(),
                files,
            });
        }
        Ok(result)
    }

    /// 按原 bookUrl 写回本地书文件（hash 不变 → 打开书签/进度天然对得上）。
    /// 非法 bookUrl 或非法相对路径的文件会被跳过，单本失败不影响其余书。
    pub async fn import_books(&self, user_ns: &str, books: &[LocalBookBackup]) -> Result<usize, AppError> {
        let mut imported = 0usize;
        for book in books {
            let dir = match self.book_dir(user_ns, &book.book_url) {
                Ok(d) => d,
                Err(_) => continue,
            };
            let mut wrote_any = false;
            let mut total = 0usize;
            for file in &book.files {
                let rel = match safe_relative_path(&file.path) {
                    Some(p) => p,
                    None => continue,
                };
                let bytes = match STANDARD.decode(file.content.as_bytes()) {
                    Ok(b) => b,
                    Err(_) => continue,
                };
                if bytes.len() > MAX_FILE_BYTES {
                    continue;
                }
                total = total.saturating_add(bytes.len());
                if total > MAX_TOTAL_BYTES {
                    break;
                }
                let target = dir.join(rel);
                if let Some(parent) = target.parent() {
                    if fs::create_dir_all(parent).await.is_err() {
                        continue;
                    }
                }
                if fs::write(&target, &bytes).await.is_ok() {
                    wrote_any = true;
                }
            }
            if wrote_any {
                imported += 1;
            }
        }
        Ok(imported)
    }
}

use base64::engine::general_purpose::STANDARD;

/// 校验相对路径：仅允许普通路径段，拒绝绝对路径、父目录回退、盘符前缀。
fn safe_relative_path(path: &str) -> Option<PathBuf> {
    let p = Path::new(path);
    if p.is_absolute() || path.contains('\0') {
        return None;
    }
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::Normal(seg) => out.push(seg),
            Component::CurDir => {}
            _ => return None, // ParentDir / RootDir / Prefix 一律拒绝
        }
    }
    if out.as_os_str().is_empty() {
        return None;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_from_url_validates_prefix_and_length() {
        assert!(LocalBookDataService::hash_from_url(
            "local-txt:0123456789abcdef0123456789abcdef"
        )
        .is_ok());
        assert!(LocalBookDataService::hash_from_url(
            "local-epub:0123456789ABCDEF0123456789ABCDEF"
        )
        .is_ok());
        assert!(LocalBookDataService::hash_from_url("https://evil.com/book").is_err());
        assert!(LocalBookDataService::hash_from_url("local-txt:abc").is_err());
        assert!(LocalBookDataService::hash_from_url(
            "local-txt:0123456789abcdef0123456789abcdeg"
        )
        .is_err());
    }

    #[test]
    fn safe_relative_path_blocks_traversal() {
        assert!(safe_relative_path("《书名》.txt").is_some());
        assert!(safe_relative_path("chapters/0.json").is_some());
        assert!(safe_relative_path("./a.txt").is_some());
        assert!(safe_relative_path("../etc/passwd").is_none());
        assert!(safe_relative_path("/etc/passwd").is_none());
        assert!(safe_relative_path("a/../../b").is_none());
        assert!(safe_relative_path("").is_none());
    }

    #[tokio::test]
    async fn export_then_import_roundtrip_keeps_content() {
        let root = std::env::temp_dir().join(format!("xread-local-data-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root).await;
        let svc = LocalBookDataService::new(&root);
        let url = "local-txt:0123456789abcdef0123456789abcdef";
        let dir = svc.book_dir("u1", url).unwrap();
        fs::create_dir_all(dir.join("chapters")).await.unwrap();
        fs::write(dir.join("《书名》.txt"), "hello 正文").await.unwrap();
        fs::write(dir.join("chapters.json"), "[]").await.unwrap();
        fs::write(dir.join("chapters/0.json"), "{}").await.unwrap();

        let exported = svc.export_books("u1", &[url.to_string()]).await.unwrap();
        assert_eq!(exported.len(), 1);
        assert_eq!(exported[0].book_url, url);
        assert_eq!(exported[0].files.len(), 3);

        // 删除后恢复
        fs::remove_dir_all(&dir).await.unwrap();
        let n = svc.import_books("u1", &exported).await.unwrap();
        assert_eq!(n, 1);
        let text = fs::read_to_string(dir.join("《书名》.txt")).await.unwrap();
        assert_eq!(text, "hello 正文");
        assert!(dir.join("chapters/0.json").exists());

        let _ = fs::remove_dir_all(&root).await;
    }

    #[tokio::test]
    async fn import_skips_illegal_url_and_path() {
        let root = std::env::temp_dir().join(format!("xread-local-data-bad-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root).await;
        let svc = LocalBookDataService::new(&root);
        let bad = LocalBookBackup {
            book_url: "https://evil.com/x".to_string(),
            files: vec![LocalBookFile {
                path: "../evil.txt".to_string(),
                content: STANDARD.encode("x"),
            }],
        };
        let n = svc.import_books("u1", &[bad]).await.unwrap();
        assert_eq!(n, 0);
        let _ = fs::remove_dir_all(&root).await;
    }
}
