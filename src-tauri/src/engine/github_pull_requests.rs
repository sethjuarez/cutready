//! GitHub implementation of Draftline's [`PullRequestProvider`], used by
//! Send for hybrid projects to open (or reuse) a pull request after pushing.
//!
//! Draftline calls the provider synchronously from inside `Workspace::send`,
//! so this uses reqwest's blocking client. Callers must run Send off the async
//! runtime (e.g. `tokio::task::spawn_blocking`).

use std::time::Duration;

use draftline::{DraftlineError, PullRequest, PullRequestProvider, PullRequestRequest};
use serde::Deserialize;

pub const GITHUB_API_BASE_URL: &str = "https://api.github.com";
const USER_AGENT: &str = "CutReady";
const ACCEPT: &str = "application/vnd.github+json";
const API_VERSION: &str = "2022-11-28";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Owner and repository name of a GitHub remote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitHubRepo {
    pub owner: String,
    pub repo: String,
}

/// Parses `https://github.com/o/r(.git)`, `git@github.com:o/r(.git)`, and
/// `ssh://git@github.com/o/r(.git)` remote URLs.
pub fn parse_github_remote_url(url: &str) -> Option<GitHubRepo> {
    let trimmed = url.trim();
    let lower = trimmed.to_ascii_lowercase();
    let path = [
        "https://github.com/",
        "ssh://git@github.com/",
        "git@github.com:",
    ]
    .iter()
    .find(|prefix| lower.starts_with(*prefix))
    .map(|prefix| &trimmed[prefix.len()..])?;
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut parts = path.split('/');
    let owner = parts.next().filter(|part| !part.is_empty())?;
    let repo = parts.next().filter(|part| !part.is_empty())?;
    if parts.next().is_some() {
        return None;
    }
    Some(GitHubRepo {
        owner: owner.to_string(),
        repo: repo.to_string(),
    })
}

fn pull_request_error(message: impl Into<String>) -> DraftlineError {
    DraftlineError::PullRequest(message.into())
}

#[derive(Debug, Deserialize)]
struct GitHubPullRequest {
    number: u64,
    html_url: String,
}

impl From<GitHubPullRequest> for PullRequest {
    fn from(pull: GitHubPullRequest) -> Self {
        PullRequest {
            number: pull.number,
            url: pull.html_url,
        }
    }
}

#[derive(Debug, Deserialize)]
struct GitHubErrorBody {
    message: Option<String>,
    #[serde(default)]
    errors: Vec<serde_json::Value>,
}

/// Opens and finds pull requests through the GitHub REST API.
pub struct GitHubPullRequestProvider {
    client: reqwest::blocking::Client,
    api_base: String,
    repo: GitHubRepo,
    token: String,
}

