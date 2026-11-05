//! How CutReady authenticates to git remotes: a connected GitHub token for
//! GitHub remotes, then the SSH agent, then git's default credentials.

use draftline::{RemoteCredential, RemoteOptions};

pub fn cutready_remote_options(github_token: Option<String>) -> RemoteOptions<'static> {
    RemoteOptions::new().with_credentials(move |request| {
        if let Some(token) = github_token.as_ref() {
            if request.allows_username_password && is_github_remote_url(request.url) {
                return Ok(RemoteCredential::UsernamePassword {
                    username: "x-access-token".to_string(),
                    password: token.clone(),
                });
            }
        }

        if request.allows_ssh_key {
            return Ok(RemoteCredential::SshAgent {
                username: request.username_from_url.unwrap_or("git").to_string(),
            });
        }

        Ok(RemoteCredential::Default)
    })
}

pub fn is_github_remote_url(url: &str) -> bool {
    let normalized = url.trim().to_ascii_lowercase();
    normalized.starts_with("https://github.com/")
        || normalized.starts_with("ssh://git@github.com/")
        || normalized.starts_with("git@github.com:")
}
