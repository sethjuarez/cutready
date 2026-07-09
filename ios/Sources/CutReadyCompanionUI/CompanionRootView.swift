import CutReadyMobileCore
import MarkdownUI
import SwiftUI
import WebKit
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

public struct CompanionRootView: View {
    @State private var project: CompanionProject?
    @State private var githubClientID: String
    @State private var githubAccessToken: String?
    @State private var githubDeviceAuthorization: GitHubDeviceAuthorization?
    @State private var githubRepositories: [GitHubRepositorySummary] = []
    @State private var githubRepositorySearchText = ""
    @State private var recentWorkspaces: [RecentWorkspace] = []
    @State private var isSigningIn = false
    @State private var isLoadingRepositories = false
    @State private var isOpeningWorkspace = false
    @State private var isShowingWorkspaceMenu = false
    @State private var isShowingRepositories = false
    @State private var isShowingSync = false
    @State private var isSyncingWorkspace = false
    @State private var syncProgressMessage = "Syncing"
    @State private var isConfirmingParkAndReload = false
    @State private var syncError: String?
    @State private var syncConflicts: [MobileConflict] = []
    @State private var syncStatusGeneration = 0
    @State private var workspaceNavigationPath = NavigationPath()
    @State private var authError: String?
    @State private var workspaceOpenProgress: GitHubWorkspaceOpenProgress?
    @State private var draftlineStore = DraftlineMobileWorkspaceStore()
    private let tokenStore = KeychainTokenStore()
    private let recentWorkspaceStore = RecentWorkspaceStore()

    public init(project: CompanionProject? = nil) {
        _project = State(initialValue: project)
        _githubClientID = State(initialValue: CompanionRootView.githubClientIDFromEnvironment())
    }

    public var body: some View {
        Group {
            if let project {
                NavigationStack(path: $workspaceNavigationPath) {
                    WorkspaceProjectsView(
                        project: project,
                        onOpenMenu: { isShowingWorkspaceMenu = true },
                        onOpenSync: { isShowingSync = true }
                    )
                    .navigationDestination(for: CompanionSelection.self) { selection in
                        workspaceDestination(selection, workspace: project)
                    }
                }
                .sheet(isPresented: $isShowingWorkspaceMenu) {
                    WorkspaceMenuView(
                        project: project,
                        recentWorkspaces: recentWorkspaces,
                        onOpenRecent: { workspace in
                            isShowingWorkspaceMenu = false
                            openGitHubWorkspace(workspace.repository)
                        },
                        onHome: {
                            self.project = nil
                            workspaceNavigationPath = NavigationPath()
                            isShowingWorkspaceMenu = false
                        },
                        onOpenWorkspace: {
                            isShowingWorkspaceMenu = false
                            showGitHubWorkspacePicker()
                        }
                    )
                }
                .sheet(isPresented: $isShowingSync) {
                    WorkspaceSyncSheet(
                        project: project,
                        isSyncing: isSyncingWorkspace,
                        progressMessage: syncProgressMessage,
                        errorMessage: syncError,
                        conflicts: syncConflicts,
                        onSyncNow: { syncWorkspace() },
                        onRefresh: { refreshSyncStatus() },
                        onPull: { pullWorkspace() },
                        onPush: { pushWorkspace() },
                        onResolveConflicts: { resolutions in
                            resolveWorkspaceConflicts(resolutions)
                        },
                        onParkAndReload: { isConfirmingParkAndReload = true }
                    )
                }
                .alert("Park mobile edits?", isPresented: $isConfirmingParkAndReload) {
                    Button("Cancel", role: .cancel) {}
                    Button("Park and reload latest", role: .destructive) {
                        parkMobileEditsAndReloadLatest()
                    }
                } message: {
                    Text("CutReady will first verify a fresh GitHub copy can open, then move this local mobile workspace aside and reload the latest remote work. Parked edits stay in this app's local storage on this device until CutReady adds a recovery/export view.")
                }
            } else {
                WorkspaceLandingView(
                    isSigningIn: isSigningIn,
                    isOpeningWorkspace: isOpeningWorkspace,
                    workspaceOpenProgress: workspaceOpenProgress,
                    canAddWorkspace: githubAccessToken != nil,
                    recentWorkspaces: recentWorkspaces,
                    onSignIn: { beginGitHubSignIn() },
                    onAddWorkspace: { showGitHubWorkspacePicker() },
                    onOpenRecent: { workspace in
                        openGitHubWorkspace(workspace.repository)
                    }
                )
            }
        }
        .tint(CutReadyTheme.accent)
        .task {
            restoreGitHubToken()
            recentWorkspaces = recentWorkspaceStore.load()
        }
        .sheet(item: $githubDeviceAuthorization) { authorization in
            GitHubDeviceAuthorizationView(authorization: authorization)
        }
        .sheet(isPresented: $isShowingRepositories) {
            GitHubRepositoryPicker(
                searchText: $githubRepositorySearchText,
                repositories: githubRepositories,
                isLoadingRepositories: isLoadingRepositories,
                isOpeningWorkspace: isOpeningWorkspace,
                workspaceOpenProgress: workspaceOpenProgress,
                onSearch: { query in
                    await searchGitHubRepositories(query: query)
                },
                onOpenInput: { input in
                    await openGitHubWorkspace(input: input)
                },
                onOpen: { repository in
                    openGitHubWorkspace(repository)
                }
            )
        }
        .alert("GitHub workspace issue", isPresented: Binding(
            get: { authError != nil },
            set: { if !$0 { authError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(authError ?? "")
        }
    }

    private static func githubClientIDFromEnvironment() -> String {
        let environmentClientID = ProcessInfo.processInfo.environment["CUTREADY_GITHUB_OAUTH_CLIENT_ID"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let environmentClientID, !environmentClientID.isEmpty {
            return environmentClientID
        }

        let bundledClientID = (Bundle.main.object(forInfoDictionaryKey: "CUTREADY_GITHUB_OAUTH_CLIENT_ID") as? String)
            ?? (Bundle.main.object(forInfoDictionaryKey: "CutReadyGitHubOAuthClientID") as? String)
        if let bundledClientID {
            let trimmedBundledClientID = bundledClientID.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmedBundledClientID.isEmpty {
                return trimmedBundledClientID
            }
        }

        guard let configURL = Bundle.main.url(forResource: "CutReadyConfig", withExtension: "plist"),
              let config = NSDictionary(contentsOf: configURL),
              let configClientID = config["CUTREADY_GITHUB_OAUTH_CLIENT_ID"] as? String else {
            return ""
        }

        return configClientID.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func restoreGitHubToken() {
        guard githubAccessToken == nil else {
            return
        }

        do {
            githubAccessToken = try tokenStore.readToken()
        } catch {
            authError = describeGitHubError(error)
        }
    }

    private func beginGitHubSignIn() {
        Task {
            do {
                isSigningIn = true
                let client = GitHubMobileClient(clientID: githubClientID)
                let authorization = try await client.requestDeviceAuthorization(scopes: ["repo"])
                githubDeviceAuthorization = authorization

                let token = try await pollGitHubToken(client: client, authorization: authorization)
                githubAccessToken = token.accessToken
                try tokenStore.saveToken(token.accessToken)
                githubDeviceAuthorization = nil
                githubRepositories = []
                githubRepositorySearchText = ""
                isShowingRepositories = true
            } catch {
                githubDeviceAuthorization = nil
                authError = describeGitHubError(error)
            }
            isSigningIn = false
        }
    }

    private func showGitHubWorkspacePicker() {
        guard githubAccessToken != nil else {
            authError = "Sign in with GitHub before switching workspaces."
            return
        }

        isShowingRepositories = true
        githubRepositorySearchText = ""
        githubRepositories = []
    }

    @MainActor
    private func searchGitHubRepositories(query: String) async {
        guard let githubAccessToken else {
            return
        }

        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard normalizedQuery.count >= 2 else {
            githubRepositories = []
            isLoadingRepositories = false
            return
        }

        do {
            isLoadingRepositories = true
            defer { isLoadingRepositories = false }
            let client = GitHubMobileClient()
            let repositories = try await client.searchRepositories(accessToken: githubAccessToken, query: normalizedQuery, limit: 20)
            guard !Task.isCancelled, normalizedQuery == githubRepositorySearchText.trimmingCharacters(in: .whitespacesAndNewlines) else {
                return
            }
            githubRepositories = repositories
        } catch {
            guard !isCancellationError(error) else {
                return
            }
            authError = describeGitHubError(error)
        }
    }

    @MainActor
    private func openGitHubWorkspace(input: String) async {
        guard let githubAccessToken else {
            authError = "Sign in with GitHub before opening a workspace."
            return
        }
        guard let specifier = GitHubRepositorySpecifier(input: input) else {
            authError = "Enter a GitHub repository as owner/name or paste a github.com repository URL."
            return
        }

        do {
            isOpeningWorkspace = true
            let client = GitHubMobileClient()
            let repository = try await client.repository(accessToken: githubAccessToken, specifier: specifier)
            openGitHubWorkspace(repository)
        } catch {
            isOpeningWorkspace = false
            authError = describeGitHubError(error)
        }
    }

    private func pollGitHubToken(
        client: GitHubMobileClient,
        authorization: GitHubDeviceAuthorization
    ) async throws -> GitHubAccessToken {
        let startedAt = Date()
        var interval = authorization.interval

        while Date().timeIntervalSince(startedAt) < authorization.expiresIn {
            try await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
            do {
                return try await client.pollAccessToken(deviceCode: authorization.deviceCode)
            } catch GitHubMobileError.authorizationPending {
                continue
            } catch GitHubMobileError.api(let message) where message == "slow_down" {
                interval += 5
                continue
            }
        }

        throw GitHubMobileError.authorizationExpired
    }

    private func openGitHubWorkspace(_ repository: GitHubRepositorySummary) {
        guard let githubAccessToken else {
            authError = "Sign in with GitHub before opening a workspace."
            return
        }

        Task {
            do {
                isOpeningWorkspace = true
                let snapshot = try await draftlineStore.openWorkspace(
                    repository: repository,
                    accessToken: githubAccessToken,
                    progress: { progress in
                        Task { @MainActor in
                            workspaceOpenProgress = progress
                        }
                    }
                )
                project = CompanionProject(snapshot: snapshot)
                workspaceNavigationPath = NavigationPath()
                recentWorkspaceStore.record(repository: repository)
                recentWorkspaces = recentWorkspaceStore.load()
                isShowingRepositories = false
                refreshSyncStatus()
            } catch {
                authError = describeGitHubError(error)
            }
            workspaceOpenProgress = nil
            isOpeningWorkspace = false
        }
    }

    @ViewBuilder
    private func workspaceDestination(_ selection: CompanionSelection, workspace: CompanionProject) -> some View {
        switch selection {
        case .project(let projectPath):
            ProjectContentsView(project: workspace.switchingProject(to: projectPath))
        case .note(let path):
            NoteDetailView(
                path: path,
                note: note(for: path, in: workspace),
                fallbackTitle: title(for: path, in: workspace.allNotes),
                syncStatus: workspace.syncStatus,
                onOpenSync: { isShowingSync = true },
                onSave: { markdown in
                    try await saveNote(markdown, path: path)
                }
            )
        case .sketch(let path):
            SketchDetailView(
                path: path,
                sketch: sketch(for: path, in: workspace),
                fallbackTitle: title(for: path, in: workspace.allSketches),
                project: workspace,
                githubAccessToken: githubAccessToken,
                syncStatus: workspace.syncStatus,
                loadAsset: { path in
                    try await draftlineStore.readAsset(path: path)
                },
                onOpenSync: { isShowingSync = true },
                onSave: { sketch in
                    try await saveSketch(sketch, path: path)
                }
            )
        case .storyboard(let path):
            StoryboardDetailView(
                path: path,
                storyboard: storyboard(for: path, in: workspace),
                fallbackTitle: title(for: path, in: workspace.allStoryboards),
                project: workspace
            )
        case .rehearse:
            RehearsalPreview(project: workspace)
        }
    }

    private func storyboard(for path: String, in workspace: CompanionProject) -> FileSummary? {
        workspace.allStoryboards.first { $0.path == path }
    }

    private func sketch(for path: String, in workspace: CompanionProject) -> FileSummary? {
        workspace.allSketches.first { $0.path == path }
    }

    private func note(for path: String, in workspace: CompanionProject) -> FileSummary? {
        workspace.allNotes.first { $0.path == path }
    }

    private func title(for path: String, in summaries: [FileSummary]) -> String {
        summaries.first { $0.path == path }?.title ?? path
    }

    private func saveNote(_ markdown: String, path: String) async throws {
        let snapshot = try await draftlineStore.saveNote(markdown, path: path)
        await MainActor.run {
            syncStatusGeneration += 1
            let dirtyStatus = MobileSyncStatus(state: .dirty, ahead: max((project?.syncStatus.ahead ?? 0), 1), message: "Mobile snapshot ready to push")
            syncConflicts = []
            if let project {
                var updated = project.updating(from: snapshot)
                updated.syncStatus = dirtyStatus
                self.project = updated
            } else {
                var updated = CompanionProject(snapshot: snapshot)
                updated.syncStatus = dirtyStatus
                self.project = updated
            }
        }
    }

    private func saveSketch(_ sketch: Sketch, path: String) async throws {
        let snapshot = try await draftlineStore.saveSketch(sketch, path: path)
        await MainActor.run {
            syncStatusGeneration += 1
            let dirtyStatus = MobileSyncStatus(state: .dirty, ahead: max((project?.syncStatus.ahead ?? 0), 1), message: "Mobile snapshot ready to push")
            syncConflicts = []
            if let project {
                var updated = project.updating(from: snapshot)
                updated.syncStatus = dirtyStatus
                self.project = updated
            } else {
                var updated = CompanionProject(snapshot: snapshot)
                updated.syncStatus = dirtyStatus
                self.project = updated
            }
        }
    }

    private func refreshSyncStatus() {
        Task {
            let generation = await MainActor.run { () -> Int? in
                guard beginWorkspaceOperation(message: "Checking GitHub for shared changes") else {
                    return nil
                }
                return syncStatusGeneration
            }
            guard let generation else {
                return
            }
            do {
                let status = try await draftlineStore.syncStatus()
                if status.state == .conflict {
                    await MainActor.run { updateWorkspaceOperationMessage("Preparing change review") }
                }
                let conflicts = await conflicts(for: status)
                await MainActor.run {
                    guard generation == syncStatusGeneration else {
                        return
                    }
                    updateSyncStatus(status, conflicts: conflicts)
                }
            } catch {
                await MainActor.run {
                    guard generation == syncStatusGeneration else {
                        return
                    }
                    syncError = error.localizedDescription
                }
            }
            await MainActor.run { finishWorkspaceOperation() }
        }
    }

    private func syncWorkspace() {
        Task {
            let didStart = await MainActor.run { beginWorkspaceOperation(message: "Checking sync direction") }
            guard didStart else {
                return
            }
            do {
                let (status, snapshot) = try await draftlineStore.syncNow()
                await MainActor.run {
                    updateWorkspaceOperationMessage(status.state == .conflict ? "Preparing change review" : "Updating workspace view")
                }
                let conflicts = await conflicts(for: status)
                await MainActor.run {
                    applyWorkspaceSync(status: status, snapshot: snapshot, conflicts: conflicts)
                    if status.state == .clean {
                        isShowingSync = false
                    }
                }
            } catch {
                await MainActor.run { syncError = error.localizedDescription }
            }
            await MainActor.run { finishWorkspaceOperation() }
        }
    }

    private func pullWorkspace() {
        Task {
            let didStart = await MainActor.run { beginWorkspaceOperation(message: "Pulling latest shared changes") }
            guard didStart else {
                return
            }
            do {
                let (status, snapshot) = try await draftlineStore.pull()
                await MainActor.run {
                    updateWorkspaceOperationMessage(status.state == .conflict ? "Preparing change review" : "Updating workspace view")
                }
                let conflicts = await conflicts(for: status)
                await MainActor.run { applyWorkspaceSync(status: status, snapshot: snapshot, conflicts: conflicts) }
            } catch {
                await MainActor.run { syncError = error.localizedDescription }
            }
            await MainActor.run { finishWorkspaceOperation() }
        }
    }

    private func pushWorkspace() {
        Task {
            let didStart = await MainActor.run { beginWorkspaceOperation(message: "Publishing mobile snapshot") }
            guard didStart else {
                return
            }
            do {
                let (status, snapshot) = try await draftlineStore.push()
                await MainActor.run {
                    updateWorkspaceOperationMessage(status.state == .conflict ? "Preparing change review" : "Updating workspace view")
                }
                let conflicts = await conflicts(for: status)
                await MainActor.run { applyWorkspaceSync(status: status, snapshot: snapshot, conflicts: conflicts) }
            } catch {
                await MainActor.run { syncError = error.localizedDescription }
            }
            await MainActor.run { finishWorkspaceOperation() }
        }
    }

    private func parkMobileEditsAndReloadLatest() {
        Task {
            guard let project, let githubAccessToken else {
                await MainActor.run { syncError = "Sign in with GitHub before reloading this workspace." }
                return
            }
            guard case .github(let repositoryRef) = project.source else {
                await MainActor.run { syncError = "Only GitHub-backed workspaces can be reloaded from mobile." }
                return
            }

            let repository = GitHubRepositorySummary(
                id: 0,
                name: repositoryRef.name,
                fullName: repositoryRef.displayName,
                isPrivate: false,
                defaultBranch: repositoryRef.defaultBranch ?? "main",
                updatedAt: nil
            )

            let didStart = await MainActor.run { beginWorkspaceOperation(message: "Parking mobile edits and reloading latest") }
            guard didStart else {
                return
            }
            do {
                let snapshot = try await draftlineStore.parkLocalEditsAndReloadLatest(
                    repository: repository,
                    accessToken: githubAccessToken
                )
                await MainActor.run {
                    syncStatusGeneration += 1
                    self.project = CompanionProject(snapshot: snapshot)
                    workspaceNavigationPath = NavigationPath()
                    syncConflicts = []
                    syncError = nil
                    isShowingSync = false
                }
                await MainActor.run { finishWorkspaceOperation() }
                refreshSyncStatus()
            } catch {
                await MainActor.run {
                    syncError = error.localizedDescription
                    finishWorkspaceOperation()
                }
            }
        }
    }

    private func resolveWorkspaceConflicts(_ resolutions: [MobileConflictResolutionRequest]) {
        Task {
            let didStart = await MainActor.run { beginWorkspaceOperation(message: "Merging and publishing changes") }
            guard didStart else {
                return
            }
            do {
                let (status, snapshot) = try await draftlineStore.resolveConflicts(resolutions)
                await MainActor.run {
                    updateWorkspaceOperationMessage(
                        status.state == .clean ? "Updating workspace view" : "Checking remaining changes"
                    )
                }
                let conflicts = await conflicts(for: status)
                await MainActor.run {
                    applyWorkspaceSync(status: status, snapshot: snapshot, conflicts: conflicts)
                    if status.state == .clean {
                        isShowingSync = false
                    }
                }
            } catch {
                await MainActor.run { syncError = error.localizedDescription }
            }
            await MainActor.run { finishWorkspaceOperation() }
        }
    }

    @MainActor
    private func beginWorkspaceOperation(message: String) -> Bool {
        guard !isSyncingWorkspace else {
            return false
        }
        syncProgressMessage = message
        isSyncingWorkspace = true
        return true
    }

    @MainActor
    private func finishWorkspaceOperation() {
        isSyncingWorkspace = false
        syncProgressMessage = "Syncing"
    }

    @MainActor
    private func updateWorkspaceOperationMessage(_ message: String) {
        syncProgressMessage = message
    }

    @MainActor
    private func updateSyncStatus(_ status: MobileSyncStatus, conflicts: [MobileConflict]) {
        guard var project else {
            return
        }
        project.syncStatus = status
        self.project = project
        syncConflicts = conflicts
        syncError = nil
    }

    @MainActor
    private func applyWorkspaceSync(status: MobileSyncStatus, snapshot: MobileWorkspaceSnapshot, conflicts: [MobileConflict]) {
        syncStatusGeneration += 1
        if let project {
            var updated = project.updating(from: snapshot)
            updated.syncStatus = status
            self.project = updated
        } else {
            var updated = CompanionProject(snapshot: snapshot)
            updated.syncStatus = status
            self.project = updated
        }
        syncConflicts = conflicts
        syncError = nil
    }

    private func conflicts(for status: MobileSyncStatus) async -> [MobileConflict] {
        guard status.state == .conflict else {
            return []
        }
        return (try? await draftlineStore.listConflicts()) ?? []
    }

    private func describeGitHubError(_ error: Error) -> String {
        if let error = error as? DecodingError {
            return "GitHub returned an unexpected response: \(error.mobileDescription)"
        }
        return error.localizedDescription
    }

    private func isCancellationError(_ error: Error) -> Bool {
        if error is CancellationError {
            return true
        }
        if let error = error as? URLError, error.code == .cancelled {
            return true
        }
        let error = error as NSError
        return error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled
    }
}

private struct WorkspaceProjectsView: View {
    let project: CompanionProject
    let onOpenMenu: () -> Void
    let onOpenSync: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                CompanionCard {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(sourceLabel)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(CutReadyTheme.textSecondary)

                        HStack(spacing: 10) {
                            WorkspaceStatPill(value: "\(project.projects.count)", label: project.projects.count == 1 ? "Project" : "Projects")
                            WorkspaceStatPill(value: "\(project.allStoryboards.count)", label: "Storyboards", tint: CutReadyTheme.storyboard)
                            WorkspaceStatPill(value: "\(project.allSketches.count)", label: "Sketches", tint: CutReadyTheme.sketch)
                            WorkspaceStatPill(value: "\(project.allNotes.count)", label: "Notes", tint: CutReadyTheme.note)
                        }
                    }
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("PROJECTS")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(CutReadyTheme.textSecondary)
                        .tracking(0.8)
                        .padding(.horizontal, 4)

                    VStack(spacing: 0) {
                        ForEach(project.projects) { workspaceProject in
                            NavigationLink(value: CompanionSelection.project(workspaceProject.path)) {
                                ProjectNavigationRow(project: workspaceProject)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .background(CutReadyTheme.surfaceAlt.opacity(0.55), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 22)
        }
        .background(CutReadyTheme.surface)
        .navigationTitle(project.workspaceName)
        .toolbar {
            #if os(iOS)
            ToolbarItem(placement: .navigationBarLeading) {
                workspaceMenuButton
            }

            ToolbarItem(placement: .navigationBarTrailing) {
                syncButton
            }
            #else
            ToolbarItem {
                workspaceMenuButton
            }

            ToolbarItem {
                syncButton
            }
            #endif
        }
    }

    private var workspaceMenuButton: some View {
        Button(action: onOpenMenu) {
            Image(systemName: "line.3.horizontal")
        }
        .accessibilityLabel("Workspace menu")
    }

    private var syncButton: some View {
        Button(action: onOpenSync) {
            Image(systemName: syncSystemImage)
        }
        .accessibilityLabel("Sync workspace")
    }

    private var syncSystemImage: String {
        switch project.syncStatus.state {
        case .clean:
            return "checkmark.icloud"
        case .dirty, .incoming, .pushing, .pulling:
            return "arrow.triangle.2.circlepath"
        case .conflict:
            return "exclamationmark.triangle"
        case .offline:
            return "icloud.slash"
        }
    }

    private var sourceLabel: String {
        switch project.source {
        case .github(let repository):
            return repository.displayName
        }
    }
}

private struct WorkspaceSyncToolbarButton: View {
    let status: MobileSyncStatus
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack(alignment: .topTrailing) {
                Image(systemName: systemImage)
                    .font(.body.weight(.semibold))

                if showsPushBadge {
                    Circle()
                        .fill(CutReadyTheme.storyboard)
                        .frame(width: 8, height: 8)
                        .overlay(Circle().stroke(CutReadyTheme.surface, lineWidth: 1))
                        .offset(x: 4, y: -4)
                }
            }
            .frame(width: 28, height: 28)
        }
        .foregroundStyle(tint)
        .accessibilityLabel(accessibilityLabel)
    }

    private var showsPushBadge: Bool {
        status.state == .dirty && status.ahead > 0
    }

    private var systemImage: String {
        switch status.state {
        case .dirty:
            return "square.and.arrow.up"
        case .incoming, .pulling:
            return "arrow.down.circle"
        case .pushing:
            return "arrow.up.circle"
        case .conflict:
            return "exclamationmark.triangle"
        case .offline:
            return "icloud.slash"
        case .clean:
            return "checkmark.icloud"
        }
    }

    private var tint: Color {
        switch status.state {
        case .dirty:
            return CutReadyTheme.storyboard
        case .incoming, .pulling, .pushing:
            return CutReadyTheme.accent
        case .conflict, .offline:
            return .red
        case .clean:
            return CutReadyTheme.textSecondary
        }
    }

    private var accessibilityLabel: String {
        switch status.state {
        case .dirty:
            return status.ahead > 0 ? "\(status.ahead) mobile snapshot(s) ready to push" : "Mobile edits are ready to push"
        case .incoming:
            return "Incoming workspace changes are ready to pull"
        case .pulling:
            return "Pulling workspace changes"
        case .pushing:
            return "Pushing mobile edits"
        case .conflict:
            return "Workspace sync conflict"
        case .offline:
            return "Workspace sync is offline"
        case .clean:
            return "Workspace is clean"
        }
    }
}

private struct ProjectNavigationRow: View {
    let project: MobileProjectEntry

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "folder")
                .font(.body)
                .foregroundStyle(CutReadyTheme.accent)
                .frame(width: 26)

            VStack(alignment: .leading, spacing: 4) {
                Text(project.name)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(CutReadyTheme.text)
                    .lineLimit(2)

                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(CutReadyTheme.textSecondary)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(CutReadyTheme.textSecondary.opacity(0.55))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 11)
        .contentShape(Rectangle())
    }

    private var subtitle: String {
        if let description = project.description, !description.isEmpty {
            return description
        }

        return project.path == "." ? "Workspace root project" : project.path
    }
}

private struct WorkspaceSyncSheet: View {
    let project: CompanionProject
    let isSyncing: Bool
    let progressMessage: String
    let errorMessage: String?
    let conflicts: [MobileConflict]
    let onSyncNow: () -> Void
    let onRefresh: () -> Void
    let onPull: () -> Void
    let onPush: () -> Void
    let onResolveConflicts: ([MobileConflictResolutionRequest]) -> Void
    let onParkAndReload: () -> Void

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                statusCard
                errorSection
                conflictSection
                actionButtons

                Spacer()
            }
            .padding(18)
            .background(CutReadyTheme.surface)
            .navigationTitle("Sync")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .overlay {
                if isSyncing {
                    VStack(spacing: 12) {
                        ProgressView()
                        Text(progressMessage)
                            .font(.callout.weight(.medium))
                            .multilineTextAlignment(.center)
                            .foregroundStyle(CutReadyTheme.text)
                    }
                    .frame(maxWidth: 260)
                    .padding()
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
            }
        }
    }

