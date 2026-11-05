//! Draftline's GitHub provider for a project's remote, with CutReady's token
//! and the debug-only drill hooks. Its calls block on HTTP, so run them off
//! the async runtime (`spawn_blocking`).

use draftline::github::{parse_github_remote_url, GitHubProvider, GitHubRepo};
use draftline::DraftlineError;

const USER_AGENT: &str = "CutReady";

/// Debug builds only: `CUTREADY_GITHUB_API_BASE` points Send for review at a
/// local fake GitHub API so live drills can exercise the full flow.
fn drill_api_base() -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var("CUTREADY_GITHUB_API_BASE")
        .ok()
        .map(|base| base.trim().trim_end_matches('/').to_string())
        .filter(|base| {
            base.starts_with("http://127.0.0.1:") || base.starts_with("http://localhost:")
        })
}

/// In a drill, a local bare remote named `github.git` stands in for
/// `drill/<its parent folder>`. Other local remotes stay non-GitHub.
fn drill_repo(remote_url: &str) -> Option<GitHubRepo> {
    let path = std::path::Path::new(remote_url.trim());
    if !path.is_absolute() || !path.file_name()?.eq_ignore_ascii_case("github.git") {
        return None;
    }
    let repo = path.parent()?.file_name()?.to_str()?.to_ascii_lowercase();
    Some(GitHubRepo::new("drill", repo))
}

/// The provider for the GitHub repository behind `remote_url`. Fails with
/// `pull_request_failed` for other remotes and `github_unauthorized` without
/// a token.
pub fn github_provider_for(
    remote_url: &str,
    token: Option<String>,
) -> draftline::Result<GitHubProvider> {
    with_api_base(remote_url, token, drill_api_base())
}

fn with_api_base(
    remote_url: &str,
    token: Option<String>,
    api_base: Option<String>,
) -> draftline::Result<GitHubProvider> {
    let repo = parse_github_remote_url(remote_url)
        .or_else(|| api_base.as_ref().and_then(|_| drill_repo(remote_url)))
        .ok_or_else(|| {
            DraftlineError::PullRequest(
                "Send for review only supports GitHub remotes. Push manually or switch the remote to a github.com repository.".to_string(),
            )
        })?;
    // A drill's fake GitHub never sees a real token.
    let token = if api_base.is_some() {
        Some("drill-token".to_string())
    } else {
        token
    };
    let token = token.filter(|token| !token.trim().is_empty()).ok_or_else(|| {
        DraftlineError::GitHubUnauthorized(
            "connect GitHub in CutReady settings (or sign in with the gh CLI) to open a pull request"
                .to_string(),
        )
    })?;
    let provider = GitHubProvider::new(repo, token)?.with_user_agent(USER_AGENT);
    Ok(match api_base {
        Some(base) => provider.with_api_base(base),
        None => provider,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use draftline::{PullRequestProvider, PullRequestRequest};
    use httpmock::prelude::*;

    #[test]
    fn drill_repo_names_a_local_remote_by_its_folder() {
        let remote = std::env::temp_dir().join("R01").join("github.git");
        let repo = drill_repo(remote.to_str().unwrap()).unwrap();
        assert_eq!((repo.owner.as_str(), repo.repo.as_str()), ("drill", "r01"));
        assert!(drill_repo("relative/github.git").is_none());
        // Other local remotes stay non-GitHub, so drills can still test refusals.
        let other = std::env::temp_dir().join("H06").join("remote.git");
        assert!(drill_repo(other.to_str().unwrap()).is_none());
    }

    #[test]
    fn rejects_non_github_remotes_and_missing_tokens() {
        let error = github_provider_for("https://dev.azure.com/o/p/_git/r", None)
            .err()
            .unwrap();
        assert!(matches!(error, DraftlineError::PullRequest(_)), "{error}");
        assert!(error.to_string().contains("GitHub remotes"));

        let error = with_api_base("git@github.com:contoso/app.git", Some("  ".into()), None)
            .err()
            .unwrap();
        assert!(
            matches!(error, DraftlineError::GitHubUnauthorized(_)),
            "{error}"
        );
    }

    #[test]
    fn opens_pull_requests_as_cutready_on_the_drill_api() {
        let server = MockServer::start();
        let find = server.mock(|when, then| {
            when.method(GET)
                .path("/repos/drill/r01/pulls")
                .header("user-agent", USER_AGENT)
                .header("authorization", "Bearer drill-token");
            then.status(200).json_body(serde_json::json!([]));
        });
        let create = server.mock(|when, then| {
            when.method(POST).path("/repos/drill/r01/pulls");
            then.status(201).json_body(serde_json::json!({
                "number": 7,
                "html_url": "https://github.com/drill/r01/pull/7"
            }));
        });
        let remote = std::env::temp_dir().join("R01").join("github.git");
        let mut provider =
            with_api_base(remote.to_str().unwrap(), None, Some(server.base_url())).unwrap();
        let request = PullRequestRequest {
            remote: "origin".into(),
            head: "cutready/launch-demo".into(),
            base: "main".into(),
            title: "Launch demo".into(),
            body: String::new(),
        };
        assert!(provider.find_open(&request).unwrap().is_none());
        assert_eq!(provider.create(&request).unwrap().number, 7);
        find.assert();
        create.assert();
    }
}
