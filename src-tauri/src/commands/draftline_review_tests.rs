//! Hybrid Send for review after CutReady combined team updates.

use super::tests::{
    context, dev_push, fetch, git, init_bare_remote, remote_request, save, send_request, FakeHost,
};
use super::*;

#[test]
fn send_for_review_rejects_standalone_projects() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("demo");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("intro.sk"), "{}").unwrap();
    CutReadyDraftlineAdapter::open_project(&root).unwrap();

    let error = send_for_review_with(
        send_request(&root, "Ship it"),
        |_| panic!("standalone projects must not reach the provider"),
        &mut RemoteOptions::new(),
    )
    .unwrap_err();
    assert_eq!(error.code, SEND_REQUIRES_HYBRID);

    let error = send_for_review_with(
        send_request(&root, "   "),
        |_| panic!("blank titles must not reach the provider"),
        &mut RemoteOptions::new(),
    )
    .unwrap_err();
    assert_eq!(error.code, "invalid_request");
}

#[test]
fn send_for_review_pushes_a_cutready_branch_and_opens_a_pull_request() {
    let temp = tempfile::tempdir().unwrap();
    let remote = temp.path().join("remote.git");
    init_bare_remote(&remote);
    let code = temp.path().join("contoso-app");
    std::fs::create_dir_all(code.join("cutready")).unwrap();
    let mut options = git2::RepositoryInitOptions::new();
    options.initial_head("main");
    let repo = git2::Repository::init_opts(&code, &options).unwrap();
    std::fs::write(code.join("README.md"), "# Contoso\n").unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new("README.md")).unwrap();
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let signature = git2::Signature::now("Dev", "dev@example.com").unwrap();
    repo.commit(Some("HEAD"), &signature, &signature, "Code", &tree, &[])
        .unwrap();
    repo.remote("origin", remote.to_str().unwrap())
        .unwrap()
        .push(&["refs/heads/main:refs/heads/main"], None)
        .unwrap();

    let folder = code.join("cutready");
    std::fs::write(folder.join("intro.sk"), r#"{"title":"Intro"}"#).unwrap();
    save(&folder, "Intro");

    let host = FakeHost::default();
    let requests = host.requests.clone();
    let mut seen_url = None;
    let result = send_for_review_with(
        send_request(&folder, "Launch demo"),
        |url| {
            seen_url = Some(url.to_string());
            Ok(Box::new(host))
        },
        &mut RemoteOptions::new(),
    )
    .unwrap();

    assert_eq!(seen_url.as_deref(), remote.to_str());
    assert_eq!(result.variation, "cutready/launch-demo");
    assert_eq!(result.base, "main");
    assert!(result.created_variation && result.created_pull_request);
    assert_eq!(result.pull_request.number, 9);
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].head, "cutready/launch-demo");
    assert_eq!(requests[0].body, "Please review");
    assert!(git2::Repository::open_bare(&remote)
        .unwrap()
        .find_branch("cutready/launch-demo", git2::BranchType::Local)
        .is_ok());
}