    private var statusCard: some View {
        CompanionCard {
            VStack(alignment: .leading, spacing: 10) {
                Label(statusTitle, systemImage: statusIcon)
                    .font(.headline)
                    .foregroundStyle(statusTint)

                HStack(spacing: 10) {
                    WorkspaceStatPill(value: "\(project.syncStatus.ahead)", label: "Ahead", tint: CutReadyTheme.accent)
                    WorkspaceStatPill(value: "\(project.syncStatus.behind)", label: "Behind", tint: CutReadyTheme.storyboard)
                }

                if let message = project.syncStatus.message, !message.isEmpty {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(CutReadyTheme.textSecondary)
                        .lineLimit(5)
                }
            }
        }
    }

    @ViewBuilder
    private var errorSection: some View {
        if let errorMessage {
            Text(errorMessage)
                .font(.caption)
                .foregroundStyle(.red)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
    }

    @ViewBuilder
    private var conflictSection: some View {
        if !conflicts.isEmpty {
            CompanionCard {
                VStack(alignment: .leading, spacing: 10) {
                    Label("Review shared changes", systemImage: "rectangle.2.swap")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(CutReadyTheme.accent)

                    Text("Some items changed on this device and in the shared workspace. Choose the version to keep for each item, or create a custom version.")
                        .font(.caption)
                        .foregroundStyle(CutReadyTheme.textSecondary)

                    if canResolveConflictsOnMobile, conflicts.contains(where: \.needsUserChoice) {
                        NavigationLink {
                            MobileConflictResolutionWizard(
                                conflicts: conflicts.filter(\.needsUserChoice),
                                onApply: onResolveConflicts
                            )
                        } label: {
                            syncLabel("Review changes", systemImage: "checklist")
                        }
                        .buttonStyle(.borderedProminent)
                    } else if canResolveConflictsOnMobile {
                        Button {
                            onResolveConflicts([])
                        } label: {
                            syncLabel("Keep latest shared version", systemImage: "arrow.down.doc")
                        }
                        .buttonStyle(.borderedProminent)
                    } else {
                        Text("Some local file changes need the fallback recovery path before sync can continue.")
                            .font(.caption)
                            .foregroundStyle(CutReadyTheme.textSecondary)
                    }

                    ForEach(conflicts) { conflict in
                        conflictRow(conflict)
                    }
                }
            }
        } else if project.syncStatus.state == .conflict {
            CompanionCard {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Shared changes can be merged automatically.")
                        .font(.caption)
                        .foregroundStyle(CutReadyTheme.textSecondary)

                    Button {
                        onResolveConflicts([])
                    } label: {
                        syncLabel("Merge shared changes", systemImage: "arrow.triangle.merge")
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
        }
    }

    private var canResolveConflictsOnMobile: Bool {
        !conflicts.isEmpty && conflicts.allSatisfy(\.canResolveOnMobile)
    }

    private func conflictRow(_ conflict: MobileConflict) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(conflict.path)
                .font(.caption.monospaced())
                .foregroundStyle(CutReadyTheme.text)
                .lineLimit(2)

            Text(conflict.summary)
                .font(.caption2)
                .foregroundStyle(CutReadyTheme.textSecondary)
                .lineLimit(3)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CutReadyTheme.surfaceAlt.opacity(0.65), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var actionButtons: some View {
        VStack(spacing: 10) {
            Button(action: onSyncNow) {
                syncLabel(primarySyncTitle, systemImage: primarySyncIcon)
            }
            .buttonStyle(.borderedProminent)
            .disabled(project.syncStatus.state == .conflict)

            Button(action: onRefresh) {
                syncLabel("Refresh status", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.bordered)

            Button(action: onPull) {
                syncLabel("Pull latest", systemImage: "arrow.down.circle")
            }
            .buttonStyle(.bordered)

            Button(action: onPush) {
                syncLabel("Push mobile snapshot", systemImage: "arrow.up.circle")
            }
            .buttonStyle(.bordered)
            .disabled(project.syncStatus.state == .conflict)

            if canParkAndReload {
                Button(action: onParkAndReload) {
                    syncLabel("Park mobile edits and reload latest", systemImage: "tray.and.arrow.down")
                }
                .buttonStyle(.bordered)
                .tint(CutReadyTheme.storyboard)
            }
        }
        .controlSize(.large)
        .disabled(isSyncing)
    }

    private var canParkAndReload: Bool {
        project.syncStatus.state == .conflict
            && (project.syncStatus.ahead > 0 || conflicts.contains { !$0.canResolveOnMobile })
    }

    private var primarySyncTitle: String {
        switch project.syncStatus.state {
        case .dirty:
            return "Sync now - push mobile edits"
        case .incoming:
            return "Sync now - pull latest"
        case .conflict:
            return "Review changes first"
        case .offline:
            return "Sync unavailable offline"
        case .pulling:
            return "Pulling latest"
        case .pushing:
            return "Pushing mobile edits"
        case .clean:
            return "Sync now"
        }
    }

    private var primarySyncIcon: String {
        switch project.syncStatus.state {
        case .dirty:
            return "square.and.arrow.up"
        case .incoming:
            return "arrow.down.circle"
        case .conflict:
            return "exclamationmark.triangle"
        case .offline:
            return "icloud.slash"
        case .pulling:
            return "arrow.down.circle"
        case .pushing:
            return "arrow.up.circle"
        case .clean:
            return "arrow.triangle.2.circlepath"
        }
    }

    private var statusTitle: String {
        switch project.syncStatus.state {
        case .clean:
            return "Workspace is clean"
        case .dirty:
            return "Mobile edits are ready"
        case .incoming:
            return "Incoming changes are ready"
        case .pulling:
            return "Pulling latest"
        case .pushing:
            return "Publishing mobile edits"
        case .conflict:
            return "Review changes"
        case .offline:
            return "Offline"
        }
    }

    private var statusIcon: String {
        switch project.syncStatus.state {
        case .clean:
            return "checkmark.circle"
        case .dirty:
            return "pencil.circle"
        case .incoming:
            return "arrow.down.circle"
        case .pulling:
            return "arrow.down.circle"
        case .pushing:
            return "arrow.up.circle"
        case .conflict:
            return "exclamationmark.triangle"
        case .offline:
            return "icloud.slash"
        }
    }

    private var statusTint: Color {
        switch project.syncStatus.state {
        case .clean:
            return CutReadyTheme.accent
        case .dirty, .incoming, .pulling, .pushing:
            return CutReadyTheme.storyboard
        case .conflict, .offline:
            return .red
        }
    }

    private func syncLabel(_ title: String, systemImage: String) -> some View {
        Label(title, systemImage: systemImage)
            .frame(maxWidth: .infinity)
    }
}

private struct MobileConflictResolutionWizard: View {
    let conflicts: [MobileConflict]
    let onApply: ([MobileConflictResolutionRequest]) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var choices: [String: MobileConflictResolutionChoice] = [:]
    @State private var customContents: [String: String] = [:]

    private var groups: [MobileConflictGroup] {
        Dictionary(grouping: conflicts, by: \.path)
            .map { path, conflicts in
                MobileConflictGroup(path: path, conflicts: conflicts.sorted { $0.label < $1.label })
            }
            .sorted { $0.title < $1.title }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                CompanionCard {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("Choose what to keep", systemImage: "rectangle.2.swap")
                            .font(.headline)
                            .foregroundStyle(CutReadyTheme.accent)
                        Text("These items changed on this device and in the shared workspace. Pick my version, the latest shared version, or create a custom version for each item.")
                            .font(.caption)
                            .foregroundStyle(CutReadyTheme.textSecondary)
                    }
                }

                ForEach(groups) { group in
                    conflictGroupCard(group)
                }
            }
            .padding(18)
        }
        .background(CutReadyTheme.surface)
        .navigationTitle("Review changes")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Apply choices") {
                    onApply(resolutions)
                    dismiss()
                }
                .disabled(!canApply)
            }
        }
    }

    private func conflictGroupCard(_ group: MobileConflictGroup) -> some View {
        CompanionCard {
            VStack(alignment: .leading, spacing: 12) {
                Label(group.title, systemImage: group.icon)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(group.tint)

                Picker("Version", selection: choiceBinding(for: group)) {
                    Text("My version").tag(MobileConflictResolutionChoice.myVersion)
                    Text("Latest shared").tag(MobileConflictResolutionChoice.latestShared)
                    Text("Custom").tag(MobileConflictResolutionChoice.custom)
                }
                .pickerStyle(.segmented)

                selectedVersionPreview(for: group)

                if choices[group.path] == .custom {
                    ForEach(group.conflicts) { conflict in
                        VStack(alignment: .leading, spacing: 6) {
                            if group.conflicts.count > 1 {
                                Text(conflict.label)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(CutReadyTheme.textSecondary)
                            }
                            TextEditor(text: customContentBinding(for: conflict))
                                .font(.body)
                                .frame(minHeight: 120)
                                .padding(8)
                                .background(CutReadyTheme.surfaceAlt.opacity(0.7), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func selectedVersionPreview(for group: MobileConflictGroup) -> some View {
        switch choices[group.path] ?? .myVersion {
        case .myVersion:
            versionPreview(title: "My version", conflicts: group.conflicts, keyPath: \.mine)
        case .latestShared:
            versionPreview(title: "Latest shared version", conflicts: group.conflicts, keyPath: \.latestShared)
        case .custom:
            Text("Edit the custom version below. This is what CutReady will keep for this item.")
                .font(.caption)
                .foregroundStyle(CutReadyTheme.textSecondary)
        }
    }

    private func versionPreview(
        title: String,
        conflicts: [MobileConflict],
        keyPath: KeyPath<MobileConflict, String?>
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(CutReadyTheme.textSecondary)
            ForEach(conflicts) { conflict in
                Text(conflict[keyPath: keyPath] ?? "No content in this version.")
                    .font(.caption)
                    .foregroundStyle(CutReadyTheme.text)
                    .lineLimit(6)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(CutReadyTheme.surfaceAlt.opacity(0.55), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        }
    }

    private var canApply: Bool {
        groups.allSatisfy { group in
            let choice = choices[group.path] ?? .myVersion
            guard choice == .custom else {
                return true
            }
            return group.conflicts.allSatisfy { conflict in
                !(customContents[conflict.id] ?? defaultCustomContent(for: conflict)).isEmpty
            }
        }
    }

    private var resolutions: [MobileConflictResolutionRequest] {
        groups.flatMap { group in
            let choice = choices[group.path] ?? .myVersion
            return group.conflicts.map { conflict in
                MobileConflictResolutionRequest(
                    path: conflict.path,
                    fieldPath: conflict.fieldPath,
                    choice: choice,
                    customContent: choice == .custom ? customContent(for: conflict) : nil
                )
            }
        }
    }

    private func choiceBinding(for group: MobileConflictGroup) -> Binding<MobileConflictResolutionChoice> {
        Binding(
            get: { choices[group.path] ?? .myVersion },
            set: { choices[group.path] = $0 }
        )
    }

    private func customContentBinding(for conflict: MobileConflict) -> Binding<String> {
        Binding(
            get: { customContent(for: conflict) },
            set: { customContents[conflict.id] = $0 }
        )
    }

    private func customContent(for conflict: MobileConflict) -> String {
        customContents[conflict.id] ?? defaultCustomContent(for: conflict)
    }

    private func defaultCustomContent(for conflict: MobileConflict) -> String {
        conflict.mine ?? conflict.latestShared ?? ""
    }
}

private struct MobileConflictGroup: Identifiable {
    var path: String
    var conflicts: [MobileConflict]

    var id: String { path }

    var title: String {
        (path as NSString).lastPathComponent
    }

    var icon: String {
        switch (path as NSString).pathExtension.lowercased() {
        case "md":
            return "doc.text"
        case "sk":
            return "list.bullet.rectangle"
        case "sb":
            return "rectangle.stack"
        default:
            return "doc"
        }
    }

    var tint: Color {
        switch (path as NSString).pathExtension.lowercased() {
        case "md":
            return CutReadyTheme.note
        case "sk":
            return CutReadyTheme.sketch
        case "sb":
            return CutReadyTheme.storyboard
        default:
            return CutReadyTheme.accent
        }
    }
}

private struct ProjectContentsView: View {
    let project: CompanionProject

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                CompanionCard {
                    HStack(spacing: 10) {
                        WorkspaceStatPill(value: "\(project.storyboards.count)", label: "Storyboards", tint: CutReadyTheme.storyboard)
                        WorkspaceStatPill(value: "\(project.sketches.count)", label: "Sketches", tint: CutReadyTheme.sketch)
                        WorkspaceStatPill(value: "\(project.notes.count)", label: "Notes", tint: CutReadyTheme.note)
                    }
                }

                if !project.storyboards.isEmpty {
                    DocumentSection(title: "Storyboards") {
                        ForEach(project.storyboards) { storyboard in
                            NavigationLink(value: CompanionSelection.storyboard(storyboard.path)) {
                                DenseDocumentRow(
                                    title: storyboard.title,
                                    icon: CutReadyIconAsset.storyboard,
                                    tint: CutReadyTheme.storyboard
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                if !project.sketches.isEmpty {
                    DocumentSection(title: "Sketches") {
                        ForEach(project.sketches) { sketch in
                            NavigationLink(value: CompanionSelection.sketch(sketch.path)) {
                                DenseDocumentRow(
                                    title: sketch.title,
                                    icon: CutReadyIconAsset.sketch,
                                    tint: CutReadyTheme.sketch
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                if !project.notes.isEmpty {
                    DocumentSection(title: "Notes") {
                        ForEach(project.notes) { note in
                            NavigationLink(value: CompanionSelection.note(note.path)) {
                                DenseDocumentRow(
                                    title: note.title,
                                    icon: CutReadyIconAsset.note,
                                    tint: CutReadyTheme.note
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                if project.storyboards.isEmpty && project.sketches.isEmpty && project.notes.isEmpty {
                    ContentUnavailableView(
                        "No project items",
                        systemImage: "folder",
                        description: Text("This CutReady project does not contain supported mobile documents yet.")
                    )
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 22)
        }
        .background(CutReadyTheme.surface)
        .navigationTitle(project.name)
    }
}

private struct DocumentSection<Content: View>: View {
    let title: String
    let content: Content

    init(title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title.uppercased())
                .font(.caption.weight(.semibold))
                .foregroundStyle(CutReadyTheme.textSecondary)
                .tracking(0.8)
                .padding(.horizontal, 4)

            VStack(spacing: 0) {
                content
            }
            .background(CutReadyTheme.surfaceAlt.opacity(0.55), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
    }
}

private struct DenseDocumentRow: View {
    let title: String
    let icon: String
    let tint: Color

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            CutReadyDocumentIcon(icon, tint: tint, size: 21)
                .frame(width: 26)
                .padding(.top, 1)

            Text(title)
                .font(.body.weight(.medium))
                .foregroundStyle(tint)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)

            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(CutReadyTheme.textSecondary.opacity(0.55))
                .padding(.top, 4)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }
}

private struct WorkspaceStatPill: View {
    let value: String
    let label: String
    var tint: Color = CutReadyTheme.accent

    var body: some View {
        VStack(spacing: 3) {
            Text(value)
                .font(.subheadline.monospacedDigit().weight(.semibold))
                .foregroundStyle(tint)
            Text(label)
                .font(.caption2.weight(.medium))
                .foregroundStyle(CutReadyTheme.textSecondary)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 7)
        .background(tint.opacity(0.10), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

private struct WorkspaceMenuView: View {
    let project: CompanionProject
    let recentWorkspaces: [RecentWorkspace]
    let onOpenRecent: (RecentWorkspace) -> Void
    let onHome: () -> Void
    let onOpenWorkspace: () -> Void

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button(action: onOpenWorkspace) {
                        Label("Open Another Workspace", systemImage: "plus")
                    }
                }

                Section("Current workspace") {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(project.workspaceName)
                            .font(.headline)
                            .foregroundStyle(CutReadyTheme.text)
                        Text(sourceLabel)
                            .font(.caption)
                            .foregroundStyle(CutReadyTheme.textSecondary)
                    }
                    .padding(.vertical, 4)
                }

                Section("Recently opened") {
                    if otherRecentWorkspaces.isEmpty {
                        Text("Other workspaces you open will appear here.")
                            .font(.caption)
                            .foregroundStyle(CutReadyTheme.textSecondary)
                    } else {
                        ForEach(otherRecentWorkspaces) { workspace in
                            Button {
                                onOpenRecent(workspace)
                            } label: {
                                RecentWorkspaceMenuRow(workspace: workspace)
                            }
                        }
                    }
                }

                Section {
                    Button(action: onHome) {
                        Label("Home", systemImage: "house")
                    }
                }
            }
            .navigationTitle("Workspace")
        }
    }

    private var otherRecentWorkspaces: [RecentWorkspace] {
        recentWorkspaces.filter { workspace in
            workspace.repository.fullName != sourceLabel
        }
    }

    private var sourceLabel: String {
        switch project.source {
        case .github(let repository):
            return repository.displayName
        }
    }

}

private struct RecentWorkspaceMenuRow: View {
    let workspace: RecentWorkspace

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: "clock.arrow.circlepath")
                .foregroundStyle(CutReadyTheme.accent)
                .frame(width: 24)

            VStack(alignment: .leading, spacing: 4) {
                Text(workspace.repository.name)
                    .font(.headline)
                    .foregroundStyle(CutReadyTheme.text)
                Text(workspace.repository.fullName)
                    .font(.caption)
                    .foregroundStyle(CutReadyTheme.textSecondary)
                    .lineLimit(2)
            }

            Spacer()

            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(CutReadyTheme.textSecondary.opacity(0.55))
        }
    }
}

private struct WorkspaceLandingView: View {
    let isSigningIn: Bool
    let isOpeningWorkspace: Bool
    let workspaceOpenProgress: GitHubWorkspaceOpenProgress?
    let canAddWorkspace: Bool
    let recentWorkspaces: [RecentWorkspace]
    let onSignIn: () -> Void
    let onAddWorkspace: () -> Void
    let onOpenRecent: (RecentWorkspace) -> Void

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 22) {
                Spacer(minLength: 40)

            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 12) {
                        Image("cutready-app-icon", bundle: .module)
                            .resizable()
                            .scaledToFit()
                        .frame(width: 42, height: 42)
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .shadow(color: CutReadyTheme.accent.opacity(0.18), radius: 10, y: 4)

                        Text("CutReady")
                        .font(.system(size: 38, weight: .bold))
                            .foregroundStyle(CutReadyTheme.text)
                    }

                    Text(canAddWorkspace ? "Pick up a recent CutReady workspace or open another GitHub repo to rehearse, review, and make small edits." : "Sign in with GitHub to open synced CutReady workspaces, rehearse scripts, review storyboards, and make small edits from iPhone or iPad.")
                    .font(.body)
                        .foregroundStyle(CutReadyTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                VStack(spacing: 14) {
                    if !canAddWorkspace {
                        Button(action: onSignIn) {
                            Label(isSigningIn ? "Waiting for GitHub" : "Sign in with GitHub", systemImage: "person.crop.circle.badge.checkmark")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .disabled(isSigningIn)
                    }

                    if canAddWorkspace {
                        Button(action: onAddWorkspace) {
                            buttonLabel("Open another workspace", systemImage: "plus", isLoading: false)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                    } else {
                        Button(action: onAddWorkspace) {
                            buttonLabel("Add GitHub Workspace", systemImage: "plus", isLoading: false)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.large)
                        .disabled(true)
                    }
                }

                if canAddWorkspace {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Text("Recently opened")
                                .font(.headline)
                                .foregroundStyle(CutReadyTheme.text)
                            Spacer()
                            if isOpeningWorkspace {
                                ProgressView()
                                    .controlSize(.small)
                            }
                        }

                        if recentWorkspaces.isEmpty {
                            Text("Opened workspaces will appear here after you choose one from GitHub.")
                                .font(.subheadline)
                                .foregroundStyle(CutReadyTheme.textSecondary)
                                .padding(14)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(CutReadyTheme.surfaceAlt, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                        } else {
                            VStack(spacing: 10) {
                            ForEach(recentWorkspaces.prefix(3)) { workspace in
                                Button {
                                    onOpenRecent(workspace)
                                } label: {
                                    HStack(spacing: 12) {
                                        Image(systemName: "clock.arrow.circlepath")
                                            .foregroundStyle(CutReadyTheme.accent)
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(workspace.repository.name)
                                                .font(.subheadline.weight(.semibold))
                                                .foregroundStyle(CutReadyTheme.text)
                                            Text(workspace.repository.fullName)
                                                .font(.caption)
                                                .foregroundStyle(CutReadyTheme.textSecondary)
                                        }
                                        Spacer()
                                        if isOpeningWorkspace {
                                            ProgressView()
                                                .controlSize(.small)
                                        }
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                }
                                .buttonStyle(.plain)
                                .padding(12)
                                .background(CutReadyTheme.surfaceAlt, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                                .disabled(!canAddWorkspace || isOpeningWorkspace)
                            }
                            }
                        }
                    }
                }

                CompanionCard {
                    HStack(alignment: .top, spacing: 14) {
                        CutReadyDocumentIcon(CutReadyIconAsset.storyboard, tint: CutReadyTheme.accent, size: 22)
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Your demo companion")
                                .font(.headline)
                                .foregroundStyle(CutReadyTheme.text)
                            Text("Review storyboards, rehearse narration, tighten sketches, and sync small edits back when you are ready.")
                                .font(.subheadline)
                                .foregroundStyle(CutReadyTheme.textSecondary)
                        }
                    }
                }

                Spacer()
            }
            .padding(22)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .background(CutReadyTheme.surface)
            .overlay {
                if isOpeningWorkspace {
                    WorkspaceOpenProgressView(progress: workspaceOpenProgress)
                }
            }
        }
    }

    private func buttonLabel(_ title: String, systemImage: String, isLoading: Bool) -> some View {
        HStack {
            if isLoading {
                ProgressView()
                    .controlSize(.small)
            } else {
                Image(systemName: systemImage)
            }
            Text(title)
        }
        .frame(maxWidth: .infinity)
    }
}

private struct GitHubDeviceAuthorizationView: View {
    @Environment(\.openURL) private var openURL
    @State private var didCopyCode = false
    let authorization: GitHubDeviceAuthorization

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 18) {
                Text("Authorize CutReady")
                    .font(.title.weight(.semibold))
                    .foregroundStyle(CutReadyTheme.text)

                Text("Enter this code on GitHub to let CutReady list your private workspaces.")
                    .foregroundStyle(CutReadyTheme.textSecondary)

                Text(authorization.userCode)
                    .font(.system(size: 36, weight: .bold, design: .monospaced))
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(CutReadyTheme.surfaceAlt, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .onTapGesture {
                        copyCode()
                    }

                Button {
                    copyCode()
                } label: {
                    Label(didCopyCode ? "Copied" : "Copy Code", systemImage: didCopyCode ? "checkmark" : "doc.on.doc")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)

                Button {
                    openURL(authorization.verificationURI)
                } label: {
                    Label("Open GitHub", systemImage: "safari")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)

                Spacer()
            }
            .padding(28)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(CutReadyTheme.surface)
            .navigationTitle("GitHub Sign In")
        }
    }

    private func copyCode() {
        #if canImport(UIKit)
        UIPasteboard.general.string = authorization.userCode
        #endif
        didCopyCode = true
        Task {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            didCopyCode = false
        }
    }
}

private struct GitHubRepositoryPicker: View {
    @Binding var searchText: String
    let repositories: [GitHubRepositorySummary]
    let isLoadingRepositories: Bool
    let isOpeningWorkspace: Bool
    let workspaceOpenProgress: GitHubWorkspaceOpenProgress?
    let onSearch: (String) async -> Void
    let onOpenInput: (String) async -> Void
    let onOpen: (GitHubRepositorySummary) -> Void

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        Task {
                            await onOpenInput(trimmedSearchText)
                        }
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "link")
                                .foregroundStyle(CutReadyTheme.accent)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(directOpenTitle)
                                    .font(.headline)
                                    .foregroundStyle(CutReadyTheme.text)
                                Text("Paste owner/repo or a GitHub repository URL.")
                                    .font(.caption)
                                    .foregroundStyle(CutReadyTheme.textSecondary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(CutReadyTheme.textSecondary.opacity(0.55))
                        }
                    }
                    .disabled(!canOpenDirectly || isOpeningWorkspace)
                }

                if trimmedSearchText.count >= 2 {
                    Section("Search results") {
                        ForEach(repositories) { repository in
                            repositoryButton(repository, subtitle: repository.isPrivate ? "Private GitHub workspace" : "GitHub workspace")
                        }
                    }
                }
            }
            .navigationTitle("GitHub Workspaces")
            .searchable(text: $searchText, prompt: "Search or paste owner/repo")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if canClearSearch {
                        Button("Clear") {
                            searchText = ""
                            Task {
                                await onSearch("")
                            }
                        }
                    }
                }
            }
            .task(id: trimmedSearchText) {
                guard trimmedSearchText.count >= 2 else {
                    await onSearch("")
                    return
                }
                try? await Task.sleep(nanoseconds: 350_000_000)
                guard !Task.isCancelled else {
                    return
                }
                await onSearch(trimmedSearchText)
            }
            .overlay {
                if isLoadingRepositories {
                    ProgressView("Searching repositories")
                        .padding()
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                } else if isOpeningWorkspace {
                    WorkspaceOpenProgressView(progress: workspaceOpenProgress)
                } else if trimmedSearchText.isEmpty {
                    ContentUnavailableView(
                        "Search GitHub live",
                        systemImage: "magnifyingglass",
                        description: Text("Type a repository name, paste owner/repo, or paste a GitHub URL. CutReady will query GitHub only for what you ask for.")
                    )
                } else if trimmedSearchText.count >= 2 && repositories.isEmpty {
                    ContentUnavailableView.search(text: searchText)
                }
            }
        }
    }

    private func repositoryButton(_ repository: GitHubRepositorySummary, subtitle: String) -> some View {
        Button {
            onOpen(repository)
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(repository.fullName)
                        .font(.headline)
                        .foregroundStyle(CutReadyTheme.text)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(CutReadyTheme.textSecondary)
                }
                Spacer()
                if isOpeningWorkspace {
                    ProgressView()
                        .controlSize(.small)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .disabled(isOpeningWorkspace)
    }

    private var trimmedSearchText: String {
        searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canOpenDirectly: Bool {
        GitHubRepositorySpecifier(input: trimmedSearchText) != nil
    }

    private var canClearSearch: Bool {
        !trimmedSearchText.isEmpty || !repositories.isEmpty
    }

    private var directOpenTitle: String {
        if let specifier = GitHubRepositorySpecifier(input: trimmedSearchText) {
            return "Open \(specifier.fullName)"
        }
        return "Open by repository URL"
    }
}

private struct WorkspaceOpenProgressView: View {
    let progress: GitHubWorkspaceOpenProgress?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                ProgressView(value: progressValue)
                    .progressViewStyle(.circular)
                    .controlSize(.small)

                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(CutReadyTheme.text)
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(CutReadyTheme.textSecondary)
                        .lineLimit(2)
                }
            }

            if let completed = progress?.completed, let total = progress?.total, total > 0 {
                ProgressView(value: Double(completed), total: Double(total))
                    .tint(CutReadyTheme.accent)
            }
        }
        .frame(maxWidth: 320, alignment: .leading)
        .padding(16)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(CutReadyTheme.border.opacity(0.45), lineWidth: 1)
        )
        .padding()
    }

    private var title: String {
        switch progress?.phase {
        case .checkingCache:
            return "Checking local cache"
        case .readingCache:
            return "Opening local workspace"
        case .fetchingManifest:
            return "Preparing workspace cache"
        case .downloadingFiles:
            return "Downloading workspace files"
        case .finalizing:
            return "Finalizing workspace"
        case nil:
            return "Opening workspace"
        }
    }

    private var detail: String {
        switch progress?.phase {
        case .checkingCache:
            return "Looking for an on-device copy first."
        case .readingCache:
            return "Loading sketches, notes, and assets from this device."
        case .fetchingManifest:
            return "Reading the GitHub file list before hydrating the on-device cache."
        case .downloadingFiles:
            if let completed = progress?.completed, let total = progress?.total, total > 0 {
                if let currentPath = progress?.currentPath {
                    return "\(completed) of \(total) cached - \(currentPath.assetDisplayName)"
                }
                return "\(completed) of \(total) files cached."
            }
            return "Saving supported CutReady documents and assets on this device."
        case .finalizing:
            return "Building the project list from the local cache."
        case nil:
            return "This can take longer the first time because CutReady is creating an on-device cache."
        }
    }

    private var progressValue: Double? {
        guard
            let completed = progress?.completed,
            let total = progress?.total,
            total > 0
        else {
            return nil
        }
        return Double(completed) / Double(total)
    }
}

