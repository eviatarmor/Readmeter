//! Readable callsite label derived from a raw source location.
//!
//! The keyed hash stays the grouping key. The label is what the console
//! shows: the path and line, without a URL origin or query string.

/// Longest stored label, in UTF-8 bytes.
const MAX_BYTES: usize = 200;

/// Path and position from `raw`, or `None` when nothing remains.
///
/// Drops the query string, then a `scheme://authority` prefix when the
/// scheme is non-empty and made of ASCII alphanumerics, `+`, `-` or `.`.
/// Trims leading slashes, strips one leading `./`, removes control
/// characters and truncates to [`MAX_BYTES`] on a char boundary.
pub fn callsite_label(raw: &str) -> Option<String> {
    let no_query = match raw.split_once('?') {
        Some((path, _)) => path,
        None => raw,
    };
    let without_origin = strip_origin(no_query);
    let trimmed = without_origin.trim_start_matches('/');
    let path = match trimmed.strip_prefix("./") {
        Some(rest) => rest,
        None => trimmed,
    };
    let mut out = String::new();
    for c in path.chars() {
        if c.is_control() {
            continue;
        }
        if out.len() + c.len_utf8() > MAX_BYTES {
            break;
        }
        out.push(c);
    }
    if out.is_empty() { None } else { Some(out) }
}

/// `scheme://authority/rest` becomes `rest`. Anything else is unchanged.
fn strip_origin(raw: &str) -> &str {
    let Some((scheme, rest)) = raw.split_once("://") else {
        return raw;
    };
    if scheme.is_empty()
        || !scheme
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'))
    {
        return raw;
    }
    match rest.find('/') {
        Some(i) => &rest[i + 1..],
        None => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_origin_query_and_controls() {
        assert_eq!(
            callsite_label("https://app.example.com/assets/index-abc.js:1:2345?v=1").as_deref(),
            Some("assets/index-abc.js:1:2345")
        );
        assert_eq!(
            callsite_label("webpack-internal:///./src/Feed.tsx:42:7").as_deref(),
            Some("src/Feed.tsx:42:7")
        );
        let labeled =
            callsite_label("https://user:secret@app.example.com/src/App.tsx:1:1?token=secret\n")
                .unwrap();
        assert!(!labeled.contains("secret"));
        assert!(!labeled.contains("example.com"));
        assert!(!labeled.contains('?'));
        assert!(!labeled.contains("https://"));
        assert!(!labeled.contains('\n'));
        assert_eq!(labeled, "src/App.tsx:1:1");
        assert_eq!(callsite_label("http://example.com").as_deref(), None);
        assert_eq!(
            callsite_label("src/Feed.tsx:42:7").as_deref(),
            Some("src/Feed.tsx:42:7")
        );
    }

    #[test]
    fn truncates_on_a_char_boundary() {
        let long = "a".repeat(250);
        let truncated = callsite_label(&long).unwrap();
        assert_eq!(truncated.len(), 200);
        let meat = "é".repeat(150);
        let cut = callsite_label(&meat).unwrap();
        assert!(cut.len() <= 200);
        assert_eq!(cut.len() % 2, 0);
        assert!(cut.is_char_boundary(cut.len()));
    }
}
