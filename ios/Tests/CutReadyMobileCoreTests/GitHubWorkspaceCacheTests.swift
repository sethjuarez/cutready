import XCTest
@testable import CutReadyMobileCore

final class GitHubWorkspaceCacheTests: XCTestCase {
    private var cacheRoot: URL!

    override func setUpWithError() throws {
        cacheRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("CutReadyCompanionTests", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
    }

    override func tearDownWithError() throws {
        if let cacheRoot, FileManager.default.fileExists(atPath: cacheRoot.path) {
            try FileManager.default.removeItem(at: cacheRoot)
        }
    }

    func testHydratedWorkspaceSnapshotReadsFromDisk() async throws {
        let cache = GitHubWorkspaceCache(rootDirectory: cacheRoot)
        let repository = repositorySummary()
        var fetchedPaths: [String] = []

        try await cache.hydrate(
            repository: repository,
            projects: [MobileProjectEntry(path: "loop-demo", name: "Loop Demo")],
            editableFiles: [
                "loop-demo/storyboard.sb",
                "loop-demo/sketch.sk",
                "loop-demo/notes.md"
            ],
            assetFiles: [
                "loop-demo/.cutready/screenshots/hero.png",
                "loop-demo/.cutready/narration/row-1.webm"
            ],
            fetchData: { path in
                fetchedPaths.append(path)
                switch path {
                case "loop-demo/storyboard.sb":
                    return Data(#"{"title":"Storyboard","items":[]}"#.utf8)
                case "loop-demo/sketch.sk":
                    return Data(#"{"title":"Sketch","rows":[],"state":"draft","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}"#.utf8)
                case "loop-demo/notes.md":
                    return Data("# Notes\n".utf8)
                case "loop-demo/.cutready/screenshots/hero.png":
                    return Data([0x89, 0x50, 0x4E, 0x47])
                case "loop-demo/.cutready/narration/row-1.webm":
                    return Data("webm".utf8)
                default:
                    XCTFail("Unexpected path fetched: \(path)")
                    return Data()
                }
            }
        )

        let snapshot = try XCTUnwrap(cache.snapshot(repository: repository) { path, contents in
            if path.hasSuffix(".md") {
                return "notes"
            }
            return contents.contains("Storyboard") ? "Storyboard" : "Sketch"
        })

        XCTAssertEqual(fetchedPaths.count, 5)
        XCTAssertEqual(snapshot.projects, [MobileProjectEntry(path: "loop-demo", name: "Loop Demo")])
        XCTAssertEqual(snapshot.activeProjectPath, "loop-demo")
        XCTAssertEqual(snapshot.storyboards.first?.contents, nil)
        XCTAssertEqual(snapshot.sketches.first?.contents?.contains(#""title":"Sketch""#), true)
        XCTAssertEqual(snapshot.notes.first?.title, "notes")
    }

    func testCachedAssetDataReadsFromDisk() async throws {
        let cache = GitHubWorkspaceCache(rootDirectory: cacheRoot)
        let repository = repositorySummary()
        let assetPath = "loop-demo/.cutready/screenshots/hero.png"
        let source = MobileWorkspaceSource.github(repository.repositoryRef)

        try await cache.hydrate(
            repository: repository,
            projects: [],
            editableFiles: ["loop-demo/sketch.sk"],
            assetFiles: [assetPath],
            fetchData: { path in
                path == assetPath
                    ? Data([1, 2, 3])
                    : Data(#"{"title":"Sketch","rows":[],"state":"draft","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}"#.utf8)
            }
        )

        XCTAssertEqual(try cache.data(path: assetPath, source: source), Data([1, 2, 3]))
    }

    func testRejectsTraversalPaths() async throws {
        let cache = GitHubWorkspaceCache(rootDirectory: cacheRoot)
        let repository = repositorySummary()

        do {
            try await cache.hydrate(
                repository: repository,
                projects: [],
                editableFiles: ["../secret.sk"],
                assetFiles: [],
                fetchData: { _ in Data("secret".utf8) }
            )
            XCTFail("Expected traversal path to be rejected")
        } catch GitHubMobileError.unsupportedResponse {
            // Expected.
        }
    }

    private func repositorySummary() -> GitHubRepositorySummary {
        GitHubRepositorySummary(
            id: 42,
            name: "start-2026",
            fullName: "sethjuarez/start-2026",
            isPrivate: false,
            defaultBranch: "main",
            updatedAt: nil
        )
    }
}