private struct StoryboardOverview: View {
    let project: CompanionProject

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Storyboard")
                    .font(.largeTitle.weight(.semibold))
                    .foregroundStyle(CutReadyTheme.text)

                ForEach(Array(project.sketches.enumerated()), id: \.element.id) { index, sketch in
                    CompanionCard {
                        HStack(alignment: .top, spacing: 14) {
                            Text("\(index + 1)")
                                .font(.headline.monospacedDigit())
                                .foregroundStyle(CutReadyTheme.accent)
                                .frame(width: 32, height: 32)
                                .background(CutReadyTheme.accent.opacity(0.12), in: Circle())

                            VStack(alignment: .leading, spacing: 6) {
                                Text(sketch.title)
                                    .font(.headline)
                                    .foregroundStyle(CutReadyTheme.text)
                                Text("Review, rehearse, or make a safe mobile edit.")
                                    .font(.subheadline)
                                    .foregroundStyle(CutReadyTheme.textSecondary)
                            }

                            Spacer()

                            Image(systemName: "chevron.right")
                                .foregroundStyle(CutReadyTheme.textSecondary)
                        }
                    }
                }
            }
            .padding(20)
        }
        .background(CutReadyTheme.surfaceAlt)
        .navigationTitle(project.name)
    }
}

private struct RehearsalPreview: View {
    let project: CompanionProject

