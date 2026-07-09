import Foundation

private actor DraftlineWorkspaceOperationGate {
    private var isRunning = false

    func run<T>(_ operation: @Sendable () async throws -> T) async throws -> T {
        guard !isRunning else {
            throw DraftlineMobileBridgeError.operationInProgress
        }
        isRunning = true
        defer { isRunning = false }
        return try await operation()
    }
}

public final class DraftlineMobileWorkspaceStore: @unchecked Sendable {
    private let client: DraftlineMobileWorkspaceClient
    private let operationGate = DraftlineWorkspaceOperationGate()
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
        try await operationGate.run {
            try await self.openWorkspaceUnlocked(repository: repository, accessToken: accessToken, progress: progress)
        }
    }

    public func snapshot() async throws -> MobileWorkspaceSnapshot {
        try await operationGate.run {
            try await self.snapshotUnlocked()
        }
    }

    public func saveNote(_ markdown: String, path: String, label: String? = nil) async throws -> MobileWorkspaceSnapshot {
        try await operationGate.run {
            try await self.saveNoteUnlocked(markdown, path: path, label: label)
        }
    }

    public func saveSketch(_ sketch: Sketch, path: String, label: String? = nil) async throws -> MobileWorkspaceSnapshot {
        try await operationGate.run {
            try await self.saveSketchUnlocked(sketch, path: path, label: label)
        }
    }

    public func readAsset(path: String) async throws -> Data? {
        try await operationGate.run {
            try await self.client.readAsset(path: path)
        }
    }

    public func syncStatus() async throws -> MobileSyncStatus {
        try await operationGate.run {
            try await self.refreshedSyncStatusUnlocked()
        }
    }

    public func cachedSyncStatus() async throws -> MobileSyncStatus {
        try await operationGate.run {
            try await self.client.syncStatus()
        }
    }

    public func pull() async throws -> (MobileSyncStatus, MobileWorkspaceSnapshot) {
        try await operationGate.run {
            let status = try await self.client.pull()
            return (status, try await self.snapshotUnlocked())
        }
    }

    public func push() async throws -> (MobileSyncStatus, MobileWorkspaceSnapshot) {
        try await operationGate.run {
            let status = try await self.client.push()
            return (status, try await self.snapshotUnlocked())
        }
    }

    public func syncNow() async throws -> (MobileSyncStatus, MobileWorkspaceSnapshot) {
        try await operationGate.run {
            try await self.syncNowUnlocked()
        }
    }

    public func shelveLocalEditsAndSyncLatest() async throws -> (MobileShelf, MobileSyncStatus, MobileWorkspaceSnapshot) {
        try await operationGate.run {
            let shelf = try await self.client.shelveAllDirty(name: "CutReady mobile edits")
            let (status, snapshot) = try await self.syncNowUnlocked()
            return (shelf, status, snapshot)
        }
    }

    public func parkLocalEditsAndReloadLatest(
        repository: GitHubRepositorySummary,
        accessToken: String
    ) async throws -> MobileWorkspaceSnapshot {
        try await operationGate.run {
            try await self.parkLocalEditsAndReloadLatestUnlocked(repository: repository, accessToken: accessToken)
        }
    }

    public func listConflicts(refreshRemote: Bool = true) async throws -> [MobileConflict] {
        try await operationGate.run {
            try await self.client.listConflicts(refreshRemote: refreshRemote)
        }
    }

    public func resolveConflicts(
        _ resolutions: [MobileConflictResolutionRequest]
    ) async throws -> (MobileSyncStatus, MobileWorkspaceSnapshot) {
        try await operationGate.run {
            let status = try await self.client.resolveConflicts(resolutions)
            return (status, try await self.snapshotUnlocked())
        }
    }

    private func openWorkspaceUnlocked(
        repository: GitHubRepositorySummary,
        accessToken: String,
        progress: (@Sendable (GitHubWorkspaceOpenProgress) -> Void)? = nil
    ) async throws -> MobileWorkspaceSnapshot {
        progress?(GitHubWorkspaceOpenProgress(phase: .checkingCache))
        let configuration = Self.workspaceConfiguration(repository: repository, accessToken: accessToken)

        progress?(GitHubWorkspaceOpenProgress(phase: .fetchingManifest))
        try await client.openWorkspace(configuration)
        self.descriptor = configuration.workspace
        self.localDirectory = configuration.localDirectory

        progress?(GitHubWorkspaceOpenProgress(phase: .finalizing))
        return try await snapshotUnlocked()
    }

    private func snapshotUnlocked() async throws -> MobileWorkspaceSnapshot {
        guard let descriptor else {
            throw DraftlineMobileBridgeError.workspaceNotOpen
        }

        let documents = try await client.listDocuments()
        let projects = Self.projectEntries(
            notes: documents.notes,
            sketches: documents.sketches,
            storyboards: documents.storyboards,
            workspaceName: descriptor.name,
            localDirectory: localDirectory
        )

        return MobileWorkspaceSnapshot(
            descriptor: descriptor,
            projects: projects,
            activeProjectPath: projects.first?.path ?? ".",
            storyboards: documents.storyboards,
            sketches: documents.sketches,
            notes: documents.notes
        )
    }

    private func saveNoteUnlocked(_ markdown: String, path: String, label: String? = nil) async throws -> MobileWorkspaceSnapshot {
        let original = try? await client.readNote(path: path)
        try await client.writeNote(markdown, path: path)
        do {
            try await client.saveSnapshot(label: label ?? "Update \(path)")
        } catch {
            try await restoreNote(original, path: path, after: error)
        }
        return try await snapshotUnlocked()
    }

    private func saveSketchUnlocked(_ sketch: Sketch, path: String, label: String? = nil) async throws -> MobileWorkspaceSnapshot {
        let original = try? await client.readSketch(path: path)
        try await client.writeSketch(sketch, path: path)
        do {
            try await client.saveSnapshot(label: label ?? "Update \(path)")
        } catch {
            try await restoreSketch(original, path: path, after: error)
        }
        return try await snapshotUnlocked()
    }

    private func syncNowUnlocked() async throws -> (MobileSyncStatus, MobileWorkspaceSnapshot) {
        let status = try await refreshedSyncStatusUnlocked()
        switch status.state {
        case .clean, .offline, .conflict, .pulling, .pushing:
            return (status, try await snapshotUnlocked())
        case .dirty:
            let pushStatus = try await client.push()
            return (pushStatus, try await snapshotUnlocked())
        case .incoming:
            let pullStatus = try await client.pull()
            guard pullStatus.state == .dirty else {
                return (pullStatus, try await snapshotUnlocked())
            }
            let pushStatus = try await client.push()
            return (pushStatus, try await snapshotUnlocked())
        }
    }

    private func refreshedSyncStatusUnlocked() async throws -> MobileSyncStatus {
        do {
            try await client.refreshRemote()
        } catch {
            var status = try await client.syncStatus()
            status.state = .offline
            status.message = "Offline. \(error.localizedDescription)"
            return status
        }
        return try await client.syncStatus()
    }

    private func parkLocalEditsAndReloadLatestUnlocked(
        repository: GitHubRepositorySummary,
        accessToken: String
    ) async throws -> MobileWorkspaceSnapshot {
        guard let currentDirectory = localDirectory else {
            throw DraftlineMobileBridgeError.workspaceNotOpen
        }

        let currentConfiguration = Self.workspaceConfiguration(
            repository: repository,
            accessToken: accessToken,
            localDirectory: currentDirectory
        )
        let stagedDirectory = Self.stagedReloadDirectory(for: currentDirectory)
        let stagedConfiguration = Self.workspaceConfiguration(
            repository: repository,
            accessToken: accessToken,
            localDirectory: stagedDirectory
        )
        try? FileManager.default.removeItem(at: stagedDirectory)

        try await client.closeWorkspace()
        do {
            try await client.openWorkspace(stagedConfiguration)
            descriptor = stagedConfiguration.workspace
            localDirectory = stagedDirectory
            _ = try await snapshotUnlocked()
        } catch {
            try? FileManager.default.removeItem(at: stagedDirectory)
            try await restoreOpenWorkspace(currentConfiguration, after: error)
        }

        try await client.closeWorkspace()
        let parkedDirectory: URL
        do {
            parkedDirectory = try Self.parkWorkspaceDirectory(currentDirectory)
        } catch {
            try? FileManager.default.removeItem(at: stagedDirectory)
            try await restoreOpenWorkspace(currentConfiguration, after: error)
        }

        do {
            try FileManager.default.moveItem(at: stagedDirectory, to: currentDirectory)
            try await client.openWorkspace(currentConfiguration)
            descriptor = currentConfiguration.workspace
            localDirectory = currentDirectory
            return try await snapshotUnlocked()
        } catch {
            try? FileManager.default.removeItem(at: stagedDirectory)
            try await restoreParkedWorkspace(
                parkedDirectory,
                to: currentDirectory,
                configuration: currentConfiguration,
                after: error
            )
        }
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

    private static func workspaceConfiguration(
        repository: GitHubRepositorySummary,
        accessToken: String,
        localDirectory: URL? = nil
    ) -> DraftlineMobileWorkspaceConfiguration {
        let descriptor = MobileWorkspaceDescriptor(
            id: repository.fullName,
            name: repository.name,
            source: .github(repository.repositoryRef)
        )
        return DraftlineMobileWorkspaceConfiguration(
            workspace: descriptor,
            localDirectory: localDirectory ?? DraftlineNativeMobileClient.defaultWorkspaceDirectory(for: descriptor),
            remoteURL: URL(string: "https://github.com/\(repository.fullName).git"),
            branch: repository.defaultBranch,
            credential: .usernamePassword(username: "x-access-token", password: accessToken)
        )
    }

    private func restoreNote(_ original: String?, path: String, after error: Error) async throws -> Never {
        guard let original else {
            throw error
        }
        do {
            try await client.writeNote(original, path: path)
        } catch {
            throw DraftlineMobileBridgeError.nativeFailure(
                "Saving \(path) failed, and CutReady could not restore the previous local note contents: \(error.localizedDescription)"
            )
        }
        throw error
    }

    private func restoreSketch(_ original: Sketch?, path: String, after error: Error) async throws -> Never {
        guard let original else {
            throw error
        }
        do {
            try await client.writeSketch(original, path: path)
        } catch {
            throw DraftlineMobileBridgeError.nativeFailure(
                "Saving \(path) failed, and CutReady could not restore the previous local sketch contents: \(error.localizedDescription)"
            )
        }
        throw error
    }

    private func restoreOpenWorkspace(
        _ configuration: DraftlineMobileWorkspaceConfiguration,
        after error: Error
    ) async throws -> Never {
        do {
            try await client.openWorkspace(configuration)
            descriptor = configuration.workspace
            localDirectory = configuration.localDirectory
        } catch {
            throw DraftlineMobileBridgeError.nativeFailure(
                "Reload failed, and CutReady could not reopen the previous mobile workspace: \(error.localizedDescription)"
            )
        }
        throw error
    }

    private func restoreParkedWorkspace(
        _ parkedDirectory: URL,
        to localDirectory: URL,
        configuration: DraftlineMobileWorkspaceConfiguration,
        after error: Error
    ) async throws -> Never {
        do {
            try? await client.closeWorkspace()
            try? FileManager.default.removeItem(at: localDirectory)
            try FileManager.default.moveItem(at: parkedDirectory, to: localDirectory)
            try await client.openWorkspace(configuration)
            descriptor = configuration.workspace
            self.localDirectory = localDirectory
        } catch {
            throw DraftlineMobileBridgeError.nativeFailure(
                "Reload failed, and CutReady could not restore the parked mobile workspace: \(error.localizedDescription)"
            )
        }
        throw error
    }

    private static func stagedReloadDirectory(for localDirectory: URL) -> URL {
        localDirectory
            .deletingLastPathComponent()
            .appendingPathComponent(".reload-staging", isDirectory: true)
            .appendingPathComponent("\(localDirectory.lastPathComponent)-\(UUID().uuidString)", isDirectory: true)
    }

    private static func parkWorkspaceDirectory(_ localDirectory: URL) throws -> URL {
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: localDirectory.path) else {
            return localDirectory
        }

        let parkedRoot = localDirectory
            .deletingLastPathComponent()
            .appendingPathComponent(".parked-mobile-edits", isDirectory: true)
        try fileManager.createDirectory(at: parkedRoot, withIntermediateDirectories: true)

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let safeTimestamp = formatter
            .string(from: Date())
            .replacingOccurrences(of: ":", with: "-")
        let parkedDirectory = parkedRoot.appendingPathComponent("\(localDirectory.lastPathComponent)-\(safeTimestamp)-\(UUID().uuidString)", isDirectory: true)
        try fileManager.moveItem(at: localDirectory, to: parkedDirectory)
        return parkedDirectory
    }
}
