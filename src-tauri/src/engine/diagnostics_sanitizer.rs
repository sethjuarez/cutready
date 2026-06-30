use serde_json::Value;

const REDACTED_SECRET: &str = "<redacted secret>";
const REDACTED_LOCAL_PATH: &str = "<redacted local path>";
const REDACTED_MACHINE: &str = "<redacted machine>";
const REDACTED_USER: &str = "<redacted user>";

const SECRET_KEY_PARTS: &[&str] = &[
    "token",
    "secret",
    "password",
    "authorization",
    "api_key",
    "apikey",
    "bearer",
    "cookie",
    "set-cookie",
];

const LOCAL_PATH_KEYS: &[&str] = &[
    "database_path",
    "settings_path",
    "root",
    "path",
    "file_path",
    "filepath",
    "source_file",
];

const IDENTITY_KEYS: &[&str] = &[
    "machine_name",
    "hostname",
    "computername",
    "username",
    "user_name",
];

const SECRET_MARKERS: &[&str] = &[
    "authorization: bearer ",
    "bearer ",
    "access_token=",
    "refresh_token=",
    "api_key=",
    "apikey=",
    "token=",
    "password=",
    "secret=",
    "client_secret=",
    "x-api-key:",
];

pub fn sanitize_diagnostic_value(value: &mut Value) {
    sanitize_value_for_key(value, "");
}

pub fn sanitize_diagnostic_text(text: &str) -> String {
    let mut sanitized = redact_secret_markers(text);
    sanitized = redact_local_paths(&sanitized);
    sanitized = redact_known_machine_and_user_names(&sanitized);
    sanitized
}

pub fn sanitize_diagnostic_optional_text(value: Option<String>) -> Option<String> {
    value.map(|value| sanitize_diagnostic_text(&value))
}

fn sanitize_value_for_key(value: &mut Value, key: &str) {
    if is_secret_key(key) {
        *value = Value::String(REDACTED_SECRET.to_string());
        return;
    }

    if is_local_path_key(key) {
        if value.is_string() {
            *value = Value::String(REDACTED_LOCAL_PATH.to_string());
            return;
        }
    }

    if is_identity_key(key) {
        *value = Value::String(REDACTED_MACHINE.to_string());
        return;
    }

    match value {
        Value::Object(map) => {
            for (entry_key, entry_value) in map.iter_mut() {
                sanitize_value_for_key(entry_value, entry_key);
            }
        }
        Value::Array(items) => {
            for item in items {
                sanitize_value_for_key(item, key);
            }
        }
        Value::String(text) => {
            *text = sanitize_diagnostic_text(text);
        }
        _ => {}
    }
}

fn is_secret_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase().replace('-', "_");
    SECRET_KEY_PARTS
        .iter()
        .any(|part| normalized.contains(part))
}

fn is_local_path_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    LOCAL_PATH_KEYS
        .iter()
        .any(|path_key| normalized == *path_key)
}

fn is_identity_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    IDENTITY_KEYS
        .iter()
        .any(|identity_key| normalized == *identity_key)
}

fn redact_secret_markers(input: &str) -> String {
    let mut output = input.to_string();
    for marker in SECRET_MARKERS {
        output = redact_after_marker(&output, marker, REDACTED_SECRET);
    }
    output
}

fn redact_after_marker(input: &str, marker: &str, replacement: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;

    while let Some(relative_start) = lower[cursor..].find(marker) {
        let marker_start = cursor + relative_start;
        let value_start = marker_start + marker.len();
        output.push_str(&input[cursor..value_start]);

        let value_end = input[value_start..]
            .char_indices()
            .find_map(|(offset, ch)| is_secret_delimiter(ch).then_some(value_start + offset))
            .unwrap_or(input.len());
        output.push_str(replacement);
        cursor = value_end;
    }

    output.push_str(&input[cursor..]);
    output
}

fn is_secret_delimiter(ch: char) -> bool {
    ch.is_whitespace() || matches!(ch, '"' | '\'' | '&' | ',' | ';' | ')' | ']' | '}')
}