    var body: some View {
        VStack(spacing: 20) {
            CompanionCard {
                VStack(alignment: .leading, spacing: 14) {
                    HStack {
                        HStack(spacing: 8) {
                            CutReadyDocumentIcon(CutReadyIconAsset.storyboard, tint: CutReadyTheme.accent, size: 18)
                            Text("Rehearse")
                        }
                        .font(.headline)
                        .foregroundStyle(CutReadyTheme.accent)
                        Spacer()
                        SyncBadge(label: "Companion")
                    }

                    Text("Walk through the script, tighten narration, and push small changes back to the desktop workspace.")
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(CutReadyTheme.text)

                    Text("Recording, replay automation, and export stay on desktop. The phone and iPad stay focused on confidence, review, and safe edits.")
                        .font(.body)
                        .foregroundStyle(CutReadyTheme.textSecondary)
                }
            }

            HStack(spacing: 12) {
                Button {
                } label: {
                    Label("Start rehearsal", systemImage: "play.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)

                Button {
                } label: {
                    Label("Sync", systemImage: "arrow.triangle.2.circlepath")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(CutReadyTheme.surface)
        .navigationTitle("Rehearsal")
    }
}

#Preview {
    CompanionRootView(project: CompanionSamples.project)
}

private struct SelectionDetailView: View {
    let selection: CompanionSelection
    let project: CompanionProject

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            switch selection {
            case .storyboard(let path):
                DetailHeader(title: title(for: path, in: project.allStoryboards), icon: CutReadyIconAsset.storyboard, tint: CutReadyTheme.storyboard, path: path)
            case .sketch(let path):
                DetailHeader(title: title(for: path, in: project.allSketches), icon: CutReadyIconAsset.sketch, tint: CutReadyTheme.sketch, path: path)
            case .note(let path):
                DetailHeader(title: title(for: path, in: project.allNotes), icon: CutReadyIconAsset.note, tint: CutReadyTheme.note, path: path)
            case .project:
                Text(project.name)
                    .font(.largeTitle.weight(.semibold))
            case .rehearse:
                RehearsalPreview(project: project)
            }

            Text("Preview and editing for this document are next. Mobile edits stay constrained to supported CutReady files in the GitHub workspace.")
                .font(.body)
                .foregroundStyle(CutReadyTheme.textSecondary)

            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(CutReadyTheme.surface)
        .navigationTitle(navigationTitle)
    }

    private func title(for path: String, in summaries: [FileSummary]) -> String {
        summaries.first { $0.path == path }?.title ?? path
    }

    private var navigationTitle: String {
        switch selection {
        case .storyboard(let path):
            return title(for: path, in: project.allStoryboards)
        case .sketch(let path):
            return title(for: path, in: project.allSketches)
        case .note(let path):
            return title(for: path, in: project.allNotes)
        case .project:
            return project.name
        case .rehearse:
            return "Rehearsal"
        }
    }
}

private struct StoryboardDetailView: View {
    let path: String
    let storyboard: FileSummary?
    let fallbackTitle: String
    let project: CompanionProject

    private var decodedStoryboard: Storyboard? {
        try? decodeStoryboard()
    }

    private var unavailableDetails: [String] {
        var details = ["Path: \(path)"]
        if let contents = storyboard?.contents {
            details.append("Content: \(contents.utf8.count) bytes fetched")
        } else if storyboard == nil {
            details.append("Content: no storyboard summary found in the current workspace snapshot")
        } else {
            details.append("Content: missing from the current workspace snapshot")
        }

        do {
            _ = try decodeStoryboard()
            details.append("Decode: succeeded; reopen this storyboard from the list")
        } catch {
            details.append("Decode: \(SketchPreviewError.describe(error))")
        }
        return details
    }

    var body: some View {
        Group {
            if let decodedStoryboard {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        storyboardHeader(decodedStoryboard)
                        storyboardSequence(decodedStoryboard)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }
                .background(CutReadyTheme.surface)
            } else {
                unavailableView
            }
        }
        .navigationTitle(decodedStoryboard?.title ?? storyboard?.title ?? fallbackTitle)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    private func decodeStoryboard() throws -> Storyboard {
        guard let contents = storyboard?.contents, let data = contents.data(using: .utf8) else {
            throw SketchPreviewError.missingContents
        }

        return try JSONDecoder().decode(Storyboard.self, from: data)
    }

    private func storyboardHeader(_ storyboard: Storyboard) -> some View {
        CompanionCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top, spacing: 12) {
                    CutReadyDocumentIcon(CutReadyIconAsset.storyboard, tint: CutReadyTheme.storyboard, size: 30)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(storyboard.title)
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(CutReadyTheme.text)
                        Text(path)
                            .font(.caption)
                            .foregroundStyle(CutReadyTheme.textSecondary)
                            .lineLimit(2)
                    }
                    Spacer()
                    if storyboard.locked == true {
                        Image(systemName: "lock.fill")
                            .font(.caption)
                            .foregroundStyle(CutReadyTheme.textSecondary)
                    }
                }

                if !storyboard.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    SketchMarkdownContent(markdown: storyboard.description, emptyLabel: "")
                }

                HStack(spacing: 10) {
                    WorkspaceStatPill(value: "\(storyboard.items.mobileSketchCount)", label: "Sketches", tint: CutReadyTheme.sketch)
                    WorkspaceStatPill(value: "\(storyboard.items.mobileSectionCount)", label: "Sections", tint: CutReadyTheme.storyboard)
                }
            }
        }
    }

    @ViewBuilder
    private func storyboardSequence(_ storyboard: Storyboard) -> some View {
        if storyboard.items.isEmpty {
            ContentUnavailableView(
                "No storyboard items",
                systemImage: "rectangle.stack.badge.plus",
                description: Text("This storyboard does not sequence any sketches yet.")
            )
            .padding(.top, 20)
        } else {
            VStack(alignment: .leading, spacing: 12) {
                Text("Sequence")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(CutReadyTheme.textSecondary)
                    .tracking(0.8)
                    .padding(.horizontal, 4)

                ForEach(Array(storyboard.items.enumerated()), id: \.offset) { index, item in
                    switch item {
                    case .sketchRef(let sketchPath):
                        StoryboardSketchReferenceCard(
                            path: sketchPath,
                            indexLabel: "\(index + 1)",
                            resolvedSketch: resolvedSketch(for: sketchPath),
                            sectionTitle: nil
                        )
                    case .section(let title, let description, let sketches):
                        StoryboardSectionCard(
                            title: title,
                            description: description,
                            indexLabel: "\(index + 1)",
                            sketches: sketches,
                            resolveSketch: resolvedSketch(for:)
                        )
                    }
                }
            }
        }
    }

    private var unavailableView: some View {
        VStack(spacing: 14) {
            ContentUnavailableView(
                "Storyboard preview unavailable",
                systemImage: "rectangle.stack",
                description: Text("CutReady could not render this storyboard from the current mobile workspace snapshot.")
            )

            VStack(alignment: .leading, spacing: 8) {
                ForEach(unavailableDetails, id: \.self) { detail in
                    Text(detail)
                        .font(.caption.monospaced())
                        .foregroundStyle(CutReadyTheme.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(CutReadyTheme.surfaceAlt.opacity(0.45), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(CutReadyTheme.border.opacity(0.55), lineWidth: 1)
            )
            .padding(.horizontal, 16)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(CutReadyTheme.surface)
    }

    private func resolvedSketch(for sketchPath: String) -> FileSummary? {
        for candidate in sketchPathCandidates(for: sketchPath) {
            if let sketch = project.allSketches.first(where: { $0.path == candidate }) {
                return sketch
            }
        }
        return nil
    }

    private func sketchPathCandidates(for sketchPath: String) -> [String] {
        let normalized = sketchPath.mobileNormalizedPath
        guard !normalized.isEmpty else {
            return []
        }

        var candidates = [normalized]
        let storyboardDirectory = path.mobileNormalizedPath.mobileDeletingLastPathComponent
        if !storyboardDirectory.isEmpty {
            candidates.append("\(storyboardDirectory)/\(normalized)")
        }
        let projectPath = project.activeProjectPath.mobileNormalizedPath
        if !projectPath.isEmpty && projectPath != "." {
            candidates.append("\(projectPath)/\(normalized)")
        }
        return Array(NSOrderedSet(array: candidates).compactMap { $0 as? String })
    }
}

private struct StoryboardSectionCard: View {
    let title: String
    let description: String?
    let indexLabel: String
    let sketches: [String]
    let resolveSketch: (String) -> FileSummary?

    var body: some View {
        CompanionCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top, spacing: 10) {
                    RowMetaPill(label: indexLabel, systemImage: nil, tint: CutReadyTheme.storyboard)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(title.isEmpty ? "Untitled section" : title)
                            .font(.headline)
                            .foregroundStyle(CutReadyTheme.text)
                        if let description, !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            Text(description)
                                .font(.subheadline)
                                .foregroundStyle(CutReadyTheme.textSecondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }

                if sketches.isEmpty {
                    Text("No sketches in this section yet.")
                        .font(.caption)
                        .foregroundStyle(CutReadyTheme.textSecondary)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(CutReadyTheme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                } else {
                    VStack(spacing: 8) {
                        ForEach(Array(sketches.enumerated()), id: \.offset) { index, sketchPath in
                            StoryboardSketchReferenceCard(
                                path: sketchPath,
                                indexLabel: "\(index + 1)",
                                resolvedSketch: resolveSketch(sketchPath),
                                sectionTitle: title
                            )
                        }
                    }
                }
            }
        }
    }
}

private struct StoryboardSketchReferenceCard: View {
    let path: String
    let indexLabel: String
    let resolvedSketch: FileSummary?
    let sectionTitle: String?

    var body: some View {
        Group {
            if let resolvedSketch {
                NavigationLink(value: CompanionSelection.sketch(resolvedSketch.path)) {
                    rowContent(title: resolvedSketch.title, subtitle: sketchDescription(for: resolvedSketch), isMissing: false)
                }
                .buttonStyle(.plain)
            } else {
                rowContent(title: path.assetDisplayName, subtitle: "Sketch reference is missing from this mobile workspace.", isMissing: true)
            }
        }
    }

    private func rowContent(title: String, subtitle: String, isMissing: Bool) -> some View {
        HStack(alignment: .top, spacing: 10) {
            RowMetaPill(label: indexLabel, systemImage: nil, tint: isMissing ? CutReadyTheme.textSecondary : CutReadyTheme.sketch)

            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(isMissing ? CutReadyTheme.textSecondary : CutReadyTheme.text)
                    .lineLimit(2)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(CutReadyTheme.textSecondary)
                if let sectionTitle, !sectionTitle.isEmpty {
                    Text(sectionTitle)
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(CutReadyTheme.storyboard)
                }
            }

            Spacer()

            Image(systemName: isMissing ? "exclamationmark.triangle" : "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(isMissing ? .orange : CutReadyTheme.textSecondary.opacity(0.55))
                .padding(.top, 3)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CutReadyTheme.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(CutReadyTheme.border.opacity(0.55), lineWidth: 1)
        )
    }

    private func sketchDescription(for sketchSummary: FileSummary) -> String {
        guard let contents = sketchSummary.contents,
              let data = contents.data(using: .utf8),
              let sketch = try? JSONDecoder().decode(Sketch.self, from: data),
              let description = sketch.description.mobileDisplayText?.trimmingCharacters(in: .whitespacesAndNewlines),
              !description.isEmpty else {
            return "No sketch description yet."
        }
        return description
    }
}

private struct SketchDetailView: View {
    let path: String
    let sketch: FileSummary?
    let fallbackTitle: String
    let project: CompanionProject
    let githubAccessToken: String?
    let syncStatus: MobileSyncStatus
    let loadAsset: (String) async throws -> Data?
    let onOpenSync: () -> Void
    let onSave: (Sketch) async throws -> Void
    @State private var layout = SketchReaderLayoutStore.load()
    @State private var isShowingLayout = false
    @State private var rowEdit: SketchRowEditDraft?
    @State private var saveError: String?

    private var decodedSketch: Sketch? {
        try? decodeSketch()
    }

    private var unavailableDetails: [String] {
        var details = ["Path: \(path)"]
        if let contents = sketch?.contents {
            details.append("Content: \(contents.utf8.count) bytes fetched")
        } else if sketch == nil {
            details.append("Content: no sketch summary found in the current workspace snapshot")
        } else {
            details.append("Content: missing from the current workspace snapshot")
        }

        do {
            _ = try decodeSketch()
            details.append("Decode: succeeded; reopen this sketch from the list")
        } catch {
            details.append("Decode: \(SketchPreviewError.describe(error))")
        }
        return details
    }

    private func decodeSketch() throws -> Sketch {
        guard let contents = sketch?.contents, let data = contents.data(using: .utf8) else {
            throw SketchPreviewError.missingContents
        }

        let decoder = JSONDecoder()
        return try decoder.decode(Sketch.self, from: data)
    }

    var body: some View {
        Group {
            if let decodedSketch {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        sketchHeader(decodedSketch)

                        ForEach(Array(decodedSketch.rows.enumerated()), id: \.offset) { index, row in
                            SketchRowCard(
                                row: row,
                                index: index,
                                layout: layout,
                                sketchPath: path,
                                project: project,
                                githubAccessToken: githubAccessToken,
                                loadAsset: loadAsset,
                                onEdit: {
                                    rowEdit = SketchRowEditDraft(index: index, row: row)
                                }
                            )
                        }

                        if decodedSketch.rows.isEmpty {
                            ContentUnavailableView(
                                "No sketch rows",
                                systemImage: "rectangle.stack",
                                description: Text("This sketch does not have planning rows yet.")
                            )
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }
                .background(CutReadyTheme.surface)
            } else {
                VStack(spacing: 14) {
                    ContentUnavailableView(
                        "Sketch preview unavailable",
                        systemImage: "square.and.pencil",
                        description: Text("CutReady could not render this sketch from the current mobile workspace snapshot.")
                    )

                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(unavailableDetails, id: \.self) { detail in
                            Text(detail)
                                .font(.caption.monospaced())
                                .foregroundStyle(CutReadyTheme.textSecondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(CutReadyTheme.surfaceAlt.opacity(0.45), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .stroke(CutReadyTheme.border.opacity(0.55), lineWidth: 1)
                    )
                    .padding(.horizontal, 16)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(CutReadyTheme.surface)
            }
        }
        .navigationTitle(decodedSketch?.title ?? sketch?.title ?? fallbackTitle)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem {
                WorkspaceSyncToolbarButton(status: syncStatus, action: onOpenSync)
            }

            ToolbarItem {
                Button {
                    isShowingLayout = true
                } label: {
                    Image(systemName: "slider.horizontal.3")
                }
                .accessibilityLabel("Sketch layout")
            }
        }
        .sheet(isPresented: $isShowingLayout) {
            SketchLayoutSheet(layout: $layout)
        }
        .sheet(item: $rowEdit) { draft in
            SketchRowEditSheet(
                draft: draft,
                onCancel: { rowEdit = nil },
                onSave: { updatedDraft in
                    try await saveRow(updatedDraft)
                }
            )
        }
        .alert("Could not save sketch", isPresented: Binding(
            get: { saveError != nil },
            set: { if !$0 { saveError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(saveError ?? "")
        }
        .onChange(of: layout) { _, newValue in
            SketchReaderLayoutStore.save(newValue)
        }
    }

    private func sketchHeader(_ sketch: Sketch) -> some View {
        CompanionCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Label("Sketch", systemImage: "square.and.pencil")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(CutReadyTheme.sketch)
                    Spacer()
                    Text("\(sketch.rows.count) rows")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(CutReadyTheme.textSecondary)
                }

                if let description = sketch.description.mobileDisplayText, !description.isEmpty {
                    SketchMarkdownContent(markdown: description, emptyLabel: "")
                }
            }
        }
    }

    private func saveRow(_ draft: SketchRowEditDraft) async throws {
        var updated = try decodeSketch()
        let update = RowTextUpdate(
            time: draft.time == draft.originalTime ? nil : draft.time,
            narrative: draft.narrative == draft.originalNarrative ? nil : draft.narrative,
            demoActions: draft.demoActions == draft.originalDemoActions ? nil : draft.demoActions
        )
        try MobileEdits.apply(
            .updateRowText(
                index: draft.index,
                update
            ),
            to: &updated
        )
        do {
            try await onSave(updated)
            await MainActor.run {
                rowEdit = nil
                saveError = nil
            }
        } catch {
            await MainActor.run {
                saveError = error.localizedDescription
            }
            throw error
        }
    }
}

private enum SketchPreviewError: LocalizedError {
    case missingContents

    var errorDescription: String? {
        switch self {
        case .missingContents:
            return "Reopen the workspace to fetch sketch contents for mobile preview."
        }
    }

    static func describe(_ error: Error) -> String {
        if let error = error as? SketchPreviewError {
            return error.localizedDescription
        }
        if let error = error as? DecodingError {
            return error.mobileDescription
        }
        return error.localizedDescription
    }
}

private extension DecodingError {
    var mobileDescription: String {
        switch self {
        case .typeMismatch(let type, let context):
            return "type mismatch for \(type) at \(context.codingPath.mobilePath): \(context.debugDescription)"
        case .valueNotFound(let type, let context):
            return "missing value for \(type) at \(context.codingPath.mobilePath): \(context.debugDescription)"
        case .keyNotFound(let key, let context):
            return "missing key \(key.stringValue) at \(context.codingPath.mobilePath): \(context.debugDescription)"
        case .dataCorrupted(let context):
            return "data corrupted at \(context.codingPath.mobilePath): \(context.debugDescription)"
        @unknown default:
            return localizedDescription
        }
    }
}

private extension Array where Element == CodingKey {
    var mobilePath: String {
        let path = map(\.stringValue).joined(separator: ".")
        return path.isEmpty ? "<root>" : path
    }
}

private struct SketchRowCard: View {
    let row: PlanningRow
    let index: Int
    let layout: SketchReaderLayout
    let sketchPath: String
    let project: CompanionProject
    let githubAccessToken: String?
    let loadAsset: (String) async throws -> Data?
    let onEdit: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 8) {
                RowMetaPill(label: "\(index + 1)", systemImage: nil, tint: CutReadyTheme.sketch)
                RowMetaPill(label: row.time.isEmpty ? "Untimed" : row.time, systemImage: "clock", tint: CutReadyTheme.textSecondary)

                if let durationSeconds = row.durationSeconds {
                    RowMetaPill(label: "\(durationSeconds)s", systemImage: "timer", tint: CutReadyTheme.textSecondary)
                }

                Spacer()

                if row.locked == true {
                    Image(systemName: "lock.fill")
                        .font(.caption)
                        .foregroundStyle(CutReadyTheme.textSecondary)
                } else {
                    Button(action: onEdit) {
                        Image(systemName: "pencil")
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Edit row \(index + 1)")
                }
            }

            ForEach(layout.visibleSections) { section in
                SketchSectionView(section: section, row: row, sketchPath: sketchPath, project: project, githubAccessToken: githubAccessToken, loadAsset: loadAsset)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CutReadyTheme.surfaceAlt.opacity(0.48), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(CutReadyTheme.border.opacity(0.58), lineWidth: 1)
        )
    }
}

private struct RowMetaPill: View {
    let label: String
    let systemImage: String?
    let tint: Color

    var body: some View {
        HStack(spacing: 4) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.caption2.weight(.semibold))
            }
            Text(label)
                .font(.caption.monospacedDigit().weight(.semibold))
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(tint.opacity(0.10), in: Capsule())
    }
}

private struct SketchRowEditDraft: Identifiable, Equatable {
    let id: Int
    let index: Int
    let originalTime: String
    let originalNarrative: String
    let originalDemoActions: String
    var time: String
    var narrative: String
    var demoActions: String

    init(index: Int, row: PlanningRow) {
        self.id = index
        self.index = index
        self.originalTime = row.time
        self.originalNarrative = row.narrative
        self.originalDemoActions = row.demoActions
        self.time = row.time
        self.narrative = row.narrative
        self.demoActions = row.demoActions
    }
}

private struct SketchRowEditSheet: View {
    @State var draft: SketchRowEditDraft
    let onCancel: () -> Void
    let onSave: (SketchRowEditDraft) async throws -> Void
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Timing") {
                    TextField("Time", text: $draft.time)
                }

                Section("Narrative") {
                    TextEditor(text: $draft.narrative)
                        .frame(minHeight: 120)
                }

                Section("Actions") {
                    TextEditor(text: $draft.demoActions)
                        .frame(minHeight: 120)
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Edit Row \(draft.index + 1)")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                        .disabled(isSaving)
                }

                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving" : "Save") {
                        save()
                    }
                    .disabled(isSaving)
                }
            }
        }
    }

    private func save() {
        Task {
            do {
                isSaving = true
                try await onSave(draft)
            } catch {
                errorMessage = error.localizedDescription
            }
            isSaving = false
        }
    }
}

