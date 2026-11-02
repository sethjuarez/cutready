use super::PendingChatSummary;
use std::path::PathBuf;

fn summary(session_id: &str) -> PendingChatSummary {
    PendingChatSummary {
        session_id: session_id.to_string(),
        summary: "text".to_string(),
        repo_root: PathBuf::from("/repo/alpha"),
        root: PathBuf::from("/repo/alpha"),
    }
}

#[test]
fn origin_prefers_the_pending_summarys_project_when_the_session_matches() {
    let pending = summary("s1");
    let fallback = Some((PathBuf::from("/repo/beta"), PathBuf::from("/repo/beta")));
    let origin = PendingChatSummary::origin_for(Some(&pending), "s1", fallback);
    assert_eq!(
        origin,
        Some((PathBuf::from("/repo/alpha"), PathBuf::from("/repo/alpha"))),
        "a summary must archive under the project it originated in"
    );
}

#[test]
fn origin_falls_back_to_the_active_project_when_no_pending_summary_matches() {
    let fallback = Some((PathBuf::from("/repo/beta"), PathBuf::from("/repo/beta")));
    // No pending summary at all.
    assert_eq!(
        PendingChatSummary::origin_for(None, "s1", fallback.clone()),
        fallback
    );
    // Pending summary is for a different session.
    let other = summary("other");
    assert_eq!(
        PendingChatSummary::origin_for(Some(&other), "s1", fallback.clone()),
        fallback
    );
}

#[test]
fn origin_is_none_when_no_pending_match_and_no_active_project() {
    assert_eq!(PendingChatSummary::origin_for(None, "s1", None), None);
}
