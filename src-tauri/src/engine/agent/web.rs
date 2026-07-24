//! CutReady-owned web fetching used by both execution engines.

use scraper::{Html, Selector};

const DEFAULT_MAX_CHARS: usize = 15_000;

pub async fn fetch_and_clean(url: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| format!("Failed to build HTTP client: {error}"))?;
    let response = client
        .get(url)
        .header("User-Agent", "CutReady/1 (Rust)")
        .send()
        .await
        .map_err(|error| format!("Failed to fetch URL: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP {status} for {url}"));
    }
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let body = response
        .text()
        .await
        .map_err(|error| format!("Failed to read response body: {error}"))?;
    let content = if content_type.contains("html") {
        html_to_text(&body)
    } else {
        body
    };
    Ok(truncate(&content, DEFAULT_MAX_CHARS))
}

fn html_to_text(html: &str) -> String {
    let document = Html::parse_document(html);
    for selector in ["main", "article", "[role=main]", "#content", ".content"] {
        let Ok(selector) = Selector::parse(selector) else {
            continue;
        };
        let text = document
            .select(&selector)
            .map(|element| extract_text(&element, false))
            .collect::<Vec<_>>()
            .join("\n\n");
        let cleaned = collapse_whitespace(&text);
        if cleaned.len() > 100 {
            return cleaned;
        }
    }
    Selector::parse("body")
        .ok()
        .and_then(|selector| document.select(&selector).next())
        .map(|body| collapse_whitespace(&extract_text(&body, false)))
        .unwrap_or_else(|| collapse_whitespace(&document.root_element().text().collect::<String>()))
}

fn extract_text(element: &scraper::ElementRef<'_>, inside_link: bool) -> String {
    const SKIP_TAGS: &[&str] = &[
        "script", "style", "nav", "header", "footer", "noscript", "svg", "iframe",
    ];
    const BLOCK_TAGS: &[&str] = &[
        "p",
        "div",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "li",
        "tr",
        "br",
        "blockquote",
        "pre",
        "section",
    ];
    let mut parts = Vec::new();
    for child in element.children() {
        match child.value() {
            scraper::node::Node::Text(text) => {
                let text = text.text.trim();
                if !text.is_empty() {
                    parts.push(text.to_string());
                }
            }
            scraper::node::Node::Element(node) => {
                let tag = node.name.local.as_ref();
                if SKIP_TAGS.contains(&tag) {
                    continue;
                }
                let Some(child) = scraper::ElementRef::wrap(child) else {
                    continue;
                };
                let child_text = extract_text(&child, inside_link || tag == "a");
                if child_text.is_empty() {
                    continue;
                }
                if tag == "a" && !inside_link {
                    let href = node.attr("href").unwrap_or("");
                    if is_followable_href(href) {
                        parts.push(format!("[{}]({href})", escape_link_text(&child_text)));
                    } else {
                        parts.push(child_text);
                    }
                } else if BLOCK_TAGS.contains(&tag) {
                    parts.push(format!("\n{child_text}\n"));
                } else {
                    parts.push(child_text);
                }
            }
            _ => {}
        }
    }
    parts.join(" ")
}

fn is_followable_href(href: &str) -> bool {
    !href.is_empty()
        && !href.starts_with('#')
        && (href.starts_with('/')
            || href.starts_with('?')
            || href.starts_with("http://")
            || href.starts_with("https://")
            || !href.contains(':'))
}

fn escape_link_text(text: &str) -> String {
    text.replace('[', r"\[")
        .replace(']', r"\]")
        .replace('(', r"\(")
        .replace(')', r"\)")
}

fn collapse_whitespace(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut previous_blank = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if !previous_blank {
                result.push('\n');
                previous_blank = true;
            }
        } else {
            result.push_str(trimmed);
            result.push('\n');
            previous_blank = false;
        }
    }
    result.trim().to_string()
}

fn truncate(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…\n\n[Truncated at {end} chars]", &text[..end])
}
