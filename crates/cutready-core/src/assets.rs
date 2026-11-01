//! Project asset references (screenshots and visuals) inside documents:
//! finding them and rewriting them when an asset is renamed. Pure string and
//! model transforms; hosts do the file I/O.

use crate::document::DocumentError;
use crate::models::sketch::Sketch;

pub fn replace_sketch_screenshot_references(
    sketch: &mut Sketch,
    old_rel: &str,
    new_rel: &str,
) -> Result<usize, DocumentError> {
    let mut count = 0;
    for (idx, row) in sketch.rows.iter_mut().enumerate() {
        let Some(screenshot) = row.screenshot.as_ref() else {
            continue;
        };
        if screenshot.replace('\\', "/") != old_rel {
            continue;
        }
        if sketch.locked || row.locked || row.locks.screenshot {
            return Err(DocumentError::Locked(format!(
                "Planning row {} screenshot cell is locked. Unlock it before renaming the screenshot.",
                idx + 1
            )));
        }
        row.screenshot = Some(new_rel.to_owned());
        count += 1;
    }
    Ok(count)
}

pub fn replace_sketch_visual_references(
    sketch: &mut Sketch,
    old_rel: &str,
    new_rel: &str,
) -> Result<usize, DocumentError> {
    let mut count = 0;
    for (idx, row) in sketch.rows.iter_mut().enumerate() {
        let Some(visual) = row.visual.as_ref().and_then(|visual| visual.as_str()) else {
            continue;
        };
        if visual.replace('\\', "/") != old_rel {
            continue;
        }
        if sketch.locked || row.locked || row.locks.visual {
            return Err(DocumentError::Locked(format!(
                "Planning row {} visual cell is locked. Unlock it before renaming the visual.",
                idx + 1
            )));
        }
        row.visual = Some(serde_json::Value::String(new_rel.to_owned()));
        count += 1;
    }
    Ok(count)
}

pub fn rewrite_markdown_screenshot_refs(
    content: &str,
    old_rel: &str,
    new_rel: &str,
) -> (String, usize) {
    let (content, markdown_count) = rewrite_markdown_link_refs(content, old_rel, new_rel);
    let (content, html_count) = rewrite_html_img_src_refs(&content, old_rel, new_rel);
    (content, markdown_count + html_count)
}

fn rewrite_markdown_link_refs(content: &str, old_rel: &str, new_rel: &str) -> (String, usize) {
    let mut output = String::with_capacity(content.len());
    let mut rest = content;
    let mut count = 0;
    while let Some(pos) = rest.find("](") {
        output.push_str(&rest[..pos + 2]);
        let after = &rest[pos + 2..];
        let Some(end) = after.find(')') else {
            output.push_str(after);
            return (output, count);
        };
        let target = &after[..end];
        let (rewritten, changed) = rewrite_markdown_target_token(target, old_rel, new_rel);
        output.push_str(&rewritten);
        output.push(')');
        if changed {
            count += 1;
        }
        rest = &after[end + 1..];
    }
    output.push_str(rest);
    (output, count)
}

fn rewrite_markdown_target_token(target: &str, old_rel: &str, new_rel: &str) -> (String, bool) {
    let leading_len = target.len() - target.trim_start().len();
    let trimmed = &target[leading_len..];
    let path_len = trimmed
        .char_indices()
        .find_map(|(idx, ch)| ch.is_whitespace().then_some(idx))
        .unwrap_or(trimmed.len());
    let path = &trimmed[..path_len];
    if path.replace('\\', "/") != old_rel {
        return (target.to_owned(), false);
    }
    let mut rewritten =
        String::with_capacity(target.len() + new_rel.len().saturating_sub(path.len()));
    rewritten.push_str(&target[..leading_len]);
    rewritten.push_str(new_rel);
    rewritten.push_str(&trimmed[path_len..]);
    (rewritten, true)
}