impl GitHubPullRequestProvider {
    /// Builds a provider for the GitHub repository behind `remote_url`.
    /// Fails with [`DraftlineError::PullRequest`] for non-GitHub remotes or
    /// when no GitHub token is available.
    pub fn for_remote_url(remote_url: &str, token: Option<String>) -> draftline::Result<Self> {
        let repo = parse_github_remote_url(remote_url).ok_or_else(|| {
            pull_request_error(
                "Send for review only supports GitHub remotes. Push manually or switch the remote to a github.com repository.",
            )
        })?;
        let token = token
            .map(|token| token.trim().to_string())
            .filter(|token| !token.is_empty())
            .ok_or_else(|| {
                pull_request_error(
                    "Connect GitHub in CutReady settings (or sign in with the gh CLI) to open a pull request.",
                )
            })?;
        let client = reqwest::blocking::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|error| {
                pull_request_error(format!("could not create HTTP client: {error}"))
            })?;
        Ok(Self {
            client,
            api_base: GITHUB_API_BASE_URL.to_string(),
            repo,
            token,
        })
    }

    /// Points the provider at another API host (e.g. a mock server in tests).
    #[cfg(test)]
    pub fn with_api_base(mut self, api_base: impl Into<String>) -> Self {
        self.api_base = api_base.into().trim_end_matches('/').to_string();
        self
    }

    #[cfg(test)]
    pub fn repo(&self) -> &GitHubRepo {
        &self.repo
    }

    fn pulls_url(&self) -> String {
        format!(
            "{}/repos/{}/{}/pulls",
            self.api_base, self.repo.owner, self.repo.repo
        )
    }

    fn request(
        &self,
        builder: reqwest::blocking::RequestBuilder,
    ) -> reqwest::blocking::RequestBuilder {
        builder
            .bearer_auth(&self.token)
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .header(reqwest::header::ACCEPT, ACCEPT)
            .header("X-GitHub-Api-Version", API_VERSION)
    }

    fn send_json<T: serde::de::DeserializeOwned>(
        &self,
        action: &str,
        builder: reqwest::blocking::RequestBuilder,
    ) -> draftline::Result<T> {
        let response = self
            .request(builder)
            .send()
            .map_err(|error| pull_request_error(format!("GitHub {action} failed: {error}")))?;
        let status = response.status();
        if !status.is_success() {
            let detail = response
                .json::<GitHubErrorBody>()
                .ok()
                .map(|body| {
                    let mut message = body.message.unwrap_or_default();
                    let extra: Vec<String> = body
                        .errors
                        .iter()
                        .filter_map(|error| {
                            error
                                .get("message")
                                .and_then(|value| value.as_str())
                                .map(str::to_string)
                        })
                        .collect();
                    if !extra.is_empty() {
                        message = format!("{message} ({})", extra.join("; "));
                    }
                    message
                })
                .filter(|message| !message.trim().is_empty());
            return Err(pull_request_error(match detail {
                Some(detail) => format!("GitHub {action} failed ({status}): {detail}"),
                None => format!("GitHub {action} failed ({status})"),
            }));
        }
        response.json::<T>().map_err(|error| {
            pull_request_error(format!(
                "GitHub {action} returned an unexpected response: {error}"
            ))
        })
    }
}

impl PullRequestProvider for GitHubPullRequestProvider {
    fn find_open(
        &mut self,
        request: &PullRequestRequest,
    ) -> draftline::Result<Option<PullRequest>> {
        let head = format!("{}:{}", self.repo.owner, request.head);
        let builder = self.client.get(self.pulls_url()).query(&[
            ("state", "open"),
            ("head", head.as_str()),
            ("base", request.base.as_str()),
        ]);
        let pulls: Vec<GitHubPullRequest> = self.send_json("pull request lookup", builder)?;
        Ok(pulls.into_iter().next().map(PullRequest::from))
    }

