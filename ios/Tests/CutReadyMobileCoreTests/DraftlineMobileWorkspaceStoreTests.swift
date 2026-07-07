import XCTest
@testable import CutReadyMobileCore

final class DraftlineMobileWorkspaceStoreTests: XCTestCase {
    func testSaveNoteWritesThroughDraftlineAndRefreshesSnapshot() async throws {
        let client = MockDraftlineWorkspaceClient()
        client.notes = [
            FileSummary(path: "notes/rehearsal.md", title: "rehearsal", contents: "Before")
        ]
        let store = DraftlineMobileWorkspaceStore(client: client)
        _ = try await store.openWorkspace(
            repository: GitHubRepositorySummary(
                id: 1,
                name: "demo",
                fullName: "owner/demo",
                isPrivate: true,
                defaultBranch: "main",
                updatedAt: nil
            ),
            accessToken: "token"
        )

        let snapshot = try await store.saveNote("After", path: "notes/rehearsal.md")

        XCTAssertEqual(client.writtenNotes["notes/rehearsal.md"], "After")
        XCTAssertEqual(client.savedLabels, ["Update notes/rehearsal.md"])
        XCTAssertEqual(snapshot.notes.first?.contents, "After")
    }

    func testPushReturnsStatusAndSnapshot() async throws {
        let client = MockDraftlineWorkspaceClient()
        client.pushStatus = MobileSyncStatus(state: .clean, ahead: 0, behind: 0, message: "pushed")
        client.sketches = [
            FileSummary(path: "intro.sk", title: "Intro", contents: "{}")
        ]
        let store = DraftlineMobileWorkspaceStore(client: client)
        _ = try await store.openWorkspace(
            repository: GitHubRepositorySummary(
                id: 2,
                name: "demo",
                fullName: "owner/demo",
                isPrivate: false,
                defaultBranch: "main",
                updatedAt: nil
            ),
            accessToken: "token"
        )

        let result = try await store.push()

        XCTAssertEqual(result.0, MobileSyncStatus(state: .clean, message: "pushed"))
        XCTAssertEqual(result.1.sketches.first?.path, "intro.sk")
    }

    func testReadAssetUsesDraftlineWorkspaceClient() async throws {
        let client = MockDraftlineWorkspaceClient()
        client.assetData[".cutready/screenshots/intro.png"] = Data([1, 2, 3])
        let store = DraftlineMobileWorkspaceStore(client: client)

        let data = try await store.readAsset(path: ".cutready/screenshots/intro.png")

        XCTAssertEqual(data, Data([1, 2, 3]))
    }

    func testOpenWorkspaceUsesCutReadyProjectManifestWhenPresent() async throws {
        let descriptor = MobileWorkspaceDescriptor(
            id: "owner/demo",
            name: "demo",
            source: .github(GitHubRepositoryRef(owner: "owner", name: "demo", defaultBranch: "main"))
        )
        let workspaceDirectory = DraftlineNativeMobileClient.defaultWorkspaceDirectory(for: descriptor)
        try? FileManager.default.removeItem(at: workspaceDirectory)
        try FileManager.default.createDirectory(at: workspaceDirectory.appendingPathComponent(".cutready", isDirectory: true), withIntermediateDirectories: true)
        try #"{"projects":[{"path":"demos/launch","name":"Launch","description":"Main demo"}]}"#
            .data(using: .utf8)?
            .write(to: workspaceDirectory.appendingPathComponent(".cutready/projects.json"))
        defer {
            try? FileManager.default.removeItem(at: workspaceDirectory)
        }

        let client = MockDraftlineWorkspaceClient()
        client.sketches = [
            FileSummary(path: "demos/launch/intro.sk", title: "Intro", contents: "{}")
        ]
        let store = DraftlineMobileWorkspaceStore(client: client)
        _ = try await store.openWorkspace(
            repository: GitHubRepositorySummary(
                id: 3,
                name: "demo",
                fullName: "owner/demo",
                isPrivate: false,
                defaultBranch: "main",
                updatedAt: nil
            ),
            accessToken: "token"
        )

        let snapshot = try await store.snapshot()

        XCTAssertEqual(snapshot.projects, [
            MobileProjectEntry(path: "demos/launch", name: "Launch", description: "Main demo")
        ])
    }
}

private final class MockDraftlineWorkspaceClient: DraftlineMobileWorkspaceClient, @unchecked Sendable {
    var storyboards: [FileSummary] = []
    var sketches: [FileSummary] = []
    var notes: [FileSummary] = []
    var writtenNotes: [String: String] = [:]
    var assetData: [String: Data] = [:]
    var savedLabels: [String] = []
    var pushStatus = MobileSyncStatus(state: .clean)

    func openWorkspace(_ workspace: MobileWorkspaceDescriptor) async throws {}

    func openWorkspace(_ configuration: DraftlineMobileWorkspaceConfiguration) async throws {}

    func closeWorkspace() async throws {}

    func listStoryboards() async throws -> [FileSummary] {
        storyboards
    }

    func listSketches() async throws -> [FileSummary] {
        sketches
    }

    func listNotes() async throws -> [FileSummary] {
        notes
    }

    func readStoryboard(path: String) async throws -> Storyboard {
        throw DraftlineMobileBridgeError.nativeBridgeUnavailable
    }

    func readSketch(path: String) async throws -> Sketch {
        throw DraftlineMobileBridgeError.nativeBridgeUnavailable
    }

    func readNote(path: String) async throws -> String {
        notes.first { $0.path == path }?.contents ?? ""
    }

    func readAsset(path: String) async throws -> Data? {
        assetData[path]
    }

    func writeStoryboard(_ storyboard: Storyboard, path: String) async throws {}

    func writeSketch(_ sketch: Sketch, path: String) async throws {}

    func writeNote(_ markdown: String, path: String) async throws {
        writtenNotes[path] = markdown
        notes = notes.map { note in
            note.path == path ? FileSummary(path: note.path, title: note.title, contents: markdown, updatedAt: note.updatedAt) : note
        }
    }

    func saveSnapshot(label: String) async throws {
        savedLabels.append(label)
    }

    func syncStatus() async throws -> MobileSyncStatus {
        .init(state: .clean)
    }

    func pull() async throws -> MobileSyncStatus {
        .init(state: .clean)
    }

    func push() async throws -> MobileSyncStatus {
        pushStatus
    }

    func listConflicts() async throws -> [MobileConflict] {
        []
    }

    func resolveConflict(path: String, resolution: SimpleConflictResolution) async throws {}
}