fn redact_local_paths(input: &str) -> String {
    let chars: Vec<(usize, char)> = input.char_indices().collect();
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;
    let mut index = 0;

    while index < chars.len() {
        let (byte_index, _) = chars[index];
        let path_start = is_windows_path_start(&chars, index)
            || input[byte_index..].starts_with("/Users/")
            || input[byte_index..].starts_with("/home/");
        if !path_start {
            index += 1;
            continue;
        }

        output.push_str(&input[cursor..byte_index]);
        output.push_str(REDACTED_LOCAL_PATH);

        index += 1;
        while index < chars.len() && !is_path_delimiter(chars[index].1) {
            index += 1;
        }
        cursor = chars
            .get(index)
            .map(|(byte, _)| *byte)
            .unwrap_or(input.len());
    }

    output.push_str(&input[cursor..]);
    output
}

fn is_windows_path_start(chars: &[(usize, char)], index: usize) -> bool {
    if index + 2 >= chars.len() {
        return false;
    }
    chars[index].1.is_ascii_alphabetic()
        && chars[index + 1].1 == ':'
        && matches!(chars[index + 2].1, '\\' | '/')
}

fn is_path_delimiter(ch: char) -> bool {
    ch.is_whitespace()
        || matches!(
            ch,
            '"' | '\'' | '`' | ',' | ';' | ')' | ']' | '}' | '<' | '>'
        )
}

fn redact_known_machine_and_user_names(input: &str) -> String {
    let mut output = input.to_string();
    for candidate in machine_candidates() {
        output = output.replace(&candidate, REDACTED_MACHINE);
    }
    for candidate in user_candidates() {
        output = output.replace(&candidate, REDACTED_USER);
    }
    output
}

fn machine_candidates() -> Vec<String> {
    unique_candidates(["COMPUTERNAME", "HOSTNAME"])
}

fn user_candidates() -> Vec<String> {
    let mut candidates = unique_candidates(["USERNAME", "USER"]);
    if let Some(home_name) = dirs::home_dir().and_then(|path| {
        path.file_name()
            .map(|name| name.to_string_lossy().to_string())
    }) {
        push_candidate(&mut candidates, home_name);
    }
    candidates
}

fn unique_candidates<const N: usize>(keys: [&str; N]) -> Vec<String> {
    let mut candidates = Vec::new();
    for key in keys {
        if let Ok(value) = std::env::var(key) {
            push_candidate(&mut candidates, value);
        }
    }
    candidates
}

fn push_candidate(candidates: &mut Vec<String>, value: String) {
    let trimmed = value.trim();
    if trimmed.len() < 3 {
        return;
    }
    if matches!(
        trimmed.to_ascii_lowercase().as_str(),
        "user" | "users" | "home" | "admin" | "root" | "localhost"
    ) {
        return;
    }
    if !candidates.iter().any(|candidate| candidate == trimmed) {
        candidates.push(trimmed.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::{sanitize_diagnostic_text, sanitize_diagnostic_value};
    use serde_json::json;

    #[test]
    fn redacts_secret_keys_and_auth_fragments() {
        let mut value = json!({
            "authorization": "Bearer abc123",
            "detail": "request failed with Authorization: Bearer topsecret and token=mytoken"
        });

        sanitize_diagnostic_value(&mut value);

        let text = serde_json::to_string(&value).unwrap();
        assert!(!text.contains("abc123"));
        assert!(!text.contains("topsecret"));
        assert!(!text.contains("mytoken"));
        assert!(text.contains("<redacted secret>"));
    }

    #[test]
    fn redacts_local_paths_in_nested_values() {
        let mut value = json!({
            "machine_name": "DEV-MACHINE",
            "session": {
                "database_path": "C:\\Users\\person\\AppData\\Local\\auditaur\\telemetry.sqlite"
            },
            "detail": "at C:\\Users\\person\\project\\src\\main.ts and /Users/person/project/file.ts"
        });

        sanitize_diagnostic_value(&mut value);

        let text = serde_json::to_string_pretty(&value).unwrap();
        assert!(!text.contains("Users\\\\person"));
        assert!(!text.contains("/Users/person"));
        assert!(!text.contains("DEV-MACHINE"));
        assert!(text.contains("<redacted local path>"));
        assert!(text.contains("<redacted machine>"));
    }

    #[test]
    fn redacts_known_machine_and_user_names() {
        std::env::set_var("COMPUTERNAME", "CUTREADY-LAPTOP");
        std::env::set_var("USERNAME", "demo-person");

        let text = sanitize_diagnostic_text("error on CUTREADY-LAPTOP for demo-person");

        assert!(!text.contains("CUTREADY-LAPTOP"));
        assert!(!text.contains("demo-person"));
        assert!(text.contains("<redacted machine>"));
        assert!(text.contains("<redacted user>"));
    }
}