private struct SketchSectionView: View {
    let section: SketchReaderSection
    let row: PlanningRow
    let sketchPath: String
    let project: CompanionProject
    let githubAccessToken: String?
    let loadAsset: (String) async throws -> Data?

    var body: some View {
        switch section {
        case .assets:
            assets
        case .narration:
            narration
        case .narrative:
            textSection(title: "Narrative", icon: "text.quote", text: row.narrative, emptyLabel: "No narrative yet.", tint: CutReadyTheme.sketch)
        case .actions:
            textSection(title: "Actions", icon: "cursorarrow.click.2", text: row.demoActions, emptyLabel: "No actions yet.", tint: CutReadyTheme.storyboard)
        }
    }

    private var assets: some View {
        VStack(alignment: .leading, spacing: 7) {
            sectionTitle("Assets", icon: "photo.on.rectangle.angled", tint: CutReadyTheme.note)

            if screenshotPath == nil && row.visual == nil {
                AssetEmptyState()
            } else {
                VStack(alignment: .leading, spacing: 7) {
                    if let screenshot = screenshotPath {
                        ScreenshotAssetView(
                            path: screenshot,
                            candidatePaths: project.assetPathCandidates(for: screenshot, referencedFrom: sketchPath),
                            source: project.source,
                            githubAccessToken: githubAccessToken,
                            loadAsset: loadAsset
                        )
                    }

                    if let visual = row.visual {
                        let summary = visual.visualSummary
                        AssetReferenceRow(
                            icon: "sparkles",
                            title: summary.title,
                            value: summary.subtitle,
                            detail: "Native Elucim rendering is not enabled yet."
                        )
                    }
                }
            }
        }
    }

