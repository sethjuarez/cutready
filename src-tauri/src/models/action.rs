use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Direction for scroll actions.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ScrollDirection {
    Up,
    Down,
    Left,
    Right,
}

/// A segment in a UIA tree path for native automation targeting.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UiaPathSegment {
    pub control_type: String,
    pub name: Option<String>,
    pub automation_id: Option<String>,
    pub index: usize,
}

/// A rectangular screen region.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ScreenRegion {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Selector targeting strategies, ordered by priority during replay.
/// Multiple strategies per action provide fallback resilience.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "strategy", content = "value")]
pub enum SelectorStrategy {
    CssSelector(String),
    XPath(String),
    AccessibilityId(String),
    AccessibilityName(String),
    DataTestId(String),
    TextContent(String),
    UiaTreePath(Vec<UiaPathSegment>),
}

/// A single atomic demo step. Both the interaction recorder and the
/// automation engine operate on Actions.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum Action {
    // ── Browser Actions ──
    BrowserNavigate {
        url: String,
    },
    BrowserClick {
        selectors: Vec<SelectorStrategy>,
    },
    BrowserType {
        selectors: Vec<SelectorStrategy>,
        text: String,
        clear_first: bool,
    },
    BrowserSelect {
        selectors: Vec<SelectorStrategy>,
        value: String,
    },
    BrowserScroll {
        direction: ScrollDirection,
        amount: i32,
    },
    BrowserWaitForElement {
        selectors: Vec<SelectorStrategy>,
        timeout_ms: u64,
    },

    // ── Native App Actions ──
    NativeLaunch {
        executable: String,
        args: Vec<String>,
    },
    NativeClick {
        selectors: Vec<SelectorStrategy>,
    },
    NativeType {
        text: String,
    },
    NativeSelect {
        selectors: Vec<SelectorStrategy>,
        value: String,
    },
    NativeInvoke {
        selectors: Vec<SelectorStrategy>,
    },

    // ── Common Actions ──
    Wait {
        duration_ms: u64,
    },
    Screenshot {
        region: Option<ScreenRegion>,
        output_path: PathBuf,
    },
    Annotation {
        text: String,
    },
}

