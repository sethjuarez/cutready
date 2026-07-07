import CutReadyMobileCore
import MarkdownUI
import SwiftUI

public struct CompanionRootView: View {
    @State private var project: CompanionProject?
    @State private var githubClientID: String
    @State private var githubAccessToken: String?
    @State private var githubDeviceAuthorization: GitHubDeviceAuthorization?
    @State private var githubRepositories: [GitHubRepositorySummary] = []
    @State private var recentWorkspaces: [RecentWorkspace] = []
    @State private var isSigningIn = false
    @State private var isLoadingRepositories = false
    @State private var isOpeningWorkspace = false
    @State private var isShowingWorkspaceMenu = false
    @State private var isShowingRepositories = false
    @State private var workspaceNavigationPath = NavigationPath()
    @State private var authError: String?
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
                        onOpenMenu: { isShowingWorkspaceMenu = true }
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
            } else {
                WorkspaceLandingView(
                    isSigningIn: isSigningIn,
                    isOpeningWorkspace: isOpeningWorkspace,
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
                recentWorkspaces: recentWorkspaces,
                repositories: githubRepositories,
                isLoadingRepositories: isLoadingRepositories,
                isOpeningWorkspace: isOpeningWorkspace,
                onOpen: { repository in
                    openGitHubWorkspace(repository)
                }
            )
        }
        .alert("GitHub sign-in failed", isPresented: Binding(
            get: { authError != nil },
            set: { if !$0 { authError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(authError ?? "")
        }
    }

    private static func githubClientIDFromEnvironment() -> String {
        ProcessInfo.processInfo.environment["CUTREADY_GITHUB_OAUTH_CLIENT_ID"] ?? ""
    }

    private func restoreGitHubToken() {
        guard githubAccessToken == nil else {
            return
        }

        do {
            githubAccessToken = try tokenStore.readToken()
        } catch {
            authError = error.localizedDescription
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
                githubRepositories = try await client.listRepositories(accessToken: token.accessToken)
                isShowingRepositories = true
            } catch {
                githubDeviceAuthorization = nil
                authError = error.localizedDescription
            }
            isSigningIn = false
        }
    }

    private func showGitHubWorkspacePicker() {
        guard let githubAccessToken else {
            authError = "Sign in with GitHub before switching workspaces."
            return
        }

        isShowingRepositories = true
        guard githubRepositories.isEmpty else {
            return
        }

        Task {
            do {
                isLoadingRepositories = true
                let client = GitHubMobileClient()
                githubRepositories = try await client.listRepositories(accessToken: githubAccessToken)
            } catch {
                authError = error.localizedDescription
            }
            isLoadingRepositories = false
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
                let client = GitHubMobileClient()
                let snapshot = try await client.openWorkspace(
                    repository: repository,
                    accessToken: githubAccessToken
                )
                project = CompanionProject(snapshot: snapshot)
                workspaceNavigationPath = NavigationPath()
                recentWorkspaceStore.record(repository: repository)
                recentWorkspaces = recentWorkspaceStore.load()
                isShowingRepositories = false
            } catch {
                authError = error.localizedDescription
            }
            isOpeningWorkspace = false
        }
    }

    @ViewBuilder
    private func workspaceDestination(_ selection: CompanionSelection, workspace: CompanionProject) -> some View {
        switch selection {
        case .project(let projectPath):
            ProjectContentsView(project: workspace.switchingProject(to: projectPath))
        case .note(let path):
            NoteDetailView(note: note(for: path, in: workspace), fallbackTitle: title(for: path, in: workspace.allNotes))
        case .sketch(let path):
            SketchDetailView(sketch: sketch(for: path, in: workspace), fallbackTitle: title(for: path, in: workspace.allSketches))
        case .storyboard:
            SelectionDetailView(selection: selection, project: workspace)
        case .rehearse:
            RehearsalPreview(project: workspace)
        }
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
}

private struct WorkspaceProjectsView: View {
    let project: CompanionProject
    let onOpenMenu: () -> Void

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
                                ProjectNavigationRow(
                                    project: workspaceProject,
                                    isActive: project.activeProjectPath == workspaceProject.path
                                )
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
        Button {
        } label: {
            Image(systemName: "arrow.triangle.2.circlepath")
        }
        .accessibilityLabel("Sync workspace")
    }

    private var sourceLabel: String {
        switch project.source {
        case .github(let repository):
            return repository.displayName
        }
    }
}

