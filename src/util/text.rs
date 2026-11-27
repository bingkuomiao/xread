use once_cell::sync::Lazy;
use regex::Regex;

// ────────────────────────────────────────────────────────────────────────────
// 书籍展示文本清洗：与前端 cleanText.ts 的 cleanHtmlText / sanitizeBook 对齐。
// 目的：后端写入/读取时即把书源混入的 HTML 标签、实体、\uXXXX 转义清洗成纯文本，
// 让所有前端（不只本前端）拿到一致的干净数据。清洗幂等，前端再清一次无副作用。
// 只作用于展示字段，不碰 URL/标识字段。
// ────────────────────────────────────────────────────────────────────────────

/// 需要清洗的书籍展示字段（与前端 BOOK_TEXT_FIELDS 一致）。
pub const BOOK_TEXT_FIELDS: &[&str] = &[
    "name",
    "author",
    "intro",
    "kind",
    "originName",
    "originGroup",
    "lastChapter",
    "durChapterTitle",
    "latestChapterTitle",
    "wordCount",
    "updateTime",
    "rssPubDate",
    "rssLink",
];

/// 章节类字段：遇到章节列表 JSON 时提取最后一章章名。
const CHAPTER_LIST_FIELDS: &[&str] = &["lastChapter", "latestChapterTitle", "durChapterTitle"];

static RE_UNICODE_ESCAPE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\\u([0-9a-fA-F]{4})").unwrap());
static RE_CR_ESCAPE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\\r\\n|\\n|\\r").unwrap());
static RE_TAB_ESCAPE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\\t").unwrap());
static RE_BR: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)<br\s*/?>").unwrap());
static RE_BLOCK_CLOSE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)</(?:p|div|li|h[1-6]|tr|section|article|ul|ol|table|blockquote)\s*>")
        .unwrap()
});
static RE_BLOCK_OPEN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)<(?:p|div|li|h[1-6]|tr|section|article|ul|ol|table|blockquote)(?:\s[^>]*)?>")
        .unwrap()
});
static RE_ANY_TAG: Lazy<Regex> = Lazy::new(|| Regex::new(r"<[^>]*>").unwrap());
static RE_BROKEN_ATTR: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"[a-zA-Z-]+\s*=\s*["'][^"']*["']\s*>"#).unwrap()
});
static RE_ENTITY: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"&(nbsp|amp|lt|gt|quot|apos|mdash|ndash|hellip|middot|ldquo|rdquo|#x[0-9a-fA-F]+|#[0-9]+);").unwrap());
static RE_MULTI_SPACE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[ \t\u{00a0}]{2,}").unwrap());
static RE_SPACE_AROUND_NL: Lazy<Regex> = Lazy::new(|| Regex::new(r" *\n *").unwrap());
static RE_MULTI_NL: Lazy<Regex> = Lazy::new(|| Regex::new(r"\n{3,}").unwrap());

/// 解码常见 HTML 实体 + 数字实体（与前端 ENTITY_MAP + decodeEntities 对齐）。
fn decode_entities(text: &str) -> String {
    RE_ENTITY
        .replace_all(text, |caps: &regex::Captures| {
            let token = &caps[1];
            match token {
                "nbsp" => " ".to_string(),
                "amp" => "&".to_string(),
                "lt" => "<".to_string(),
                "gt" => ">".to_string(),
                "quot" => "\"".to_string(),
                "apos" | "#39" => "'".to_string(),
                "mdash" => "—".to_string(),
                "ndash" => "–".to_string(),
                "hellip" => "…".to_string(),
                "middot" => "·".to_string(),
                "ldquo" => "“".to_string(),
                "rdquo" => "”".to_string(),
                _ if token.starts_with("#x") || token.starts_with("#X") => {
                    u32::from_str_radix(&token[2..], 16)
                        .ok()
                        .and_then(char::from_u32)
                        .map(|c| c.to_string())
                        .unwrap_or_else(|| caps[0].to_string())
                }
                _ if token.starts_with('#') => token[1..]
                    .parse::<u32>()
                    .ok()
                    .and_then(char::from_u32)
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| caps[0].to_string()),
                _ => caps[0].to_string(),
            }
        })
        .into_owned()
}

/// 还原字面量转义序列（\r\n / \n / \r / \t / \uXXXX）。
fn decode_literal_escapes(text: &str) -> String {
    let s = RE_CR_ESCAPE.replace_all(text, "\n");
    let s = RE_TAB_ESCAPE.replace_all(&s, " ");
    RE_UNICODE_ESCAPE
        .replace_all(&s, |caps: &regex::Captures| {
            u32::from_str_radix(&caps[1], 16)
                .ok()
                .and_then(char::from_u32)
                .map(|c| c.to_string())
                .unwrap_or_else(|| caps[0].to_string())
        })
        .into_owned()
}

/**
 * 拦截统一接口书源塞进展示字段的章节列表 JSON。
 * - 章节类字段 → 提取最后一个可读章名；
 * - 其他字段 → 机器数据隐藏（返回空串）；
 * - 非 JSON 文本 → 返回 None，走常规清洗。
 */