/// Metadata attached to every action after recording.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionMetadata {
    pub captured_screenshot: Option<PathBuf>,
    pub selector_strategies: Vec<SelectorStrategy>,
    pub timestamp_ms: u64,
    /// How confident the recorder is in the captured target (0.0–1.0).
    pub confidence: f32,
    /// DOM snippet or UIA subtree JSON for agent context.
    pub context_snapshot: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_browser_click_roundtrip() {
        let action = Action::BrowserClick {
            selectors: vec![
                SelectorStrategy::CssSelector("#submit-btn".into()),
                SelectorStrategy::DataTestId("submit".into()),
            ],
        };
        let json = serde_json::to_string(&action).unwrap();
        let parsed: Action = serde_json::from_str(&json).unwrap();
        assert_eq!(action, parsed);
    }

    #[test]
    fn action_browser_type_roundtrip() {
        let action = Action::BrowserType {
            selectors: vec![SelectorStrategy::CssSelector("input[name='email']".into())],
            text: "user@example.com".into(),
            clear_first: true,
        };
        let json = serde_json::to_string(&action).unwrap();
        let parsed: Action = serde_json::from_str(&json).unwrap();
        assert_eq!(action, parsed);
    }

    #[test]
    fn action_native_click_roundtrip() {
        let action = Action::NativeClick {
            selectors: vec![
                SelectorStrategy::AccessibilityId("btn_save".into()),
                SelectorStrategy::AccessibilityName("Save".into()),
            ],
        };
        let json = serde_json::to_string(&action).unwrap();
        let parsed: Action = serde_json::from_str(&json).unwrap();
        assert_eq!(action, parsed);
    }

    #[test]
    fn action_wait_roundtrip() {
        let action = Action::Wait { duration_ms: 1500 };
        let json = serde_json::to_string(&action).unwrap();
        let parsed: Action = serde_json::from_str(&json).unwrap();
        assert_eq!(action, parsed);
    }

    #[test]
    fn action_screenshot_roundtrip() {
        let action = Action::Screenshot {
            region: Some(ScreenRegion {
                x: 100,
                y: 200,
                width: 800,
                height: 600,
            }),
            output_path: "screenshots/step_1.png".into(),
        };
        let json = serde_json::to_string(&action).unwrap();
        let parsed: Action = serde_json::from_str(&json).unwrap();
        assert_eq!(action, parsed);
    }

    #[test]
    fn selector_strategy_roundtrip() {
        let strategies = vec![
            SelectorStrategy::CssSelector("#main .btn".into()),
            SelectorStrategy::XPath("//button[@id='submit']".into()),
            SelectorStrategy::UiaTreePath(vec![
                UiaPathSegment {
                    control_type: "Window".into(),
                    name: Some("Notepad".into()),
                    automation_id: None,
                    index: 0,
                },
                UiaPathSegment {
                    control_type: "MenuItem".into(),
                    name: Some("File".into()),
                    automation_id: Some("file_menu".into()),
                    index: 0,
                },
            ]),
        ];
        let json = serde_json::to_string(&strategies).unwrap();
        let parsed: Vec<SelectorStrategy> = serde_json::from_str(&json).unwrap();
        assert_eq!(strategies, parsed);
    }

    #[test]
    fn action_metadata_roundtrip() {
        let meta = ActionMetadata {
            captured_screenshot: Some("screenshots/step_1.png".into()),
            selector_strategies: vec![SelectorStrategy::CssSelector("#btn".into())],
            timestamp_ms: 12345,
            confidence: 0.95,
            context_snapshot: Some("<div id='btn'>Click me</div>".into()),
        };
        let json = serde_json::to_string(&meta).unwrap();
        let parsed: ActionMetadata = serde_json::from_str(&json).unwrap();
        assert_eq!(meta.timestamp_ms, parsed.timestamp_ms);
        assert!((meta.confidence - parsed.confidence).abs() < f32::EPSILON);
    }

    #[test]
    fn action_browser_navigate_roundtrip() {
        let action = Action::BrowserNavigate {
            url: "https://example.com/dashboard".into(),
        };
        let json = serde_json::to_string(&action).unwrap();
        let parsed: Action = serde_json::from_str(&json).unwrap();
        assert_eq!(action, parsed);
    }

    #[test]
    fn action_browser_select_roundtrip() {
        let action = Action::BrowserSelect {
            selectors: vec![SelectorStrategy::CssSelector("select#country".into())],
            value: "US".into(),
        };
        let json = serde_json::to_string(&action).unwrap();
        let parsed: Action = serde_json::from_str(&json).unwrap();
        assert_eq!(action, parsed);
    }

    #[test]
    fn action_browser_scroll_roundtrip() {
        let action = Action::BrowserScroll {
            direction: ScrollDirection::Down,
            amount: 300,
        };
        let json = serde_json::to_string(&action).unwrap();
        let parsed: Action = serde_json::from_str(&json).unwrap();
        assert_eq!(action, parsed);
        // Verify snake_case serialization
        assert!(json.contains("\"down\""));
    }

    #[test]
    fn action_browser_wait_for_element_roundtrip() {
        let action = Action::BrowserWaitForElement {
            selectors: vec![SelectorStrategy::DataTestId("loading-spinner".into())],
            timeout_ms: 5000,
        };
        let json = serde_json::to_string(&action).unwrap();
        let parsed: Action = serde_json::from_str(&json).unwrap();
        assert_eq!(action, parsed);
    }

    #[test]
    fn action_native_launch_roundtrip() {
        let action = Action::NativeLaunch {
            executable: "notepad.exe".into(),
            args: vec!["readme.txt".into()],
        };
        let json = serde_json::to_string(&action).unwrap();
        let parsed: Action = serde_json::from_str(&json).unwrap();
        assert_eq!(action, parsed);
    }

    #[test]
    fn action_native_type_roundtrip() {
        let action = Action::NativeType {
            text: "Hello, World!".into(),
        };
        let json = serde_json::to_string(&action).unwrap();
        let parsed: Action = serde_json::from_str(&json).unwrap();
        assert_eq!(action, parsed);
    }

    #[test]
    fn action_native_select_roundtrip() {
        let action = Action::NativeSelect {
            selectors: vec![SelectorStrategy::AccessibilityName("Font Size".into())],
            value: "12".into(),
        };
        let json = serde_json::to_string(&action).unwrap();
        let parsed: Action = serde_json::from_str(&json).unwrap();
        assert_eq!(action, parsed);
    }

    #[test]
    fn action_native_invoke_roundtrip() {
        let action = Action::NativeInvoke {
            selectors: vec![SelectorStrategy::AccessibilityId("menu_file".into())],
        };
        let json = serde_json::to_string(&action).unwrap();
        let parsed: Action = serde_json::from_str(&json).unwrap();
        assert_eq!(action, parsed);
    }

    #[test]
    fn action_annotation_roundtrip() {
        let action = Action::Annotation {
            text: "This step demonstrates the login flow".into(),
        };
        let json = serde_json::to_string(&action).unwrap();
        let parsed: Action = serde_json::from_str(&json).unwrap();
        assert_eq!(action, parsed);
    }

    #[test]
    fn action_screenshot_none_region_roundtrip() {
        let action = Action::Screenshot {
            region: None,
            output_path: "screenshots/full.png".into(),
        };
        let json = serde_json::to_string(&action).unwrap();
        let parsed: Action = serde_json::from_str(&json).unwrap();
        assert_eq!(action, parsed);
    }

    #[test]
    fn action_with_empty_selectors_roundtrip() {
        let action = Action::BrowserClick { selectors: vec![] };
        let json = serde_json::to_string(&action).unwrap();
        let parsed: Action = serde_json::from_str(&json).unwrap();
        assert_eq!(action, parsed);
    }

    #[test]
    fn scroll_direction_all_variants_roundtrip() {
        for dir in [
            ScrollDirection::Up,
            ScrollDirection::Down,
            ScrollDirection::Left,
            ScrollDirection::Right,
        ] {
            let json = serde_json::to_string(&dir).unwrap();
            let parsed: ScrollDirection = serde_json::from_str(&json).unwrap();
            assert_eq!(dir, parsed);
        }
    }

    #[test]
    fn selector_strategy_all_simple_variants_roundtrip() {
        let variants = vec![
            SelectorStrategy::CssSelector("div.class".into()),
            SelectorStrategy::XPath("//div".into()),
            SelectorStrategy::AccessibilityId("btn1".into()),
            SelectorStrategy::AccessibilityName("Submit".into()),
            SelectorStrategy::DataTestId("submit-btn".into()),
            SelectorStrategy::TextContent("Click me".into()),
        ];
        for variant in variants {
            let json = serde_json::to_string(&variant).unwrap();
            let parsed: SelectorStrategy = serde_json::from_str(&json).unwrap();
            assert_eq!(variant, parsed);
        }
    }

    #[test]
    fn screen_region_roundtrip() {
        let region = ScreenRegion {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let json = serde_json::to_string(&region).unwrap();
        let parsed: ScreenRegion = serde_json::from_str(&json).unwrap();
        assert_eq!(region, parsed);
    }

    #[test]
    fn action_metadata_with_none_fields() {
        let meta = ActionMetadata {
            captured_screenshot: None,
            selector_strategies: vec![],
            timestamp_ms: 0,
            confidence: 0.0,
            context_snapshot: None,
        };
        let json = serde_json::to_string(&meta).unwrap();
        let parsed: ActionMetadata = serde_json::from_str(&json).unwrap();
        assert_eq!(meta.timestamp_ms, parsed.timestamp_ms);
        assert!(parsed.captured_screenshot.is_none());
        assert!(parsed.context_snapshot.is_none());
        assert!(parsed.selector_strategies.is_empty());
    }

    #[test]
    fn action_tagged_type_field_present() {
        // Verify our tagged enum uses "type" as the tag key
        let action = Action::Wait { duration_ms: 100 };
        let json = serde_json::to_string(&action).unwrap();
        assert!(json.contains("\"type\":\"Wait\""));
    }

    #[test]
    fn uia_path_segment_roundtrip() {
        let segment = UiaPathSegment {
            control_type: "Button".into(),
            name: None,
            automation_id: Some("okBtn".into()),
            index: 2,
        };
        let json = serde_json::to_string(&segment).unwrap();
        let parsed: UiaPathSegment = serde_json::from_str(&json).unwrap();
        assert_eq!(segment, parsed);
    }
}