    private var narration: some View {
        VStack(alignment: .leading, spacing: 7) {
            sectionTitle("Narration", icon: "waveform", tint: CutReadyTheme.accent)

            if let narration = row.narration {
                NarrationAssetView(
                    narration: narration,
                    candidatePaths: project.assetPathCandidates(for: narration.path, referencedFrom: sketchPath),
                    source: project.source,
                    githubAccessToken: githubAccessToken,
                    loadAsset: loadAsset
                )
            } else {
                Text("No narration recorded.")
                    .font(.caption)
                    .foregroundStyle(CutReadyTheme.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(CutReadyTheme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .stroke(CutReadyTheme.border.opacity(0.7), style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                    )
            }
        }
    }

    private var screenshotPath: String? {
        guard let screenshot = row.screenshot?.trimmingCharacters(in: .whitespacesAndNewlines), !screenshot.isEmpty else {
            return nil
        }
        return screenshot
    }

    private func textSection(title: String, icon: String, text: String, emptyLabel: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            sectionTitle(title, icon: icon, tint: tint)
            SketchMarkdownCard(markdown: text, emptyLabel: emptyLabel)
        }
    }

    private func sectionTitle(_ title: String, icon: String, tint: Color) -> some View {
        Label(title, systemImage: icon)
            .font(.caption.weight(.semibold))
            .foregroundStyle(tint)
    }
}

private struct NarrationAssetView: View {
    let narration: RowNarration
    let candidatePaths: [String]
    let source: MobileWorkspaceSource
    let githubAccessToken: String?
    let loadAsset: (String) async throws -> Data?
    @State private var audioData: Data?
    @State private var loadState: LoadState = .idle

