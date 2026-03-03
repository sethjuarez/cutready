//! Fetch a URL and extract clean text content from HTML.

use scraper::{Html, Selector};

/// Fetch a URL and return cleaned text content.
pub async fn fetch_and_clean(url: &str) -> Result<String, String> {
    let resp = reqwest::get(url)
        .await
        .map_err(|e| format!("Failed to fetch URL: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status} for {url}"));
    }

    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();

    let body = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read response body: {e}"))?;

    // If it's not HTML, return the raw text (could be JSON, plain text, etc.)
    if !content_type.contains("html") {
        return Ok(truncate(&body, 12_000));
    }

    Ok(truncate(&html_to_text(&body), 12_000))
}

/// Convert HTML to clean readable text, stripping scripts/styles/nav.
fn html_to_text(html: &str) -> String {
    let doc = Html::parse_document(html);

    // Try to find main content areas first
    let main_selectors = ["main", "article", "[role=main]", "#content", ".content"];
    for sel_str in main_selectors {
        if let Ok(sel) = Selector::parse(sel_str) {
            let nodes: Vec<_> = doc.select(&sel).collect();
            if !nodes.is_empty() {
                let text: String = nodes
                    .iter()
                    .map(|n| extract_text(n))
                    .collect::<Vec<_>>()
                    .join("\n\n");
                let cleaned = collapse_whitespace(&text);
                if cleaned.len() > 100 {
                    return cleaned;
                }
            }
        }
    }

    // Fallback: extract from body, skipping script/style/nav/header/footer
    if let Ok(body_sel) = Selector::parse("body") {
        if let Some(body) = doc.select(&body_sel).next() {
            return collapse_whitespace(&extract_text(&body));
        }
    }

    // Last resort: all text
    collapse_whitespace(&doc.root_element().text().collect::<String>())
}

/// Recursively extract text from an element, skipping noise elements.
fn extract_text(el: &scraper::ElementRef) -> String {
    let skip_tags = ["script", "style", "nav", "header", "footer", "noscript", "svg", "iframe"];

    let mut parts = Vec::new();
    for child in el.children() {
        match child.value() {
            scraper::node::Node::Text(t) => {
                let s = t.text.trim();
                if !s.is_empty() {
                    parts.push(s.to_string());
                }
            }
            scraper::node::Node::Element(e) => {
                let tag = e.name.local.as_ref();
                if skip_tags.contains(&tag) {
                    continue;
                }
                if let Some(child_el) = scraper::ElementRef::wrap(child) {
                    let child_text = extract_text(&child_el);
                    if !child_text.is_empty() {
                        // Add line breaks for block elements
                        let block_tags = [
                            "p", "div", "h1", "h2", "h3", "h4", "h5", "h6",
                            "li", "tr", "br", "blockquote", "pre", "section",
                        ];
                        if block_tags.contains(&tag) {
                            parts.push(format!("\n{child_text}\n"));
                        } else {
                            parts.push(child_text);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    parts.join(" ")
}

/// Collapse consecutive whitespace/newlines into clean text.
fn collapse_whitespace(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut prev_newline = false;
    for line in s.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if !prev_newline {
                result.push('\n');
                prev_newline = true;
            }
        } else {
            result.push_str(trimmed);
            result.push('\n');
            prev_newline = false;
        }
    }
    result.trim().to_string()
}

/// Truncate text to a maximum character length with an indicator.
fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…\n\n[Truncated at {} chars]", &s[..max], max)
    }
}
