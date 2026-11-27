use crate::api::auth::AuthContext;
use crate::api::AppState;
use crate::error::error::{ApiResponse, AppError};
use crate::service::local_book_data::{LocalBookBackup, LocalBookFile};
use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportLocalBooksRequest {
    pub book_urls: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportLocalBooksRequest {
    pub books: Vec<LocalBookBackup>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportLocalBooksResult {
    pub imported: usize,
}

/// 导出本地书正文（原始文件 + 章节索引，base64 编码），供 WebDAV 备份包含正文。
/// 只处理合法 local-txt/local-epub 地址，其余跳过。
pub async fn export_local_books(
    State(state): State<AppState>,
    auth: AuthContext,
    Json(req): Json<ExportLocalBooksRequest>,
) -> Result<Json<ApiResponse<Value>>, AppError> {
    let user_ns = state
        .user_service
        .resolve_read_user_ns(auth.access_token(), auth.secure_key(), auth.user_ns())
        .await
        .map_err(|_| AppError::BadRequest("NEED_LOGIN".to_string()))?;

    // 限制单次请求书数，防止异常请求
    if req.book_urls.len() > 5000 {
        return Err(AppError::BadRequest("一次导出的本地书过多".to_string()));
    }
    // 提前拦截明显非法的字段，避免把任意用户数据当文件读
    let books = state
        .local_book_data_service
        .export_books(&user_ns, &req.book_urls)
        .await?;
    Ok(Json(ApiResponse::ok(serde_json::to_value(books).unwrap_or_default())))
}

/// 按原 bookUrl 写回本地书正文（hash 不变，恢复后可直接打开）。
pub async fn import_local_books(
    State(state): State<AppState>,
    auth: AuthContext,
    Json(req): Json<ImportLocalBooksRequest>,
) -> Result<Json<ApiResponse<Value>>, AppError> {
    let user_ns = state
        .user_service
        .resolve_write_user_ns(auth.access_token(), auth.secure_key(), auth.user_ns())
        .await
        .map_err(|_| AppError::BadRequest("NEED_LOGIN".to_string()))?;

    if req.books.len() > 5000 {
        return Err(AppError::BadRequest("一次恢复的本地书过多".to_string()));
    }
    // 单本书文件数上限，防止构造超大 payload
    if req
        .books
        .iter()
        .any(|b| b.files.len() > 3000)
    {
        return Err(AppError::BadRequest("单本本地书文件过多".to_string()));
    }
    let imported = state
        .local_book_data_service
        .import_books(&user_ns, &req.books)
        .await?;
    Ok(Json(ApiResponse::ok(
        serde_json::to_value(ImportLocalBooksResult { imported }).unwrap_or_default(),
    )))
}

// 显式引用，避免未使用告警（类型用于 serde 派生校验）
#[allow(dead_code)]
fn _assert_types(_: Option<LocalBookFile>, _: Option<LocalBookBackup>) {}
