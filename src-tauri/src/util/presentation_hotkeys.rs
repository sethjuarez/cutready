/// Maps a presentation hotkey action to the frontend event it emits.
pub fn event_name(action: &str) -> Option<&'static str> {
    match action {
        "next" => Some("presentation-hotkey-next"),
        "previous" => Some("presentation-hotkey-previous"),
        "play_pause" => Some("presentation-hotkey-play-pause"),
        "speed_up" => Some("presentation-hotkey-speed-up"),
        "slow_down" => Some("presentation-hotkey-slow-down"),
        "toggle_mode" => Some("presentation-hotkey-toggle-mode"),
        "exit" => Some("presentation-hotkey-exit"),
        _ => None,
    }
}