/// Seth's alaska sequence: an older local team-update version stops the
/// replay, so Send combines the newer team saves, then opens the review.
/// Pins the graph facts the frontend's `reviewRequest` relies on (team
/// saves are remote-reachable, his saves and both combined versions are
/// not) and that the review is named after his save, not the combined one.
#[test]
fn send_for_review_after_combining_team_updates_is_named_after_the_users_save() {
    let temp = tempfile::tempdir().unwrap();
    let temp = temp.path();
    let remote = temp.join("remote.git");
    init_bare_remote(&remote);
    let code = temp.join("alaska");
    std::fs::create_dir_all(code.join("cutready")).unwrap();
    std::fs::write(code.join("cutready").join("compass.sk"), "{}").unwrap();
    git(temp, &["init", "--initial-branch=main", "alaska"]);
    git(&code, &["add", "cutready/compass.sk"]);
    git(&code, &["commit", "-m", "#24 setup"]);
    git(
        &code,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git(&code, &["push", "origin", "main"]);
    git(temp, &["clone", remote.to_str().unwrap(), "dev"]);
    let dev = temp.join("dev");
    let folder = code.join("cutready");

    dev_push(&dev, "cutready/nav.md", "nav\n", "#25 nav");
    std::fs::write(folder.join("kickoff.md"), "kickoff\n").unwrap();
    save(&folder, "Kickoff");
    fetch(&folder);
    let mut seth = context(&folder);
    assert!(
        contract::preflight_merge_incoming_with_context(&mut seth, remote_request(&folder))
            .unwrap()
            .can_merge_cleanly
    );
    let merge = |label: &str| {
        contract::merge_incoming_with_context(
            &mut context(&folder),
            contract::MergeIncomingRequest {
                workspace_path: folder.clone(),
                remote: "origin".to_string(),
                label: label.to_string(),
                from_base: false,
            },
        )
        .unwrap_or_else(|error| panic!("merge {label}: {error}"));
    };
    merge("Bring in team updates\n\n- #25 nav (Dev)");

    std::fs::write(folder.join("outline.md"), "outline\n").unwrap();
    save(&folder, "initial outline");
    for n in [28, 29, 30] {
        dev_push(
            &dev,
            &format!("cutready/team-{n}.md"),
            "x\n",
            &format!("#{n} team"),
        );
    }
    fetch(&folder);
    let report =
        contract::preflight_rebase_incoming_with_context(&mut seth, remote_request(&folder))
            .unwrap();
    assert!(
        !report.can_rebase,
        "the older merge should block the replay: {report:?}"
    );
    contract::preflight_merge_incoming_with_context(&mut seth, remote_request(&folder)).unwrap();
    merge("chore(sync): bring in team updates (#30, #29, #28…)\n\n- #30 team (Dev)\n- #29 team (Dev)\n- #28 team (Dev)");

    let graph = contract::get_workspace_graph_for_variation_with_context(
        &context(&folder),
        contract::WorkspaceGraphVariationRequest {
            workspace_path: folder.clone(),
            variation_id: "main".to_string(),
            options: Default::default(),
        },
    )
    .unwrap();
    let node = |label: &str| {
        graph
            .nodes
            .iter()
            .find(|node| node.version.label.starts_with(label))
            .unwrap_or_else(|| panic!("no {label} in the graph"))
    };
    let tip = node("chore(sync)");
    assert!(tip.is_head && tip.parent_version_ids.len() == 2);
    assert_eq!(
        &tip.parent_version_ids[0],
        node("initial outline").version.id(),
        "the user's line is the first parent"
    );
    for unsent in [
        "chore(sync)",
        "initial outline",
        "Bring in team updates",
        "Kickoff",
    ] {
        assert!(!node(unsent).reachable_from_remote_variation, "{unsent}");
    }
    for shared in ["#30 team", "#29 team", "#28 team", "#25 nav", "#24 setup"] {
        assert!(node(shared).reachable_from_remote_variation, "{shared}");
    }

    // What `reviewRequest` builds from that graph (src/test/reviewRequest.test.ts).
    let body = "Saves in this review:\n- Kickoff\n- initial outline\n\nAlso includes 4 team updates that are already shared; they aren't part of this review.";
    let host = FakeHost::default();
    let requests = host.requests.clone();
    let result = send_for_review_with(
        SendForReviewRequest {
            body: Some(body.to_string()),
            ..send_request(&folder, "initial outline")
        },
        |_| Ok(Box::new(host)),
        &mut RemoteOptions::new(),
    )
    .unwrap();
    assert_eq!(result.variation, "cutready/initial-outline");
    let requests = requests.lock().unwrap();
    assert_eq!(requests[0].head, "cutready/initial-outline");
    assert_eq!(requests[0].title, "initial outline");
    assert_eq!(requests[0].body, body);
}