fn rewrite_html_img_src_refs(content: &str, old_rel: &str, new_rel: &str) -> (String, usize) {
    let mut output = String::with_capacity(content.len());
    let mut rest = content;
    let mut count = 0;
    while let Some(pos) = rest.find("<img ") {
        output.push_str(&rest[..pos]);
        let tag_rest = &rest[pos..];
        let Some(tag_end) = tag_rest.find('>') else {
            output.push_str(tag_rest);
            return (output, count);
        };
        let tag = &tag_rest[..=tag_end];
        let (rewritten, changed) = rewrite_html_img_tag_src(tag, old_rel, new_rel);
        output.push_str(&rewritten);
        if changed {
            count += 1;
        }
        rest = &tag_rest[tag_end + 1..];
    }
    output.push_str(rest);
    (output, count)
}

fn rewrite_html_img_tag_src(tag: &str, old_rel: &str, new_rel: &str) -> (String, bool) {
    for prefix in ["src=\"", "src='"] {
        if let Some(src_start) = tag.find(prefix) {
            let value_start = src_start + prefix.len();
            let quote = prefix.as_bytes()[prefix.len() - 1] as char;
            if let Some(value_end) = tag[value_start..].find(quote) {
                let value_end = value_start + value_end;
                let value = &tag[value_start..value_end];
                if value.replace('\\', "/") == old_rel {
                    let mut rewritten = String::with_capacity(
                        tag.len() + new_rel.len().saturating_sub(value.len()),
                    );
                    rewritten.push_str(&tag[..value_start]);
                    rewritten.push_str(new_rel);
                    rewritten.push_str(&tag[value_end..]);
                    return (rewritten, true);
                }
            }
            break;
        }
    }
    (tag.to_owned(), false)
}

/// Extract `.cutready/screenshots/...` image paths from markdown content.
/// Matches both markdown `![...](path)` and HTML `<img src="path">` syntax.
pub fn extract_screenshot_refs(content: &str) -> Vec<String> {
    let mut refs = Vec::new();

    // Match markdown image/link syntax: [...](.cutready/screenshots/...)
    let mut rest = content;
    while let Some(pos) = rest.find("](") {
        let after = &rest[pos + 2..];
        if let Some(end) = after.find(')') {
            let img_path = after[..end].trim();
            if img_path.contains(".cutready/screenshots/") {
                refs.push(img_path.replace('\\', "/"));
            }
        }
        rest = &rest[pos + 2..];
    }

    // Match HTML img tags: <img ... src="path" ...>
    rest = content;
    while let Some(pos) = rest.find("<img ") {
        let tag_rest = &rest[pos..];
        if let Some(tag_end) = tag_rest.find('>') {
            let tag = &tag_rest[..tag_end];
            // Extract src attribute value (single or double quotes)
            for prefix in &["src=\"", "src='"] {
                if let Some(src_start) = tag.find(prefix) {
                    let val_start = src_start + prefix.len();
                    let quote = prefix.as_bytes()[prefix.len() - 1] as char;
                    if let Some(val_end) = tag[val_start..].find(quote) {
                        let src = tag[val_start..val_start + val_end].trim();
                        if src.contains(".cutready/screenshots/") {
                            refs.push(src.replace('\\', "/"));
                        }
                    }
                    break;
                }
            }
        }
        rest = &rest[pos + 5..];
    }

    refs
}

/// Extract `.cutready/screenshots/...` image paths from sketch JSON content.
///
/// Parses the `"screenshot"` field from each planning row in the sketch.
pub fn extract_sketch_screenshot_refs(content: &str) -> Vec<String> {
    let mut refs = Vec::new();
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(content) {
        if let Some(rows) = val.get("rows").and_then(|r| r.as_array()) {
            for row in rows {
                if let Some(ss) = row.get("screenshot").and_then(|s| s.as_str()) {
                    let ss = ss.replace('\\', "/");
                    if ss.contains(".cutready/screenshots/") {
                        refs.push(ss);
                    }
                }
            }
        }
    }
    refs
}

/// Extract `.cutready/visuals/...` visual paths from sketch JSON content.
///
/// Parses the `"visual"` field from each planning row in the sketch.
pub fn extract_sketch_visual_refs(content: &str) -> Vec<String> {
    let mut refs = Vec::new();
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(content) {
        if let Some(rows) = val.get("rows").and_then(|r| r.as_array()) {
            for row in rows {
                if let Some(vis) = row.get("visual").and_then(|v| v.as_str()) {
                    let vis = vis.replace('\\', "/");
                    if vis.contains(".cutready/visuals/") {
                        refs.push(vis);
                    }
                }
            }
        }
    }
    refs
}

