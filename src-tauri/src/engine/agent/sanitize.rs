//! Sanitization of user-supplied chat content before it is sent to LLM providers.
//!
//! Some LLM gateways (notably Azure OpenAI) reject request bodies that contain
//! raw ASCII control characters inside string values, returning HTTP 400 with
//! errors like `Unterminated string. Path 'tools[..].function...'`. The
//! position pointer in those errors is often misleading and lands on whatever
//! string the parser was reading when it gave up — not the actual offender.
//!
//! As a defensive measure we strip C0 control characters (`U+0000`..`U+001F`)
//! and `DEL` (`U+007F`) from text content sent in user-role messages, except
//! for the harmless whitespace forms `\t`, `\n`, and `\r` which are part of
//! normal user input. Tracked under issue #60.
//!
//! Only user-role messages are sanitized:
//! - System and assistant messages come from us or the model and should not
//!   contain control characters; rewriting them risks breaking tool-call
//!   bookkeeping.
//! - Tool-result messages are produced by our own tool implementations and
//!   are sanitized at their own boundaries when needed.

use agentive::types::{ChatMessage, ContentPart, MessageContent};

/// Strip C0 control characters (excluding `\t`, `\n`, `\r`) and `DEL` from
/// the input text. Returns the sanitized string and the number of characters
/// that were removed.
pub fn sanitize_text(text: &str) -> (String, usize) {
    let mut removed = 0usize;
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        let drop = matches!(ch as u32, 0x00..=0x08 | 0x0B | 0x0C | 0x0E..=0x1F | 0x7F);
        if drop {
            removed += 1;
        } else {
            out.push(ch);
        }
    }
    (out, removed)
}

/// Sanitize all user-role messages in place. Returns the total number of
/// control characters removed across all user messages.
pub fn sanitize_user_messages(messages: &mut [ChatMessage]) -> usize {
    let mut total_removed = 0usize;
    for m in messages.iter_mut() {
        if m.role != "user" {
            continue;
        }
        let Some(content) = m.content.as_mut() else {
            continue;
        };
        match content {
            MessageContent::Text(s) => {
                let (clean, removed) = sanitize_text(s);
                if removed > 0 {
                    *s = clean;
                    total_removed += removed;
                }
            }
            MessageContent::Parts(parts) => {
                for part in parts.iter_mut() {
                    if let ContentPart::Text { text } = part {
                        let (clean, removed) = sanitize_text(text);
                        if removed > 0 {
                            *text = clean;
                            total_removed += removed;
                        }
                    }
                }
            }
        }
    }
    total_removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use agentive::types::{ChatMessage, ContentPart, ImageUrl, MessageContent};

    #[test]
    fn strips_nul_and_other_control_chars_but_keeps_whitespace() {
        let dirty = "hello\x00 \x01world\t\nline\r\x07!";
        let (clean, removed) = sanitize_text(dirty);
        assert_eq!(clean, "hello world\t\nline\r!");
        assert_eq!(removed, 3); // \x00, \x01, \x07
    }

    #[test]
    fn keeps_unicode_intact() {
        let dirty = "café 🎉 こんにちは\x00";
        let (clean, removed) = sanitize_text(dirty);
        assert_eq!(clean, "café 🎉 こんにちは");
        assert_eq!(removed, 1);
    }

    #[test]
    fn strips_del_character() {
        let (clean, removed) = sanitize_text("a\x7Fb");
        assert_eq!(clean, "ab");
        assert_eq!(removed, 1);
    }

    #[test]
    fn returns_zero_removed_when_clean() {
        let (clean, removed) = sanitize_text("perfectly normal text");
        assert_eq!(clean, "perfectly normal text");
        assert_eq!(removed, 0);
    }

    #[test]
    fn sanitizes_user_text_messages_only() {
        let mut messages = vec![
            ChatMessage {
                role: "system".into(),
                content: Some(MessageContent::Text("system\x00prompt".into())),
                tool_calls: None,
                tool_call_id: None,
            },
            ChatMessage {
                role: "user".into(),
                content: Some(MessageContent::Text("user\x00question".into())),
                tool_calls: None,
                tool_call_id: None,
            },
            ChatMessage {
                role: "assistant".into(),
                content: Some(MessageContent::Text("assistant\x00reply".into())),
                tool_calls: None,
                tool_call_id: None,
            },
        ];
        let removed = sanitize_user_messages(&mut messages);
        assert_eq!(removed, 1);
        assert_eq!(messages[0].content.as_ref().unwrap().text(), Some("system\x00prompt"));
        assert_eq!(messages[1].content.as_ref().unwrap().text(), Some("userquestion"));
        assert_eq!(messages[2].content.as_ref().unwrap().text(), Some("assistant\x00reply"));
    }

    #[test]
    fn sanitizes_user_multimodal_text_parts() {
        let mut messages = vec![ChatMessage {
            role: "user".into(),
            content: Some(MessageContent::Parts(vec![
                ContentPart::Text { text: "look at\x00this".into() },
                ContentPart::ImageUrl { image_url: ImageUrl { url: "data:image/png;base64,AAA".into(), detail: None } },
                ContentPart::Text { text: "and\x01that".into() },
            ])),
            tool_calls: None,
            tool_call_id: None,
        }];
        let removed = sanitize_user_messages(&mut messages);
        assert_eq!(removed, 2);
        let parts = match messages[0].content.as_ref().unwrap() {
            MessageContent::Parts(p) => p,
            _ => panic!("expected parts"),
        };
        match &parts[0] {
            ContentPart::Text { text } => assert_eq!(text, "look atthis"),
            _ => panic!("expected text"),
        }
        match &parts[2] {
            ContentPart::Text { text } => assert_eq!(text, "andthat"),
            _ => panic!("expected text"),
        }
    }

    #[test]
    fn returns_zero_when_nothing_to_strip() {
        let mut messages = vec![ChatMessage {
            role: "user".into(),
            content: Some(MessageContent::Text("clean question".into())),
            tool_calls: None,
            tool_call_id: None,
        }];
        assert_eq!(sanitize_user_messages(&mut messages), 0);
    }
}
