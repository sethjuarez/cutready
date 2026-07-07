import Foundation

public final class DraftlineMobileWorkspaceStore: @unchecked Sendable {
    private let client: DraftlineMobileWorkspaceClient
    private var descriptor: MobileWorkspaceDescriptor?
    private var localDirectory: URL?

    public init(client: DraftlineMobileWorkspaceClient = DraftlineNativeMobileClient()) {
        self.client = client
    }

    public func openWorkspace(
        repository: GitHubRepositorySummary,
        accessToken: String,
        progress: (@Sendable (GitHubWorkspaceOpenProgress) -> Void)? = nil
    ) async throws -> MobileWorkspaceSnapshot {
        progress?(GitHubWorkspaceOpenProgress(phase: .checkingCache))
        let descriptor = MobileWorkspaceDescriptor(
            id: repository.fullName,
            name: repository.name,
            source: .github(repository.repositoryRef)
        )
        let configuration = DraftlineMobileWorkspaceConfiguration(
            workspace: descriptor,
            localDirectory: DraftlineNativeMobileClient.defaultWorkspaceDirectory(for: descriptor),
            remoteURL: URL(string: "https://github.com/\(repository.fullName).git"),
            branch: repository.defaultBranch,
            credential: .usernamePassword(username: "x-access-token", password: accessToken)
        )

        progress?(GitHubWorkspaceOpenProgress(phase: .fetchingManifest))
        try await client.openWorkspace(configuration)
        self.descriptor = descriptor
        self.localDirectory = configuration.localDirectory

        progress?(GitHubWorkspaceOpenProgress(phase: .finalizing))
        return try await snapshot()
    }

    public func snapshot() async throws -> MobileWorkspaceSnapshot {
        guard let descriptor else {
            throw DraftlineMobileBridgeError.workspaceNotOpen
        }

        let storyboards = try await client.listStoryboards()
        let sketches = try await client.listSketches()
        let notes = try await client.listNotes()
        let projects = Self.projectEntries(
            notes: notes,
            sketches: sketches,
            storyboards: storyboards,
            workspaceName: descriptor.name,
            localDirectory: localDirectory
        )

        return MobileWorkspaceSnapshot(
            descriptor: descriptor,
            projects: projects,
            activeProjectPath: projects.first?.path ?? ".",
            storyboards: storyboards,
            sketches: sketches,
            notes: notes
        )
    }

    public func saveNote(_ markdown: String, path: String, label: String? = nil) async throws -> MobileWorkspaceSnapshot {
        try await client.writeNote(markdown, path: path)
        try await client.saveSnapshot(label: label ?? "Update \(path)")
        return try await snapshot()
    }

    public func saveSketch(_ sketch: Sketch, path: String, label: String? = nil) async throws -> MobileWorkspaceSnapshot {
        try await client.writeSketch(sketch, path: path)
        try await client.saveSnapshot(label: label ?? "Update \(path)")
        return try await snapshot()
    }

    public func readAsset(path: String) async throws -> Data? {
        try await client.readAsset(path: path)
    }

    public func syncStatus() async throws -> MobileSyncStatus {
        try await client.syncStatus()
    }

    public func pull() async throws -> (MobileSyncStatus, MobileWorkspaceSnapshot) {
        let status = try await client.pull()
        return (status, try await snapshot())
    }

    public func push() async throws -> (MobileSyncStatus, MobileWorkspaceSnapshot) {
        let status = try await client.push()
        return (status, try await snapshot())
    }

    private static func projectEntries(
        notes: [FileSummary],
        sketches: [FileSummary],
        storyboards: [FileSummary],
        workspaceName: String,
        localDirectory: URL?
    ) -> [MobileProjectEntry] {
        if let localDirectory,
           let manifest = try? Data(contentsOf: localDirectory.appendingPathComponent(".cutready/projects.json")),
           let decoded = try? JSONDecoder().decode(CutReadyMobileProjectManifest.self, from: manifest),
           !decoded.projects.isEmpty {
            return decoded.projects
        }

        let paths = (notes + sketches + storyboards).map(\.path)
        let inferredRoots = Set(paths.compactMap { path -> String? in
            let components = path.split(separator: "/").map(String.init)
            guard components.count > 1 else {
                return nil
            }
            return components[0]
        })

        guard !inferredRoots.isEmpty else {
            return [MobileProjectEntry(path: ".", name: workspaceName)]
        }

        return inferredRoots.sorted().map { root in
            MobileProjectEntry(path: root, name: root)
        }
    }

    private struct CutReadyMobileProjectManifest: Decodable {
        var projects: [MobileProjectEntry]
    }
}