    private enum LoadState: Equatable {
        case idle
        case loading
        case loaded(String)
        case failed(String)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch loadState {
            case .idle:
                Button {
                    loadAudio()
                } label: {
                    Label("Load narration", systemImage: "play.circle")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            case .loading:
                HStack(spacing: 8) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Loading narration from the on-device cache")
                        .font(.caption)
                        .foregroundStyle(CutReadyTheme.textSecondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            case .loaded:
                if let audioData {
                    NarrationAudioPlayer(data: audioData, mimeType: narration.mimeType ?? narration.inferredMimeType)
                        .frame(height: 128)
                }
            case .failed(let message):
                Text(message)
                    .font(.caption2)
                    .foregroundStyle(CutReadyTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func loadAudio() {
        let paths = candidatePaths.isEmpty ? [narration.path] : candidatePaths
        loadState = .loading
        Task {
            do {
                for path in paths where MobileWorkspacePolicy.canReadNarration(path: path) {
                    if let data = try await loadAsset(path) {
                        await MainActor.run {
                            audioData = data
                            loadState = .loaded(path)
                        }
                        return
                    }
                }

                guard let githubAccessToken else {
                    await MainActor.run {
                        loadState = .failed("Narration file is referenced, but it is not in the local Draftline workspace.")
                    }
                    return
                }

                let client = GitHubMobileClient()
                for path in paths where MobileWorkspacePolicy.canReadNarration(path: path) {
                    if let data = try await client.assetData(path: path, source: source, accessToken: githubAccessToken) {
                        await MainActor.run {
                            audioData = data
                            loadState = .loaded(path)
                        }
                        return
                    }
                }
                await MainActor.run {
                    loadState = .failed("Narration file is referenced, but it is not in the workspace cache yet. Reopen the workspace to hydrate narration assets.")
                }
            } catch {
                await MainActor.run {
                    loadState = .failed("Could not load narration: \(error.localizedDescription)")
                }
            }
        }
    }
}

private struct NarrationAudioPlayer: View {
    let data: Data
    let mimeType: String

    var body: some View {
        WebAudioPlayer(data: data, mimeType: mimeType)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(CutReadyTheme.border.opacity(0.6), lineWidth: 1)
            )
    }
}

#if os(iOS)
private struct WebAudioPlayer: UIViewRepresentable {
    let data: Data
    let mimeType: String

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        webView.loadHTMLString(audioHTML(data: data, mimeType: mimeType), baseURL: nil)
    }
}
#else
private struct WebAudioPlayer: NSViewRepresentable {
    let data: Data
    let mimeType: String

    func makeNSView(context: Context) -> WKWebView {
        let webView = WKWebView(frame: .zero)
        webView.setValue(false, forKey: "drawsBackground")
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        webView.loadHTMLString(audioHTML(data: data, mimeType: mimeType), baseURL: nil)
    }
}
#endif

private func audioHTML(data: Data, mimeType: String) -> String {
    let encoded = data.base64EncodedString()
    let normalizedMimeType = normalizedAudioMimeType(mimeType)
    return """
    <!doctype html>
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          :root { color-scheme: light dark; }
          html, body {
            margin: 0;
            padding: 0;
            background: transparent;
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
            color: #6f6962;
            -webkit-user-select: none;
            user-select: none;
          }
          .player {
            display: grid;
            gap: 10px;
            min-height: 118px;
            box-sizing: border-box;
            padding: 10px;
            border-radius: 12px;
            background: rgba(250, 249, 247, 0.58);
          }
          .status {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
          }
          .waveform {
            position: relative;
            width: 100%;
            height: 58px;
            overflow: hidden;
            box-sizing: border-box;
            border: 1px solid rgba(224, 220, 214, 0.9);
            border-radius: 10px;
            background: rgba(244, 241, 237, 0.66);
            touch-action: none;
          }
          canvas {
            display: block;
            width: 100%;
            height: 100%;
          }
          .playhead {
            position: absolute;
            top: 0;
            bottom: 0;
            left: 0;
            width: 1px;
            background: #6b5ce7;
            box-shadow: 0 0 0 1px rgba(107, 92, 231, 0.22), 0 0 14px rgba(107, 92, 231, 0.35);
            pointer-events: none;
            transform: translateX(0);
          }
          .duration {
            position: absolute;
            right: 7px;
            top: 7px;
            border-radius: 999px;
            background: rgba(250, 249, 247, 0.88);
            padding: 2px 7px;
            font-size: 10px;
            font-weight: 650;
            font-variant-numeric: tabular-nums;
            color: rgba(111, 105, 98, 0.72);
            pointer-events: none;
          }
          .controls {
            display: flex;
            align-items: center;
            gap: 8px;
          }
          button {
            display: grid;
            place-items: center;
            width: 26px;
            height: 26px;
            flex: 0 0 26px;
            border: 1px solid rgba(107, 92, 231, 0.28);
            border-radius: 999px;
            color: white;
            background: linear-gradient(180deg, #7b6df0, #6252dc);
            box-shadow: 0 5px 12px rgba(107, 92, 231, 0.18);
            font-size: 10px;
            line-height: 1;
            padding: 0;
          }
          .meta {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            min-width: 0;
          }
          .label {
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            font-size: 10px;
            font-weight: 600;
            letter-spacing: 0.18em;
            text-transform: uppercase;
            color: rgba(111, 105, 98, 0.78);
          }
          .dot {
            width: 8px;
            height: 8px;
            flex: 0 0 8px;
            border-radius: 999px;
            background: rgba(111, 105, 98, 0.35);
          }
          .dot.active {
            background: #6b5ce7;
            box-shadow: 0 0 0 3px rgba(107, 92, 231, 0.12);
          }
          .time {
            flex: 0 0 auto;
            text-align: right;
            font-size: 10px;
            font-weight: 650;
            font-variant-numeric: tabular-nums;
            letter-spacing: 0.01em;
            color: rgba(111, 105, 98, 0.70);
          }
          @media (prefers-color-scheme: dark) {
            html, body { color: #c9c1b8; }
            .player { background: rgba(43, 41, 38, 0.48); }
            .waveform {
              border-color: rgba(79, 75, 69, 0.92);
              background: rgba(55, 52, 48, 0.62);
            }
            .playhead {
              background: #a49afa;
              box-shadow: 0 0 0 1px rgba(164, 154, 250, 0.24), 0 0 14px rgba(164, 154, 250, 0.38);
            }
            .duration {
              background: rgba(43, 41, 38, 0.86);
              color: rgba(201, 193, 184, 0.72);
            }
            .label { color: rgba(201, 193, 184, 0.80); }
            .dot { background: rgba(201, 193, 184, 0.35); }
            .dot.active { background: #a49afa; box-shadow: 0 0 0 3px rgba(164, 154, 250, 0.14); }
            .time { color: rgba(201, 193, 184, 0.70); }
          }
        </style>
      </head>
      <body>
        <audio id="audio" preload="metadata"></audio>
        <div class="player">
          <div class="status">
            <span id="label" class="label">Narration ready</span>
            <span id="dot" class="dot" aria-hidden="true"></span>
          </div>
          <div id="waveform" class="waveform" role="slider" aria-label="Narration waveform. Drag to scrub." aria-valuemin="0" aria-valuemax="1000" aria-valuenow="0" tabindex="0">
            <canvas id="waveCanvas" aria-hidden="true"></canvas>
            <span id="playhead" class="playhead" aria-hidden="true"></span>
            <span id="duration" class="duration">0:00</span>
          </div>
          <div class="controls">
            <button id="toggle" type="button" aria-label="Play narration">▶</button>
            <div class="meta">
              <span id="time" class="time">0:00</span>
            </div>
          </div>
        </div>
        <script>
          const binary = atob('\(encoded)');
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
          }
          const blob = new Blob([bytes], { type: '\(normalizedMimeType)' });
          const audio = document.getElementById('audio');
          const toggle = document.getElementById('toggle');
          const waveform = document.getElementById('waveform');
          const canvas = document.getElementById('waveCanvas');
          const playhead = document.getElementById('playhead');
          const durationPill = document.getElementById('duration');
          const label = document.getElementById('label');
          const dot = document.getElementById('dot');
          const time = document.getElementById('time');
          audio.src = URL.createObjectURL(blob);
          let isScrubbing = false;
          let pendingRatio = 0;
          let peaks = null;
          const colors = {
            accent: '#6b5ce7',
            surface: 'rgba(244, 241, 237, 0.66)',
            border: 'rgba(224, 220, 214, 0.92)',
            unplayed: 'rgba(107, 92, 231, 0.26)'
          };

          function syncColors() {
            if (!window.matchMedia('(prefers-color-scheme: dark)').matches) return;
            colors.accent = '#a49afa';
            colors.surface = 'rgba(55, 52, 48, 0.62)';
            colors.border = 'rgba(79, 75, 69, 0.92)';
            colors.unplayed = 'rgba(164, 154, 250, 0.24)';
          }

          function format(seconds) {
            if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
            const rounded = Math.floor(seconds);
            return Math.floor(rounded / 60) + ':' + String(rounded % 60).padStart(2, '0');
          }

          function align(value, dpr) {
            return Math.round(value * dpr) / dpr;
          }

          function prepareCanvas() {
            const rect = waveform.getBoundingClientRect();
            const dpr = Math.max(1, window.devicePixelRatio || 1);
            const width = Math.max(1, rect.width);
            const height = Math.max(1, rect.height);
            const backingWidth = Math.round(width * dpr);
            const backingHeight = Math.round(height * dpr);
            if (canvas.width !== backingWidth) canvas.width = backingWidth;
            if (canvas.height !== backingHeight) canvas.height = backingHeight;
            const context = canvas.getContext('2d');
            context.setTransform(dpr, 0, 0, dpr, 0, 0);
            return { context, width, height, dpr };
          }

          function drawEmptyWaveform() {
            const { context, width, height, dpr } = prepareCanvas();
            const midline = align(height / 2, dpr);
            context.clearRect(0, 0, width, height);
            context.fillStyle = colors.surface;
            context.fillRect(0, 0, width, height);
            context.strokeStyle = colors.border;
            context.lineWidth = 1 / dpr;
            context.beginPath();
            context.moveTo(0, midline);
            context.lineTo(width, midline);
            context.stroke();
          }

          function drawWaveform(ratio = 0) {
            if (!peaks || peaks.length === 0) {
              drawEmptyWaveform();
              updatePlayhead(ratio);
              return;
            }

            const { context, width, height, dpr } = prepareCanvas();
            const midline = align(height / 2, dpr);
            const pixels = Math.min(peaks.length, Math.max(1, Math.floor(width)));
            const playedX = Math.max(0, Math.min(width, ratio * width));
            context.clearRect(0, 0, width, height);
            context.fillStyle = colors.surface;
            context.fillRect(0, 0, width, height);
            context.strokeStyle = colors.border;
            context.lineWidth = 1 / dpr;
            context.beginPath();
            context.moveTo(0, midline);
            context.lineTo(width, midline);
            context.stroke();

            function strokePeaks(style, clipLeft, clipWidth) {
              context.save();
              context.beginPath();
              context.rect(clipLeft, 0, clipWidth, height);
              context.clip();
              context.strokeStyle = style;
              context.lineWidth = 1.5;
              context.beginPath();
              for (let x = 0; x < pixels; x += 1) {
                const peak = peaks[Math.floor((x / pixels) * peaks.length)] || { min: -0.04, max: 0.04 };
                const drawX = align(x + 0.5, dpr);
                context.moveTo(drawX, ((1 - peak.max) * height) / 2);
                context.lineTo(drawX, ((1 - peak.min) * height) / 2);
              }
              context.stroke();
              context.restore();
            }

            strokePeaks(colors.unplayed, 0, width);
            strokePeaks(colors.accent, 0, playedX);
            updatePlayhead(ratio);
          }

          function peaksFromDecoded(buffer) {
            const samples = buffer.getChannelData(0);
            const width = Math.max(1, Math.floor(waveform.getBoundingClientRect().width));
            const samplesPerPixel = Math.max(1, Math.floor(samples.length / width));
            const next = [];
            for (let x = 0; x < width; x += 1) {
              const start = x * samplesPerPixel;
              let min = 1;
              let max = -1;
              for (let i = 0; i < samplesPerPixel && start + i < samples.length; i += 1) {
                const sample = samples[start + i];
                min = Math.min(min, sample);
                max = Math.max(max, sample);
              }
              next.push({ min, max });
            }
            return next;
          }

          function peaksFromBytes() {
            const width = Math.max(1, Math.floor(waveform.getBoundingClientRect().width));
            const step = Math.max(1, Math.floor(bytes.length / width));
            const next = [];
            for (let x = 0; x < width; x += 1) {
              const start = x * step;
              let high = 0;
              for (let i = 0; i < step && start + i < bytes.length; i += 1) {
                high = Math.max(high, Math.abs(bytes[start + i] - 128) / 128);
              }
              const shaped = Math.max(0.04, Math.min(0.88, Math.pow(high, 0.72)));
              next.push({ min: -shaped, max: shaped });
            }
            return next;
          }

          async function renderWaveform() {
            syncColors();
            drawEmptyWaveform();
            try {
              const context = new (window.AudioContext || window.webkitAudioContext)();
              const decoded = await context.decodeAudioData(bytes.buffer.slice(0));
              peaks = peaksFromDecoded(decoded);
              await context.close();
            } catch (_) {
              peaks = peaksFromBytes();
            }
            update();
          }

          function updatePlayhead(ratio) {
            const rect = waveform.getBoundingClientRect();
            const x = Math.max(0, Math.min(rect.width, ratio * rect.width));
            playhead.style.transform = 'translateX(' + x + 'px)';
          }

          function update() {
            const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
            const ratio = duration > 0 ? audio.currentTime / duration : 0;
            const displayRatio = isScrubbing ? pendingRatio : ratio;
            drawWaveform(displayRatio);
            time.textContent = duration > 0 ? format(audio.currentTime) + ' / ' + format(duration) : format(audio.currentTime);
            durationPill.textContent = duration > 0 ? format(duration) : '0:00';
          }

          function updateWaveform(ratio) {
            const clamped = Math.max(0, Math.min(1, ratio));
            waveform.setAttribute('aria-valuenow', String(Math.round(clamped * 1000)));
            drawWaveform(clamped);
          }

          function ratioFromEvent(event) {
            const rect = waveform.getBoundingClientRect();
            if (rect.width <= 0) return 0;
            return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
          }

          function seekToRatio(ratio) {
            const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
            if (duration <= 0) return;
            audio.currentTime = Math.max(0, Math.min(duration, ratio * duration));
            update();
          }

          toggle.addEventListener('click', async () => {
            try {
              if (audio.paused) {
                await audio.play();
              } else {
                audio.pause();
              }
            } catch (_) {
              // WebKit can report a non-fatal media error while still allowing WebM playback.
            }
          });
          audio.addEventListener('play', () => {
            toggle.textContent = '❚❚';
            label.textContent = 'Narration playing';
            dot.classList.add('active');
          });
          audio.addEventListener('pause', () => {
            toggle.textContent = '▶';
            label.textContent = 'Narration paused';
            dot.classList.remove('active');
          });
          audio.addEventListener('ended', () => {
            toggle.textContent = '▶';
            label.textContent = 'Narration ready';
            dot.classList.remove('active');
          });
          audio.addEventListener('timeupdate', update);
          audio.addEventListener('loadedmetadata', update);
          audio.addEventListener('error', update);
          window.addEventListener('resize', () => {
            peaks = null;
            renderWaveform();
          });
          waveform.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            isScrubbing = true;
            pendingRatio = ratioFromEvent(event);
            updateWaveform(pendingRatio);
            waveform.setPointerCapture(event.pointerId);
          });
          waveform.addEventListener('pointermove', (event) => {
            if (!isScrubbing) return;
            pendingRatio = ratioFromEvent(event);
            updateWaveform(pendingRatio);
          });
          waveform.addEventListener('pointerup', (event) => {
            pendingRatio = ratioFromEvent(event);
            seekToRatio(pendingRatio);
            isScrubbing = false;
            waveform.releasePointerCapture(event.pointerId);
          });
          waveform.addEventListener('pointercancel', () => {
            isScrubbing = false;
            update();
          });
          waveform.addEventListener('keydown', (event) => {
            const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
            if (duration <= 0) return;
            const step = event.shiftKey ? 5 : 1;
            if (event.key === 'ArrowLeft') {
              event.preventDefault();
              audio.currentTime = Math.max(0, audio.currentTime - step);
              update();
            } else if (event.key === 'ArrowRight') {
              event.preventDefault();
              audio.currentTime = Math.min(duration, audio.currentTime + step);
              update();
            } else if (event.key === 'Home') {
              event.preventDefault();
              audio.currentTime = 0;
              update();
            } else if (event.key === 'End') {
              event.preventDefault();
              audio.currentTime = duration;
              update();
            }
          });
          renderWaveform();
        </script>
      </body>
    </html>
    """
}

private func normalizedAudioMimeType(_ mimeType: String) -> String {
    let value = mimeType.lowercased()
    if value.contains("webm") {
        return "audio/webm"
    }
    if value.contains("mp4") || value.contains("m4a") {
        return "audio/mp4"
    }
    if value.contains("mpeg") || value.contains("mp3") {
        return "audio/mpeg"
    }
    if value.contains("wav") {
        return "audio/wav"
    }
    return "application/octet-stream"
}

private struct ScreenshotAssetView: View {
    let path: String
    let candidatePaths: [String]
    let source: MobileWorkspaceSource
    let githubAccessToken: String?
    let loadAsset: (String) async throws -> Data?
    @State private var data: Data?
    @State private var attemptedLoad = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let data, let image = PlatformImage(data: data) {
                image
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .stroke(CutReadyTheme.border.opacity(0.65), lineWidth: 1)
                    )
            } else {
                AssetReferenceRow(
                    icon: "photo",
                    title: "Screenshot",
                    value: path.assetDisplayName,
                    detail: attemptedLoad ? "\(path) - image not available in mobile snapshot" : path
                )
            }
        }
        .task(id: candidatePaths.joined(separator: "|")) {
            guard data == nil, !candidatePaths.isEmpty else {
                return
            }
            attemptedLoad = true
            for candidate in candidatePaths {
                if let fetchedData = try? await loadAsset(candidate) {
                    data = fetchedData
                    return
                }
            }

            guard let githubAccessToken else {
                return
            }

            let client = GitHubMobileClient()
            for candidate in candidatePaths {
                if let fetchedData = try? await client.standardImageAsset(path: candidate, source: source, accessToken: githubAccessToken) {
                    data = fetchedData
                    return
                }
            }
        }
    }
}

private struct PlatformImage: View {
    let image: Image

    init?(data: Data) {
        #if canImport(UIKit)
        guard let uiImage = UIImage(data: data) else {
            return nil
        }
        image = Image(uiImage: uiImage)
        #elseif canImport(AppKit)
        guard let nsImage = NSImage(data: data) else {
            return nil
        }
        image = Image(nsImage: nsImage)
        #else
        return nil
        #endif
    }

    var body: some View {
        image
    }

    func resizable() -> Image {
        image.resizable()
    }
}

private struct SketchMarkdownCard: View {
    let markdown: String
    let emptyLabel: String