/// Collect all `.cutready/` asset paths referenced by a file's content.
/// - `.sk` files: screenshot fields + visual fields from planning rows
/// - `.md` files: screenshot paths from markdown/HTML image syntax
/// - `.sb` files: no direct asset references
pub fn collect_asset_refs(content: &str, file_ext: &str) -> Vec<String> {
    match file_ext {
        "sk" => {
            let mut refs = extract_sketch_screenshot_refs(content);
            refs.extend(extract_sketch_visual_refs(content));
            refs
        }
        "md" => extract_screenshot_refs(content),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_refs_finds_screenshot_paths() {
        let md = "Some text\n![screenshot](.cutready/screenshots/pasted-123.png)\nMore text";
        let refs = extract_screenshot_refs(md);
        assert_eq!(refs, vec![".cutready/screenshots/pasted-123.png"]);
    }

    #[test]
    fn extract_refs_finds_multiple() {
        let md = "![a](.cutready/screenshots/a.png) and ![b](.cutready/screenshots/b.jpg)";
        let refs = extract_screenshot_refs(md);
        assert_eq!(refs.len(), 2);
    }

    #[test]
    fn extract_refs_ignores_non_screenshot_images() {
        let md = "![logo](assets/logo.png)";
        let refs = extract_screenshot_refs(md);
        assert!(refs.is_empty());
    }

    #[test]
    fn extract_refs_empty_content() {
        assert!(extract_screenshot_refs("").is_empty());
        assert!(extract_screenshot_refs("no images here").is_empty());
    }

    #[test]
    fn extract_refs_finds_html_img_tags() {
        let content = r#"Some text
<img src=".cutready/screenshots/pasted-500.png" alt="test" />
More text"#;
        let refs = extract_screenshot_refs(content);
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0], ".cutready/screenshots/pasted-500.png");
    }

    #[test]
    fn extract_refs_finds_both_markdown_and_html() {
        let content = r#"# Doc
![pic](.cutready/screenshots/pasted-001.png)
Some text
<img src=".cutready/screenshots/pasted-002.png" />
"#;
        let refs = extract_screenshot_refs(content);
        assert_eq!(refs.len(), 2);
        assert!(refs.iter().any(|r| r.contains("pasted-001")));
        assert!(refs.iter().any(|r| r.contains("pasted-002")));
    }

    #[test]
    fn extract_sketch_refs_finds_screenshot_paths() {
        let sk = r#"{"title":"Demo","rows":[{"time":"~30s","narrative":"intro","demo_actions":"click","screenshot":".cutready/screenshots/step1.png"}]}"#;
        let refs = extract_sketch_screenshot_refs(sk);
        assert_eq!(refs, vec![".cutready/screenshots/step1.png"]);
    }

    #[test]
    fn extract_sketch_refs_skips_null_screenshots() {
        let sk = r#"{"title":"Demo","rows":[{"time":"~30s","narrative":"intro","demo_actions":"click","screenshot":null}]}"#;
        let refs = extract_sketch_screenshot_refs(sk);
        assert!(refs.is_empty());
    }

    #[test]
    fn extract_sketch_refs_multiple_rows() {
        let sk = r#"{"title":"Demo","rows":[
            {"time":"~10s","narrative":"a","demo_actions":"a","screenshot":".cutready/screenshots/a.png"},
            {"time":"~10s","narrative":"b","demo_actions":"b","screenshot":null},
            {"time":"~10s","narrative":"c","demo_actions":"c","screenshot":".cutready/screenshots/c.png"}
        ]}"#;
        let refs = extract_sketch_screenshot_refs(sk);
        assert_eq!(refs.len(), 2);
        assert!(refs.iter().any(|r| r.contains("a.png")));
        assert!(refs.iter().any(|r| r.contains("c.png")));
    }
}