    fn create(&mut self, request: &PullRequestRequest) -> draftline::Result<PullRequest> {
        let builder = self.client.post(self.pulls_url()).json(&serde_json::json!({
            "title": request.title,
            "head": request.head,
            "base": request.base,
            "body": request.body,
        }));
        let pull: GitHubPullRequest = self.send_json("pull request creation", builder)?;
        Ok(pull.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::prelude::*;

    fn request() -> PullRequestRequest {
        PullRequestRequest {
            remote: "origin".to_string(),
            head: "cutready/launch-demo".to_string(),
            base: "main".to_string(),
            title: "Launch demo".to_string(),
            body: "Ready for review".to_string(),
        }
    }

    fn provider(server: &MockServer) -> GitHubPullRequestProvider {
        GitHubPullRequestProvider::for_remote_url(
            "https://github.com/contoso/app.git",
            Some("test-token".to_string()),
        )
        .unwrap()
        .with_api_base(server.base_url())
    }

    #[test]
    fn parses_github_remote_url_variants() {
        let expected = Some(GitHubRepo {
            owner: "contoso".to_string(),
            repo: "app".to_string(),
        });
        for url in [
            "https://github.com/contoso/app",
            "https://github.com/contoso/app.git",
            "https://github.com/contoso/app/",
            "git@github.com:contoso/app.git",
            "git@github.com:contoso/app",
            "ssh://git@github.com/contoso/app",
            "ssh://git@github.com/contoso/app.git",
            "  HTTPS://GitHub.com/contoso/app.git  ",
        ] {
            assert_eq!(parse_github_remote_url(url), expected, "{url}");
        }
        for url in [
            "https://gitlab.com/contoso/app.git",
            "https://github.com/contoso",
            "https://github.com/contoso/app/extra",
            "C:/remotes/app.git",
            "",
        ] {
            assert_eq!(parse_github_remote_url(url), None, "{url}");
        }
    }

    #[test]
    fn rejects_non_github_remotes_and_missing_tokens() {
        let error =
            GitHubPullRequestProvider::for_remote_url("https://dev.azure.com/o/p/_git/r", None)
                .err()
                .unwrap();
        assert!(matches!(error, DraftlineError::PullRequest(_)), "{error}");
        assert!(error.to_string().contains("GitHub remotes"));

        let error = GitHubPullRequestProvider::for_remote_url(
            "git@github.com:contoso/app.git",
            Some("  ".to_string()),
        )
        .err()
        .unwrap();
        assert!(matches!(error, DraftlineError::PullRequest(_)), "{error}");
        assert!(error.to_string().contains("Connect GitHub"));
    }

    #[test]
    fn find_open_returns_first_matching_pull_request() {
        let server = MockServer::start();
        let mock = server.mock(|when, then| {
            when.method(GET)
                .path("/repos/contoso/app/pulls")
                .query_param("state", "open")
                .query_param("head", "contoso:cutready/launch-demo")
                .query_param("base", "main")
                .header("authorization", "Bearer test-token")
                .header("accept", ACCEPT)
                .header("user-agent", USER_AGENT);
            then.status(200).json_body(serde_json::json!([
                { "number": 7, "html_url": "https://github.com/contoso/app/pull/7" },
                { "number": 8, "html_url": "https://github.com/contoso/app/pull/8" }
            ]));
        });

        let found = provider(&server).find_open(&request()).unwrap();
        mock.assert();
        assert_eq!(
            found,
            Some(PullRequest {
                number: 7,
                url: "https://github.com/contoso/app/pull/7".to_string(),
            })
        );
    }

    #[test]
    fn find_open_returns_none_when_no_pull_request_is_open() {
        let server = MockServer::start();
        let mock = server.mock(|when, then| {
            when.method(GET).path("/repos/contoso/app/pulls");
            then.status(200).json_body(serde_json::json!([]));
        });

        assert_eq!(provider(&server).find_open(&request()).unwrap(), None);
        mock.assert();
    }

    #[test]
    fn create_posts_pull_request() {
        let server = MockServer::start();
        let mock = server.mock(|when, then| {
            when.method(POST)
                .path("/repos/contoso/app/pulls")
                .header("authorization", "Bearer test-token")
                .json_body(serde_json::json!({
                    "title": "Launch demo",
                    "head": "cutready/launch-demo",
                    "base": "main",
                    "body": "Ready for review",
                }));
            then.status(201).json_body(serde_json::json!({
                "number": 42,
                "html_url": "https://github.com/contoso/app/pull/42",
                "state": "open"
            }));
        });

        let created = provider(&server).create(&request()).unwrap();
        mock.assert();
        assert_eq!(created.number, 42);
        assert_eq!(created.url, "https://github.com/contoso/app/pull/42");
    }

    #[test]
    fn non_success_responses_become_pull_request_errors() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(POST).path("/repos/contoso/app/pulls");
            then.status(422).json_body(serde_json::json!({
                "message": "Validation Failed",
                "errors": [{ "message": "No commits between main and cutready/launch-demo" }]
            }));
        });
        server.mock(|when, then| {
            when.method(GET).path("/repos/contoso/app/pulls");
            then.status(401).body("unauthorized");
        });

        let mut provider = provider(&server);
        let error = provider.create(&request()).unwrap_err();
        assert!(matches!(error, DraftlineError::PullRequest(_)), "{error}");
        let message = error.to_string();
        assert!(message.contains("422"), "{message}");
        assert!(message.contains("Validation Failed"), "{message}");
        assert!(message.contains("No commits between"), "{message}");

        let error = provider.find_open(&request()).unwrap_err();
        assert!(matches!(error, DraftlineError::PullRequest(_)), "{error}");
        assert!(error.to_string().contains("401"), "{error}");
    }
}