private struct ProjectNavigationRow: View {
    let project: MobileProjectEntry
    let isActive: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: isActive ? "folder.fill" : "folder")
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

                    Button {
                    } label: {
                        Label("Connect to desktop", systemImage: "desktopcomputer")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.large)
                    .disabled(true)
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
                    ProgressView("Opening workspace")
                        .padding()
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
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
}

private struct GitHubRepositoryPicker: View {
    let recentWorkspaces: [RecentWorkspace]
    let repositories: [GitHubRepositorySummary]
    let isLoadingRepositories: Bool
    let isOpeningWorkspace: Bool
    let onOpen: (GitHubRepositorySummary) -> Void
    @State private var searchText = ""

    var body: some View {
        NavigationStack {
            List {
                if searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !recentWorkspaces.isEmpty {
                    Section("Recently opened") {
                        ForEach(recentWorkspaces) { workspace in
                            repositoryButton(workspace.repository, subtitle: "Recently opened")
                        }
                    }
                }

                Section("Repositories") {
                    ForEach(filteredRepositories) { repository in
                        repositoryButton(repository, subtitle: repository.isPrivate ? "Private GitHub workspace" : "GitHub workspace")
                    }
                }
            }
            .navigationTitle("GitHub Workspaces")
            .searchable(text: $searchText, prompt: "Search repositories")
            .overlay {
                if isLoadingRepositories {
                    ProgressView("Loading repositories")
                        .padding()
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                } else if isOpeningWorkspace {
                    ProgressView("Opening workspace")
                        .padding()
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                } else if repositories.isEmpty {
                    ContentUnavailableView(
                        "No repositories found",
                        systemImage: "folder.badge.questionmark",
                        description: Text("CutReady will show GitHub repositories your account can access.")
                    )
                } else if filteredRepositories.isEmpty {
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

    private var filteredRepositories: [GitHubRepositorySummary] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else {
            return repositories
        }

        return repositories.filter { repository in
            repository.fullName.localizedCaseInsensitiveContains(query)
                || repository.name.localizedCaseInsensitiveContains(query)
        }
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

private struct SketchDetailView: View {
    let sketch: FileSummary?
    let fallbackTitle: String
    @State private var layout = SketchReaderLayoutStore.load()
    @State private var isShowingLayout = false

    private var decodedSketch: Sketch? {
        try? decodeSketch()
    }

    private var unavailableMessage: String {
        do {
            _ = try decodeSketch()
            return "Reopen the workspace to fetch sketch contents for mobile preview."
        } catch {
            return error.localizedDescription
        }
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
                            SketchRowCard(row: row, index: index, layout: layout)
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
                ContentUnavailableView(
                    "Sketch preview unavailable",
                    systemImage: "square.and.pencil",
                    description: Text(unavailableMessage)
                )
                .background(CutReadyTheme.surface)
            }
        }
        .navigationTitle(decodedSketch?.title ?? sketch?.title ?? fallbackTitle)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
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
        .onChange(of: layout) { _, newValue in
            SketchReaderLayoutStore.save(newValue)
        }
    }

    private func sketchHeader(_ sketch: Sketch) -> some View {
        CompanionCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Label(sketch.state.rawValue.replacingOccurrences(of: "_", with: " ").capitalized, systemImage: "square.and.pencil")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(CutReadyTheme.sketch)
                    Spacer()
                    Text("\(sketch.rows.count) rows")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(CutReadyTheme.textSecondary)
                }

                if let description = sketch.description.mobileDisplayText, !description.isEmpty {
                    Text(description)
                        .font(.subheadline)
                        .foregroundStyle(CutReadyTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
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
}

private struct SketchRowCard: View {
    let row: PlanningRow
    let index: Int
    let layout: SketchReaderLayout

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Text("\(index + 1)")
                    .font(.caption.monospacedDigit().weight(.bold))
                    .foregroundStyle(CutReadyTheme.sketch)
                    .frame(width: 26, height: 26)
                    .background(CutReadyTheme.sketch.opacity(0.11), in: Circle())

                Text(row.time.isEmpty ? "Untimed" : row.time)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(CutReadyTheme.textSecondary)

                Spacer()

                if row.locked == true {
                    Image(systemName: "lock.fill")
                        .font(.caption)
                        .foregroundStyle(CutReadyTheme.textSecondary)
                }
            }

            ForEach(layout.visibleSections) { section in
                SketchSectionView(section: section, row: row)
            }
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CutReadyTheme.surfaceAlt.opacity(0.48), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(CutReadyTheme.border.opacity(0.58), lineWidth: 1)
        )
    }
}

private struct SketchSectionView: View {
    let section: SketchReaderSection
    let row: PlanningRow

    var body: some View {
        switch section {
        case .assets:
            assets
        case .narrative:
            textSection(title: "Narrative", icon: "text.quote", text: row.narrative, tint: CutReadyTheme.sketch)
        case .actions:
            textSection(title: "Actions", icon: "cursorarrow.click.2", text: row.demoActions, tint: CutReadyTheme.storyboard)
        }
    }

    private var assets: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("Assets", icon: "photo.on.rectangle.angled", tint: CutReadyTheme.note)

            if row.screenshot == nil && row.visual == nil {
                Text("No screenshot or visual attached.")
                    .font(.caption)
                    .foregroundStyle(CutReadyTheme.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(CutReadyTheme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    if let screenshot = row.screenshot, !screenshot.isEmpty {
                        AssetReferenceRow(icon: "photo", title: "Screenshot", value: screenshot)
                    }

                    if row.visual != nil {
                        AssetReferenceRow(icon: "sparkles", title: "Elucim visual", value: "Visual DSL attached - native rendering next")
                    }
                }
            }
        }
    }

    private func textSection(title: String, icon: String, text: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            sectionTitle(title, icon: icon, tint: tint)
            Text(text.isEmpty ? "Empty" : text)
                .font(.subheadline)
                .foregroundStyle(text.isEmpty ? CutReadyTheme.textSecondary : CutReadyTheme.text)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func sectionTitle(_ title: String, icon: String, tint: Color) -> some View {
        Label(title, systemImage: icon)
            .font(.caption.weight(.semibold))
            .foregroundStyle(tint)
    }
}

private struct AssetReferenceRow: View {
    let icon: String
    let title: String
    let value: String

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

                            Button {
                                layout.move(section, direction: 1)
                            } label: {
                                Image(systemName: "chevron.down")
                            }
                            .disabled(layout.order.last == section)
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
    case narrative
    case actions

    var id: String { rawValue }

    var label: String {
        switch self {
        case .assets:
            return "Assets"
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
        case .narrative:
            return "text.quote"
        case .actions:
            return "cursorarrow.click.2"
        }
    }
}

private struct SketchReaderLayout: Codable, Equatable {
    var order: [SketchReaderSection] = [.assets, .narrative, .actions]
    var visible: Set<SketchReaderSection> = Set(SketchReaderSection.allCases)

    var visibleSections: [SketchReaderSection] {
        order.filter { visible.contains($0) }
    }

    mutating func set(_ section: SketchReaderSection, visible isVisible: Bool) {
        if isVisible {
            visible.insert(section)
        } else {
            visible.remove(section)
        }
    }

    mutating func move(_ section: SketchReaderSection, direction: Int) {
        guard
            let index = order.firstIndex(of: section),
            order.indices.contains(index + direction)
        else {
            return
        }
        order.swapAt(index, index + direction)
    }
}

private enum SketchReaderLayoutStore {
    private static let key = "com.cutready.companion.sketchReaderLayout"

    static func load(defaults: UserDefaults = .standard) -> SketchReaderLayout {
        guard let data = defaults.data(forKey: key) else {
            return SketchReaderLayout()
        }
        return (try? JSONDecoder().decode(SketchReaderLayout.self, from: data)) ?? SketchReaderLayout()
    }

    static func save(_ layout: SketchReaderLayout, defaults: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(layout) else {
            return
        }
        defaults.set(data, forKey: key)
    }
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
}

private struct NoteDetailView: View {
    let note: FileSummary?
    let fallbackTitle: String
    @State private var isEditing = false
    @State private var draft: String

    init(note: FileSummary?, fallbackTitle: String) {
        self.note = note
        self.fallbackTitle = fallbackTitle
        _draft = State(initialValue: note?.contents ?? "")
    }

    var body: some View {
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
                MarkdownPreview(markdown: draft)
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
                Button(isEditing ? "Preview" : "Edit") {
                    isEditing.toggle()
                }
            }
        }
    }
}

private struct MarkdownPreview: View {
    let markdown: String

    var body: some View {
        if markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            ContentUnavailableView(
                "Empty note",
                systemImage: "note.text",
                description: Text("Switch to Edit to start drafting.")
            )
        } else {
            ScrollView {
                Markdown(markdown)
                    .markdownTheme(.cutReadyMobile)
                    .tint(CutReadyTheme.accent)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(CutReadyTheme.surface)
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