    var body: some View {
        SketchMarkdownContent(markdown: markdown, emptyLabel: emptyLabel)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(CutReadyTheme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

private struct SketchMarkdownContent: View {
    let markdown: String
    let emptyLabel: String

    private var trimmedMarkdown: String {
        markdown.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        if trimmedMarkdown.isEmpty {
            Text(emptyLabel)
                .font(.subheadline)
                .foregroundStyle(CutReadyTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            Markdown(trimmedMarkdown)
                .markdownTheme(.cutReadyMobile)
                .tint(CutReadyTheme.accent)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct AssetEmptyState: View {
    var body: some View {
        Text("No screenshot or visual attached.")
            .font(.caption)
            .foregroundStyle(CutReadyTheme.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(CutReadyTheme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(CutReadyTheme.border.opacity(0.7), style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
            )
    }
}

private struct AssetReferenceRow: View {
    let icon: String
    let title: String
    let value: String
    var detail: String?

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .foregroundStyle(CutReadyTheme.note)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(CutReadyTheme.text)
                Text(value)
                    .font(.caption)
                    .foregroundStyle(CutReadyTheme.textSecondary)
                    .lineLimit(3)

                if let detail, !detail.isEmpty, detail != value {
                    Text(detail)
                        .font(.caption2)
                        .foregroundStyle(CutReadyTheme.textSecondary.opacity(0.82))
                        .lineLimit(2)
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CutReadyTheme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

private struct SketchLayoutSheet: View {
    @Binding var layout: SketchReaderLayout
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("Show sections") {
                    ForEach(SketchReaderSection.allCases) { section in
                        Toggle(section.label, isOn: Binding(
                            get: { layout.visible.contains(section) },
                            set: { isVisible in
                                layout.set(section, visible: isVisible)
                            }
                        ))
                    }
                }

                Section("Order") {
                    ForEach(layout.order) { section in
                        HStack {
                            Label(section.label, systemImage: section.icon)
                            Spacer()
                            Button {
                                layout.move(section, direction: -1)
                            } label: {
                                Image(systemName: "chevron.up")
                            }
                            .disabled(layout.order.first == section)
                            .buttonStyle(.borderless)
                            .accessibilityLabel("Move \(section.label) up")

                            Button {
                                layout.move(section, direction: 1)
                            } label: {
                                Image(systemName: "chevron.down")
                            }
                            .disabled(layout.order.last == section)
                            .buttonStyle(.borderless)
                            .accessibilityLabel("Move \(section.label) down")
                        }
                    }
                }
            }
            .navigationTitle("Sketch layout")
            .toolbar {
                ToolbarItem {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
        }
    }
}

private enum SketchReaderSection: String, CaseIterable, Codable, Identifiable, Sendable {
    case assets
    case narration
    case narrative
    case actions

    var id: String { rawValue }

    var label: String {
        switch self {
        case .assets:
            return "Assets"
        case .narration:
            return "Narration"
        case .narrative:
            return "Narrative"
        case .actions:
            return "Actions"
        }
    }

    var icon: String {
        switch self {
        case .assets:
            return "photo.on.rectangle.angled"
        case .narration:
            return "waveform"
        case .narrative:
            return "text.quote"
        case .actions:
            return "cursorarrow.click.2"
        }
    }
}

private struct SketchReaderLayout: Codable, Equatable {
    var order: [SketchReaderSection] = [.assets, .narration, .narrative, .actions]
    var visible: Set<SketchReaderSection> = Set(SketchReaderSection.allCases)

    var visibleSections: [SketchReaderSection] {
        normalized.order.filter { normalized.visible.contains($0) }
    }

    var normalized: SketchReaderLayout {
        let originalOrder = Set(order)
        var copy = self

        var seen = Set<SketchReaderSection>()
        copy.order = copy.order.filter { section in
            guard SketchReaderSection.allCases.contains(section), !seen.contains(section) else {
                return false
            }
            seen.insert(section)
            return true
        }
        copy.visible.formIntersection(Set(SketchReaderSection.allCases))

        for section in SketchReaderSection.allCases where !copy.order.contains(section) {
            if section == .narration, let assetsIndex = copy.order.firstIndex(of: .assets) {
                copy.order.insert(section, at: min(copy.order.endIndex, assetsIndex + 1))
            } else {
                copy.order.append(section)
            }
            if !originalOrder.contains(section) {
                copy.visible.insert(section)
            }
        }
        return copy
    }

    mutating func set(_ section: SketchReaderSection, visible isVisible: Bool) {
        self = normalized
        if isVisible {
            visible.insert(section)
        } else {
            visible.remove(section)
        }
        self = normalized
    }

    mutating func move(_ section: SketchReaderSection, direction: Int) {
        self = normalized
        guard
            let index = order.firstIndex(of: section),
            order.indices.contains(index + direction)
        else {
            return
        }
        order.swapAt(index, index + direction)
        self = normalized
    }
}

private enum SketchReaderLayoutStore {
    private static let key = "com.cutready.companion.sketchReaderLayout"

    static func load(defaults: UserDefaults = .standard) -> SketchReaderLayout {
        guard let data = defaults.data(forKey: key) else {
            return SketchReaderLayout()
        }
        return ((try? JSONDecoder().decode(SketchReaderLayout.self, from: data)) ?? SketchReaderLayout()).normalized
    }

    static func save(_ layout: SketchReaderLayout, defaults: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(layout.normalized) else {
            return
        }
        defaults.set(data, forKey: key)
    }
}

private extension RowNarration {
    var isWebM: Bool {
        let path = path.lowercased()
        return path.hasSuffix(".webm") || (mimeType?.localizedCaseInsensitiveContains("webm") ?? false)
    }

    var formattedDuration: String? {
        guard let durationMs else {
            return nil
        }
        let totalSeconds = Int((Double(durationMs) / 1000.0).rounded())
        let minutes = totalSeconds / 60
        let seconds = totalSeconds % 60
        return "\(minutes):\(String(format: "%02d", seconds))"
    }

    var formattedByteSize: String? {
        guard let byteSize else {
            return nil
        }
        if byteSize >= 1_000_000 {
            return String(format: "%.1f MB", Double(byteSize) / 1_000_000.0)
        }
        return "\(Int((Double(byteSize) / 1000.0).rounded())) KB"
    }

    var inferredMimeType: String {
        let lowercasedPath = path.lowercased()
        if lowercasedPath.hasSuffix(".webm") {
            return "audio/webm"
        }
        if lowercasedPath.hasSuffix(".m4a") {
            return "audio/mp4"
        }
        if lowercasedPath.hasSuffix(".mp3") {
            return "audio/mpeg"
        }
        if lowercasedPath.hasSuffix(".wav") {
            return "audio/wav"
        }
        return "application/octet-stream"
    }
}

private struct VisualAssetSummary {
    var title: String
    var subtitle: String
}

private extension JSONValue {
    var mobileDisplayText: String? {
        switch self {
        case .string(let value):
            return value
        case .number(let value):
            return String(value)
        case .bool(let value):
            return value ? "true" : "false"
        case .array, .object:
            return nil
        case .null:
            return nil
        }
    }

    var visualSummary: VisualAssetSummary {
        guard case .object(let object) = self else {
            return VisualAssetSummary(title: "Elucim visual", subtitle: "Visual DSL attached")
        }

        let title = object.stringValue(for: ["title", "name", "label"]) ?? "Elucim visual"
        if let kind = object.stringValue(for: ["kind", "type"]) {
            return VisualAssetSummary(title: title, subtitle: kind.replacingOccurrences(of: "_", with: " ").capitalized)
        }
        return VisualAssetSummary(title: title, subtitle: "Visual DSL attached")
    }
}

private extension Dictionary where Key == String, Value == JSONValue {
    func stringValue(for keys: [String]) -> String? {
        for key in keys {
            if case .string(let value) = self[key] {
                let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    return trimmed
                }
            }
        }
        return nil
    }
}

private extension String {
    var assetDisplayName: String {
        URL(fileURLWithPath: self).lastPathComponent
    }

    var mobileNormalizedPath: String {
        replacingOccurrences(of: "\\", with: "/")
            .split(separator: "/", omittingEmptySubsequences: true)
            .joined(separator: "/")
    }

    var mobileDeletingLastPathComponent: String {
        let normalized = mobileNormalizedPath
        guard let slash = normalized.lastIndex(of: "/") else {
            return ""
        }
        return String(normalized[..<slash])
    }
}

private extension Array where Element == StoryboardItem {
    var mobileSketchCount: Int {
        reduce(0) { count, item in
            switch item {
            case .sketchRef:
                return count + 1
            case .section(_, _, let sketches):
                return count + sketches.count
            }
        }
    }

    var mobileSectionCount: Int {
        filter { item in
            if case .section = item {
                return true
            }
            return false
        }.count
    }
}

private struct NoteDetailView: View {
    let path: String
    let note: FileSummary?
    let fallbackTitle: String
    let syncStatus: MobileSyncStatus
    let onOpenSync: () -> Void
    let onSave: (String) async throws -> Void
    @State private var isEditing = false
    @State private var draft: String
    @State private var isSaving = false
    @State private var saveError: String?

    init(
        path: String,
        note: FileSummary?,
        fallbackTitle: String,
        syncStatus: MobileSyncStatus,
        onOpenSync: @escaping () -> Void,
        onSave: @escaping (String) async throws -> Void
    ) {
        self.path = path
        self.note = note
        self.fallbackTitle = fallbackTitle
        self.syncStatus = syncStatus
        self.onOpenSync = onOpenSync
        self.onSave = onSave
        _draft = State(initialValue: note?.contents ?? "")
    }

    var body: some View {
        let parsedNote = parseNoteDocument(draft)

        VStack(spacing: 0) {
            if isEditing {
                TextEditor(text: $draft)
                    .font(.body)
                    .foregroundStyle(CutReadyTheme.text)
                    .scrollContentBackground(.hidden)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(CutReadyTheme.surface)
            } else {
                MarkdownPreview(document: parsedNote)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(CutReadyTheme.surface)
            }
        }
        .navigationTitle(note?.title ?? fallbackTitle)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem {
                WorkspaceSyncToolbarButton(status: syncStatus, action: onOpenSync)
            }

            ToolbarItem {
                Button(isEditing ? "Preview" : "Edit") {
                    isEditing.toggle()
                }
            }

            if isEditing {
                ToolbarItem {
                    Button(isSaving ? "Saving" : "Save") {
                        save()
                    }
                    .disabled(isSaving || draft == (note?.contents ?? ""))
                }
            }
        }
        .alert("Could not save note", isPresented: Binding(
            get: { saveError != nil },
            set: { if !$0 { saveError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(saveError ?? "")
        }
        .onChange(of: note?.contents) { oldContents, newContents in
            guard !isEditing, draft == (oldContents ?? "") else {
                return
            }
            draft = newContents ?? ""
        }
    }

    private func save() {
        Task {
            do {
                isSaving = true
                try await onSave(draft)
                await MainActor.run {
                    isEditing = false
                    saveError = nil
                }
            } catch {
                await MainActor.run {
                    saveError = error.localizedDescription
                }
            }
            await MainActor.run {
                isSaving = false
            }
        }
    }
}

private struct MarkdownPreview: View {
    let document: ParsedNoteDocument

    var body: some View {
        if document.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && document.metadata.fields.isEmpty {
            ContentUnavailableView(
                "Empty note",
                systemImage: "note.text",
                description: Text("Switch to Edit to start drafting.")
            )
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    NoteMetadataPreview(metadata: document.metadata)

                    if document.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Text("Nothing to preview")
                            .font(.callout)
                            .foregroundStyle(CutReadyTheme.textSecondary)
                            .italic()
                    } else {
                        Markdown(document.body)
                            .markdownTheme(.cutReadyMobile)
                            .tint(CutReadyTheme.accent)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(CutReadyTheme.surface)
        }
    }
}

private struct NoteMetadataPreview: View {
    let metadata: NoteDocumentMetadata

    private var fields: [(key: String, value: String)] {
        metadata.fields
            .map { (key: $0.key, value: $0.value) }
            .sorted { $0.key.localizedCaseInsensitiveCompare($1.key) == .orderedAscending }
    }

    var body: some View {
        if !fields.isEmpty {
            VStack(alignment: .leading, spacing: 7) {
                Text("Properties")
                    .font(.caption2.weight(.semibold))
                    .textCase(.uppercase)
                    .tracking(1.6)
                    .foregroundStyle(CutReadyTheme.textSecondary.opacity(0.72))

                VStack(spacing: 0) {
                    ForEach(fields, id: \.key) { field in
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            Text(field.key)
                                .font(.caption.weight(.medium))
                                .foregroundStyle(CutReadyTheme.textSecondary.opacity(0.72))
                                .frame(width: 92, alignment: .leading)

                            Text(field.value)
                                .font(.caption)
                                .foregroundStyle(CutReadyTheme.textSecondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(.vertical, 6)

                        if field.key != fields.last?.key {
                            Divider().overlay(CutReadyTheme.border.opacity(0.55))
                        }
                    }
                }
            }
            .padding(12)
            .background(CutReadyTheme.surfaceAlt.opacity(0.35), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(CutReadyTheme.border.opacity(0.55), lineWidth: 1)
            )
        }
    }
}

private extension Theme {
    static let cutReadyMobile = Theme()
        .text {
            ForegroundColor(CutReadyTheme.text)
            FontSize(15)
        }
        .strong {
            FontWeight(.semibold)
        }
        .link {
            ForegroundColor(CutReadyTheme.accent)
        }
        .code {
            FontFamilyVariant(.monospaced)
            FontSize(.em(0.86))
            BackgroundColor(CutReadyTheme.surfaceInset)
        }
        .heading1 { configuration in
            VStack(alignment: .leading, spacing: 0) {
                configuration.label
                    .relativeLineSpacing(.em(0.08))
                    .markdownMargin(top: 4, bottom: 10)
                    .markdownTextStyle {
                        FontWeight(.semibold)
                        FontSize(.em(1.55))
                        ForegroundColor(CutReadyTheme.text)
                    }
                Divider().overlay(CutReadyTheme.border.opacity(0.85))
            }
        }
        .heading2 { configuration in
            configuration.label
                .relativeLineSpacing(.em(0.08))
                .markdownMargin(top: 18, bottom: 8)
                .markdownTextStyle {
                    FontWeight(.semibold)
                    FontSize(.em(1.22))
                    ForegroundColor(CutReadyTheme.text)
                }
        }
        .heading3 { configuration in
            configuration.label
                .relativeLineSpacing(.em(0.08))
                .markdownMargin(top: 16, bottom: 6)
                .markdownTextStyle {
                    FontWeight(.semibold)
                    FontSize(.em(1.08))
                    ForegroundColor(CutReadyTheme.text)
                }
        }
        .paragraph { configuration in
            configuration.label
                .fixedSize(horizontal: false, vertical: true)
                .relativeLineSpacing(.em(0.22))
                .markdownMargin(top: 0, bottom: 10)
        }
        .blockquote { configuration in
            HStack(spacing: 0) {
                RoundedRectangle(cornerRadius: 4)
                    .fill(CutReadyTheme.note.opacity(0.45))
                    .relativeFrame(width: .em(0.18))
                configuration.label
                    .markdownTextStyle {
                        ForegroundColor(CutReadyTheme.textSecondary)
                    }
                    .relativePadding(.horizontal, length: .em(0.8))
            }
            .fixedSize(horizontal: false, vertical: true)
            .markdownMargin(top: 4, bottom: 10)
        }
        .codeBlock { configuration in
            ScrollView(.horizontal) {
                configuration.label
                    .fixedSize(horizontal: false, vertical: true)
                    .relativeLineSpacing(.em(0.18))
                    .markdownTextStyle {
                        FontFamilyVariant(.monospaced)
                        FontSize(.em(0.85))
                    }
                    .padding(12)
            }
            .background(CutReadyTheme.surfaceInset)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .markdownMargin(top: 2, bottom: 12)
        }
        .listItem { configuration in
            configuration.label
                .markdownMargin(top: .em(0.15), bottom: .em(0.15))
        }
        .table { configuration in
            configuration.label
                .fixedSize(horizontal: false, vertical: true)
                .markdownTableBorderStyle(.init(color: CutReadyTheme.border))
                .markdownTableBackgroundStyle(
                    .alternatingRows(CutReadyTheme.surface, CutReadyTheme.surfaceAlt.opacity(0.6))
                )
                .markdownMargin(top: 2, bottom: 12)
        }
        .tableCell { configuration in
            configuration.label
                .markdownTextStyle {
                    if configuration.row == 0 {
                        FontWeight(.semibold)
                    }
                    BackgroundColor(nil)
                }
                .fixedSize(horizontal: false, vertical: true)
                .padding(.vertical, 5)
                .padding(.horizontal, 8)
                .relativeLineSpacing(.em(0.16))
        }
        .thematicBreak {
            Divider()
                .overlay(CutReadyTheme.border)
                .markdownMargin(top: 14, bottom: 14)
        }
}

private struct DetailHeader: View {
    let title: String
    let icon: String
    let tint: Color
    let path: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                CutReadyDocumentIcon(icon, tint: tint, size: 28)
                Text(title)
                    .font(.title.weight(.semibold))
                    .foregroundStyle(CutReadyTheme.text)
            }
            Text(path)
                .font(.caption)
                .foregroundStyle(CutReadyTheme.textSecondary)
        }
    }
}

private struct DocumentLinkLabel: View {
    let title: String
    let icon: String
    let tint: Color

    var body: some View {
        HStack(spacing: 16) {
            CutReadyDocumentIcon(icon, tint: tint)
            Text(title)
                .foregroundStyle(tint)
        }
    }
}