fn extract_from_json_payload(raw: &str, field: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || (!trimmed.starts_with('{') && !trimmed.starts_with('[')) {
        return None;
    }
    let has_marker = trimmed.contains("\"chapter_list\"");
    let data: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => return if has_marker { Some(String::new()) } else { None },
    };

    fn collect_names(node: &serde_json::Value, names: &mut Vec<String>, depth: usize) {
        if depth > 4 || names.len() > 5000 {
            return;
        }
        match node {
            serde_json::Value::Array(arr) => {
                for item in arr {
                    collect_names(item, names, depth + 1);
                }
            }
            serde_json::Value::Object(map) => {
                for key in ["name", "title", "chapterName", "chapter_name"] {
                    if let Some(serde_json::Value::String(v)) = map.get(key) {
                        if !v.trim().is_empty() {
                            names.push(v.trim().to_string());
                            return;
                        }
                    }
                }
                for v in map.values() {
                    collect_names(v, names, depth + 1);
                }
            }
            _ => {}
        }
    }

    let mut names = Vec::new();
    collect_names(&data, &mut names, 0);
    if !names.is_empty() {
        if CHAPTER_LIST_FIELDS.contains(&field) {
            let last = names.last().cloned().unwrap_or_default();
            return Some(decode_literal_escapes(&last));
        }
        return Some(String::new());
    }
    if has_marker {
        return Some(String::new());
    }
    // 退路：顶层若有可读 name 则取之，否则空串（机器数据不展示）
    if let serde_json::Value::Object(map) = &data {
        for key in ["name", "title", "chapterName", "chapter_name"] {
            if let Some(serde_json::Value::String(v)) = map.get(key) {
                if !v.trim().is_empty() {
                    return Some(decode_literal_escapes(v.trim()));
                }
            }
        }
    }
    Some(String::new())
}

/**
 * 把可能含 HTML 的展示字段清洗为纯文本（对齐前端 cleanHtmlText）。
 * lineBreaks=true 时块级标签转换行（用于 intro），否则转空格。
 */
pub fn clean_display_text(value: &str, field: &str, line_breaks: bool) -> String {
    if value.is_empty() {
        return String::new();
    }
    if let Some(json_text) = extract_from_json_payload(value, field) {
        return if json_text.is_empty() {
            String::new()
        } else {
            clean_display_text(&json_text, field, line_breaks)
        };
    }

    let sep = if line_breaks { "\n" } else { " " };
    let mut text = decode_literal_escapes(value);
    text = RE_BR.replace_all(&text, sep).into_owned();
    text = RE_BLOCK_CLOSE.replace_all(&text, sep).into_owned();
    text = RE_BLOCK_OPEN.replace_all(&text, "").into_owned();
    text = RE_ANY_TAG.replace_all(&text, "").into_owned();
    text = RE_BROKEN_ATTR.replace_all(&text, " ").into_owned();
    text = decode_entities(&text);

    let text = RE_MULTI_SPACE.replace_all(&text, " ");
    let text = RE_SPACE_AROUND_NL.replace_all(&text, "\n");
    let text = RE_MULTI_NL.replace_all(&text, "\n\n");
    text.trim().to_string()
}

pub fn strip_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn apply_regex_replace(input: &str, pattern: &str, replace: &str) -> String {
    if let Ok(re) = Regex::new(pattern) {
        re.replace_all(input, replace).to_string()
    } else {
        input.to_string()
    }
}

pub fn normalize_source_url(input: &str) -> String {
    input
        .chars()
        .filter(|ch| !ch.is_control() || matches!(ch, '\n' | '\r' | '\t'))
        .collect::<String>()
        .trim()
        .to_string()
}

pub fn repair_encoded_url(input: &str) -> String {
    let normalized = normalize_source_url(input);
    if !(normalized.contains("%3F")
        || normalized.contains("%3f")
        || normalized.contains("%26")
        || normalized.contains("%26")
        || normalized.contains("%3D")
        || normalized.contains("%3d"))
    {
        return normalized;
    }

    normalized
        .replace("%3F", "?")
        .replace("%3f", "?")
        .replace("%26", "&")
        .replace("%3D", "=")
        .replace("%3d", "=")
        .replace("%23", "#")
        .replace("%23", "#")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_display_text_strips_html_and_entities() {
        // 书源常见的「作者+字数+时间」混 HTML 与实体
        let raw = "<p><i class=\"fa fa-user\">&nbsp;佚名&nbsp;&nbsp;</i>460 万字</p>";
        assert_eq!(clean_display_text(raw, "author", false), "佚名 460 万字");
    }

    #[test]
    fn clean_display_text_decodes_unicode_and_numeric_entities() {
        assert_eq!(clean_display_text("\\u4f60\\u597d", "name", false), "你好");
        assert_eq!(clean_display_text("A&#39;B&amp;C", "name", false), "A'B&C");
        assert_eq!(clean_display_text("中&#x6587;", "name", false), "中文");
    }

    #[test]
    fn clean_display_text_is_idempotent() {
        // 清洗必须幂等：前端再清洗一次不能产生变化
        let raw = "<div>  Hello   <b>World</b> &amp; friends  </div>";
        let once = clean_display_text(raw, "intro", false);
        let twice = clean_display_text(&once, "intro", false);
        assert_eq!(once, twice);
    }

    #[test]
    fn clean_display_text_intro_keeps_line_breaks() {
        let raw = "<p>第一段</p><p>第二段</p>";
        assert_eq!(clean_display_text(raw, "intro", true), "第一段\n第二段");
    }

    #[test]
    fn clean_display_text_extracts_last_chapter_from_json() {
        let raw = r#"{"chapter_list":[{"name":"第1章"},{"name":"第2章"},{"name":"第3章"}]}"#;
        let out = clean_display_text(raw, "latestChapterTitle", false);
        assert_eq!(out, "第3章");
        // 非章节字段的机器数据应隐藏
        assert_eq!(clean_display_text(raw, "intro", false), "");
    }
}
