import XCTest
@testable import CutReadyMobileCore

final class DraftlineMobileWorkspaceStoreTests: XCTestCase {
    func testDraftlineSyncStatusMapsIncomingAvailable() throws {
        let status = try DraftlineNativeMobileClient.mobileSyncStatus(fromJSON: """
        {
          "remote": "origin",
          "variation": "main",
          "ahead": 0,
          "behind": 2,
          "state": "IncomingAvailable",
          "incoming": [
            {
              "id": "abc",
              "label": "Desktop edit",
              "author": {"name": "Desktop", "email": null},
              "time_seconds": 1710000000
            }
          ]
        }
        """)

        XCTAssertEqual(status.state, .incoming)
        XCTAssertEqual(status.ahead, 0)
        XCTAssertEqual(status.behind, 2)
        XCTAssertEqual(status.message, "2 incoming snapshot(s) ready to pull.")
    }

    func testDraftlineApplyPreflightMapsBlockedPullToDesktopConflict() throws {
        let json = """
        {
          "sync_status": {
            "remote": "origin",
            "variation": "main",
            "ahead": 1,
            "behind": 1,
            "state": "IncomingAvailable",
            "incoming": []
          },
          "dirty_files": [
            {"path": "intro.sk", "kind": "Modified", "is_binary": false, "is_large": false}
          ],
          "file_hazards": [
            {"path": ".cutready/screenshots/hero.png", "kind": "untracked"}
          ],
          "is_fast_forward": false,
          "can_proceed": false
        }
        """

        let status = try DraftlineNativeMobileClient.mobileSyncStatus(fromApplyPreflightJSON: json)

        XCTAssertEqual(status.state, .conflict)
        XCTAssertEqual(status.message, "2 local file issue(s) block pulling latest changes.")
    }

    func testDraftlineMergePreflightMapsEditableConflicts() throws {
        let conflicts = try DraftlineNativeMobileClient.mobileConflicts(fromJSON: """
        {
          "sync_status": {
            "remote": "origin",
            "variation": "main",
            "ahead": 1,
            "behind": 1,
            "state": "NeedsMerge",
            "incoming": []
          },
          "dirty_files": [],
          "file_hazards": [],
          "conflicts": [
            {
              "path": "notes/rehearsal.md",
              "field_path": null,
              "label": "notes/rehearsal.md",
              "base": "Base",
              "ours": "Mine",
              "theirs": "Shared",
              "resolution": "Choose"
            },
            {
              "path": ".cutready/visuals/hero.json",
              "field_path": null,
              "label": "hero.json",
              "base": "{}",
              "ours": "{\\"mobile\\":true}",
              "theirs": "{\\"shared\\":true}",
              "resolution": "Choose"
            }
          ],
          "token": {
            "remote": "origin",
            "variation": "main",
            "local_oid": "local",
            "remote_oid": "remote",
            "merge_base_oid": "base"
          },
          "can_merge_cleanly": false,
          "changed_workspace": false
        }
        """)

        XCTAssertEqual(conflicts.count, 2)
        XCTAssertEqual(conflicts[0].path, "notes/rehearsal.md")
        XCTAssertEqual(conflicts[0].mine, "Mine")
        XCTAssertEqual(conflicts[0].latestShared, "Shared")
        XCTAssertTrue(conflicts[0].canResolveOnMobile)
        XCTAssertEqual(conflicts[1].path, ".cutready/visuals/hero.json")
        XCTAssertTrue(conflicts[1].canResolveOnMobile)
        XCTAssertFalse(conflicts[1].needsUserChoice)
    }

    func testDraftlinePublishPreflightMapsCannotPublishToConflictStatus() throws {
        let preflight = try DraftlineNativeMobileClient.publishPreflight(fromJSON: """
        {
          "remote": "origin",
          "variation": "main",
          "expected_remote_oid": "abc",
          "local_oid": "def",
          "sync_status": {
            "remote": "origin",
            "variation": "main",
            "ahead": 1,
            "behind": 1,
            "state": "NeedsMerge",
            "incoming": []
          },
          "token": {
            "remote": "origin",
            "variation": "main",
            "expected_remote_oid": "abc",
            "local_oid": "def"
          },
          "can_publish": false
        }
        """)

        XCTAssertFalse(preflight.canPublish)
        XCTAssertEqual(preflight.syncStatus.state, .needsMerge)
    }

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

    func testSaveNoteRestoresOriginalContentWhenSnapshotFails() async throws {
        let client = MockDraftlineWorkspaceClient()
        client.notes = [
            FileSummary(path: "notes/rehearsal.md", title: "rehearsal", contents: "Before")
        ]
        client.saveSnapshotError = DraftlineMobileBridgeError.nativeFailure("version save failed")
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

        do {
            _ = try await store.saveNote("After", path: "notes/rehearsal.md")
            XCTFail("Expected saveNote to throw when snapshot creation fails.")
        } catch {}

        XCTAssertEqual(client.writtenNoteHistory.map(\.contents), ["After", "Before"])
        XCTAssertEqual(client.notes.first?.contents, "Before")
    }

    func testSaveSketchRestoresOriginalContentWhenSnapshotFails() async throws {
        let original = Self.makeSketch(title: "Before")
        let updated = Self.makeSketch(title: "After")
        let client = MockDraftlineWorkspaceClient()
        client.sketchDocuments["intro.sk"] = original
        client.saveSnapshotError = DraftlineMobileBridgeError.nativeFailure("version save failed")
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

        do {
            _ = try await store.saveSketch(updated, path: "intro.sk")
            XCTFail("Expected saveSketch to throw when snapshot creation fails.")
        } catch {}

        XCTAssertEqual(client.writtenSketchHistory.map(\.sketch.title), ["After", "Before"])
        XCTAssertEqual(client.sketchDocuments["intro.sk"]?.title, "Before")
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

    func testSyncStatusFetchesRemoteBeforeReadingStatus() async throws {
        let client = MockDraftlineWorkspaceClient()
        client.status = MobileSyncStatus(state: .clean, message: "cached clean")
        client.statusAfterRefresh = MobileSyncStatus(state: .incoming, behind: 1, message: "incoming after fetch")
        let store = DraftlineMobileWorkspaceStore(client: client)
        _ = try await store.openWorkspace(repository: repository(id: 30), accessToken: "token")

        let status = try await store.syncStatus()

        XCTAssertEqual(status, MobileSyncStatus(state: .incoming, behind: 1, message: "incoming after fetch"))
        XCTAssertEqual(client.refreshRemoteCount, 1)
        XCTAssertEqual(client.syncStatusCount, 1)
    }

    func testSyncStatusReportsOfflineWhenRemoteRefreshFails() async throws {
        let client = MockDraftlineWorkspaceClient()
        client.status = MobileSyncStatus(state: .dirty, ahead: 2, message: "local edits")
        client.refreshRemoteError = DraftlineMobileBridgeError.nativeFailure("network unavailable")
        let store = DraftlineMobileWorkspaceStore(client: client)
        _ = try await store.openWorkspace(repository: repository(id: 32), accessToken: "token")

        let status = try await store.syncStatus()

        XCTAssertEqual(status.state, .offline)
        XCTAssertEqual(status.ahead, 2)
        XCTAssertEqual(status.message, "Offline. network unavailable")
        XCTAssertEqual(client.refreshRemoteCount, 1)
        XCTAssertEqual(client.syncStatusCount, 1)
    }

    func testSyncNowFetchesRemoteBeforeDecidingCleanWorkspaceIsDone() async throws {
        let client = MockDraftlineWorkspaceClient()
        client.status = MobileSyncStatus(state: .clean, message: "cached clean")
        client.statusAfterRefresh = MobileSyncStatus(state: .incoming, behind: 1, message: "incoming after fetch")
        client.pullStatus = MobileSyncStatus(state: .clean, message: "pulled")
        let store = DraftlineMobileWorkspaceStore(client: client)
        _ = try await store.openWorkspace(repository: repository(id: 31), accessToken: "token")

        let result = try await store.syncNow()

        XCTAssertEqual(result.0, MobileSyncStatus(state: .clean, message: "pulled"))
        XCTAssertEqual(client.refreshRemoteCount, 1)
        XCTAssertEqual(client.syncStatusCount, 1)
        XCTAssertEqual(client.pullCount, 1)
    }

    func testSyncNowStopsOfflineWhenRemoteRefreshFails() async throws {
        let client = MockDraftlineWorkspaceClient()
        client.status = MobileSyncStatus(state: .dirty, ahead: 1, message: "local edits")
        client.refreshRemoteError = DraftlineMobileBridgeError.nativeFailure("network unavailable")
        let store = DraftlineMobileWorkspaceStore(client: client)
        _ = try await store.openWorkspace(repository: repository(id: 33), accessToken: "token")

        let result = try await store.syncNow()

        XCTAssertEqual(result.0.state, .offline)
        XCTAssertEqual(result.0.ahead, 1)
        XCTAssertEqual(client.pushCount, 0)
        XCTAssertEqual(client.pullCount, 0)
    }

    func testSyncNowPushesWhenWorkspaceIsDirty() async throws {
        let client = MockDraftlineWorkspaceClient()
        client.status = MobileSyncStatus(state: .dirty, ahead: 1, message: "ready")
        client.pushStatus = MobileSyncStatus(state: .clean, message: "pushed")
        let store = DraftlineMobileWorkspaceStore(client: client)
        _ = try await store.openWorkspace(repository: repository(id: 6), accessToken: "token")

        let result = try await store.syncNow()

        XCTAssertEqual(result.0, MobileSyncStatus(state: .clean, message: "pushed"))
        XCTAssertEqual(client.syncStatusCount, 1)
        XCTAssertEqual(client.pullCount, 0)
        XCTAssertEqual(client.pushCount, 1)
    }

    func testSyncNowPullsWhenIncomingOnly() async throws {
        let client = MockDraftlineWorkspaceClient()
        client.status = MobileSyncStatus(state: .incoming, behind: 1, message: "incoming")
        client.pullStatus = MobileSyncStatus(state: .clean, message: "pulled")
        let store = DraftlineMobileWorkspaceStore(client: client)
        _ = try await store.openWorkspace(repository: repository(id: 7), accessToken: "token")

        let result = try await store.syncNow()

        XCTAssertEqual(result.0, MobileSyncStatus(state: .clean, message: "pulled"))
        XCTAssertEqual(client.syncStatusCount, 1)
        XCTAssertEqual(client.pullCount, 1)
        XCTAssertEqual(client.pushCount, 0)
    }

    func testSyncNowPullsThenPushesWhenPullLeavesLocalAhead() async throws {
        let client = MockDraftlineWorkspaceClient()
        client.status = MobileSyncStatus(state: .incoming, ahead: 1, behind: 1, message: "incoming and local")
        client.pullStatus = MobileSyncStatus(state: .dirty, ahead: 1, message: "pulled; still ahead")
        client.pushStatus = MobileSyncStatus(state: .clean, message: "pushed after pull")
        let store = DraftlineMobileWorkspaceStore(client: client)
        _ = try await store.openWorkspace(repository: repository(id: 8), accessToken: "token")

        let result = try await store.syncNow()

        XCTAssertEqual(result.0, MobileSyncStatus(state: .clean, message: "pushed after pull"))
        XCTAssertEqual(client.syncStatusCount, 1)
        XCTAssertEqual(client.pullCount, 1)
        XCTAssertEqual(client.pushCount, 1)
    }

    func testSyncNowStopsWhenWorkspaceHasConflict() async throws {
        let client = MockDraftlineWorkspaceClient()
        client.status = MobileSyncStatus(state: .conflict, ahead: 1, behind: 1, message: "desktop required")
        let store = DraftlineMobileWorkspaceStore(client: client)
        _ = try await store.openWorkspace(repository: repository(id: 9), accessToken: "token")

        let result = try await store.syncNow()

        XCTAssertEqual(result.0, MobileSyncStatus(state: .conflict, ahead: 1, behind: 1, message: "desktop required"))
        XCTAssertEqual(client.syncStatusCount, 1)
        XCTAssertEqual(client.pullCount, 0)
        XCTAssertEqual(client.pushCount, 0)
    }

    func testStoreRejectsOverlappingWorkspaceOperations() async throws {
        let client = MockDraftlineWorkspaceClient()
        client.syncStatusDelayNanoseconds = 100_000_000
        let store = DraftlineMobileWorkspaceStore(client: client)
        _ = try await store.openWorkspace(repository: repository(id: 28), accessToken: "token")

        let statusTask = Task {
            try await store.syncStatus()
        }
        for _ in 0..<20 where client.syncStatusCount == 0 {
            try await Task.sleep(nanoseconds: 1_000_000)
        }

        do {
            _ = try await store.push()
            XCTFail("Expected overlapping push to fail while sync status is in flight.")
        } catch DraftlineMobileBridgeError.operationInProgress {
        } catch {
            XCTFail("Expected operationInProgress, got \(error).")
        }

        _ = try await statusTask.value
        XCTAssertEqual(client.pushCount, 0)
    }

    func testSnapshotListsWorkspaceDocumentsOnce() async throws {
        let client = MockDraftlineWorkspaceClient()
        client.storyboards = [
            FileSummary(path: "demo.sb", title: "Demo", contents: "{}")
        ]
        client.sketches = [
            FileSummary(path: "intro.sk", title: "Intro", contents: "{}")
        ]
        client.notes = [
            FileSummary(path: "notes/rehearsal.md", title: "Rehearsal", contents: "# Rehearsal")
        ]
        let store = DraftlineMobileWorkspaceStore(client: client)

        let snapshot = try await store.openWorkspace(
            repository: GitHubRepositorySummary(
                id: 4,
                name: "demo",
                fullName: "owner/demo",
                isPrivate: false,
                defaultBranch: "main",
                updatedAt: nil
            ),
            accessToken: "token"
        )

        XCTAssertEqual(snapshot.storyboards.map(\.path), ["demo.sb"])
        XCTAssertEqual(snapshot.sketches.map(\.path), ["intro.sk"])
        XCTAssertEqual(snapshot.notes.map(\.path), ["notes/rehearsal.md"])
        XCTAssertEqual(client.listDocumentsCount, 1)
        XCTAssertEqual(client.listStoryboardsCount, 0)
        XCTAssertEqual(client.listSketchesCount, 0)
        XCTAssertEqual(client.listNotesCount, 0)
    }

    func testShelveLocalEditsCreatesDraftlineShelfAndSyncsLatest() async throws {
        let client = MockDraftlineWorkspaceClient()
        client.shelf = MobileShelf(id: "shelf-1", name: "CutReady mobile edits")
        client.status = MobileSyncStatus(state: .incoming, behind: 1, message: "incoming")
        client.pullStatus = MobileSyncStatus(state: .clean, message: "pulled latest")
        client.notes = [FileSummary(path: "notes/latest.md", title: "Latest", contents: "# Latest")]
        let store = DraftlineMobileWorkspaceStore(client: client)
        _ = try await store.openWorkspace(repository: repository(id: 5), accessToken: "token")

        let (shelf, status, snapshot) = try await store.shelveLocalEditsAndSyncLatest()

        XCTAssertEqual(shelf, MobileShelf(id: "shelf-1", name: "CutReady mobile edits"))
        XCTAssertEqual(status, MobileSyncStatus(state: .clean, message: "pulled latest"))
        XCTAssertEqual(client.shelvedNames, ["CutReady mobile edits"])
        XCTAssertEqual(client.syncStatusCount, 1)
        XCTAssertEqual(client.pullCount, 1)
        XCTAssertEqual(snapshot.notes.map(\.path), ["notes/latest.md"])
    }

    func testParkLocalEditsMovesWorkspaceAsideAndReopens() async throws {
        let repository = GitHubRepositorySummary(
            id: 15,
            name: "park-demo",
            fullName: "owner/park-demo",
            isPrivate: false,
            defaultBranch: "main",
            updatedAt: nil
        )
        let descriptor = MobileWorkspaceDescriptor(
            id: repository.fullName,
            name: repository.name,
            source: .github(repository.repositoryRef)
        )
        let workspaceDirectory = DraftlineNativeMobileClient.defaultWorkspaceDirectory(for: descriptor)
        let parkedRoot = workspaceDirectory
            .deletingLastPathComponent()
            .appendingPathComponent(".parked-mobile-edits", isDirectory: true)
        try? FileManager.default.removeItem(at: workspaceDirectory)
        try? FileManager.default.removeItem(at: parkedRoot)
        try FileManager.default.createDirectory(at: workspaceDirectory, withIntermediateDirectories: true)
        try Data("local mobile edit".utf8).write(to: workspaceDirectory.appendingPathComponent("local.txt"))
        defer {
            try? FileManager.default.removeItem(at: workspaceDirectory)
            try? FileManager.default.removeItem(at: parkedRoot)
        }

        let client = MockDraftlineWorkspaceClient()
        client.notes = [FileSummary(path: "notes/latest.md", title: "Latest", contents: "# Latest")]
        let store = DraftlineMobileWorkspaceStore(client: client)
        _ = try await store.openWorkspace(repository: repository, accessToken: "token")

        let snapshot = try await store.parkLocalEditsAndReloadLatest(repository: repository, accessToken: "token")
        let parkedItems = try FileManager.default.contentsOfDirectory(at: parkedRoot, includingPropertiesForKeys: nil)

        XCTAssertEqual(client.closeWorkspaceCount, 2)
        XCTAssertEqual(client.openConfigurations.count, 3)
        XCTAssertEqual(snapshot.notes.map(\.path), ["notes/latest.md"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: workspaceDirectory.appendingPathComponent("local.txt").path))
        XCTAssertTrue(parkedItems.contains { item in
            FileManager.default.fileExists(atPath: item.appendingPathComponent("local.txt").path)
        })
    }

    func testParkLocalEditsLeavesWorkspaceInPlaceWhenFreshReloadFails() async throws {
        let repository = GitHubRepositorySummary(
            id: 24,
            name: "demo",
            fullName: "owner/demo",
            isPrivate: false,
            defaultBranch: "main",
            updatedAt: nil
        )
        let descriptor = MobileWorkspaceDescriptor(
            id: repository.fullName,
            name: repository.name,
            source: .github(repository.repositoryRef)
        )
        let workspaceDirectory = DraftlineNativeMobileClient.defaultWorkspaceDirectory(for: descriptor)
        let parkedRoot = workspaceDirectory
            .deletingLastPathComponent()
            .appendingPathComponent(".parked-mobile-edits", isDirectory: true)
        try? FileManager.default.removeItem(at: workspaceDirectory)
        try? FileManager.default.removeItem(at: parkedRoot)
        try FileManager.default.createDirectory(at: workspaceDirectory, withIntermediateDirectories: true)
        try Data("local mobile edit".utf8).write(to: workspaceDirectory.appendingPathComponent("local.txt"))
        defer {
            try? FileManager.default.removeItem(at: workspaceDirectory)
            try? FileManager.default.removeItem(at: parkedRoot)
        }

        let client = MockDraftlineWorkspaceClient()
        client.openFailures[2] = DraftlineMobileBridgeError.nativeFailure("remote unavailable")
        let store = DraftlineMobileWorkspaceStore(client: client)
        _ = try await store.openWorkspace(repository: repository, accessToken: "token")

        do {
            _ = try await store.parkLocalEditsAndReloadLatest(repository: repository, accessToken: "token")
            XCTFail("Expected park and reload to throw when staged reload fails.")
        } catch {}

        XCTAssertEqual(client.closeWorkspaceCount, 1)
        XCTAssertEqual(client.openConfigurations.count, 3)
        XCTAssertTrue(FileManager.default.fileExists(atPath: workspaceDirectory.appendingPathComponent("local.txt").path))
        let parkedItems = (try? FileManager.default.contentsOfDirectory(at: parkedRoot, includingPropertiesForKeys: nil)) ?? []
        XCTAssertTrue(parkedItems.isEmpty)
    }

    func testParkLocalEditsRestoresParkedWorkspaceWhenFinalReopenFails() async throws {
        let repository = GitHubRepositorySummary(
            id: 25,
            name: "demo",
            fullName: "owner/demo",
            isPrivate: false,
            defaultBranch: "main",
            updatedAt: nil
        )
        let descriptor = MobileWorkspaceDescriptor(
            id: repository.fullName,
            name: repository.name,
            source: .github(repository.repositoryRef)
        )
        let workspaceDirectory = DraftlineNativeMobileClient.defaultWorkspaceDirectory(for: descriptor)
        let parkedRoot = workspaceDirectory
            .deletingLastPathComponent()
            .appendingPathComponent(".parked-mobile-edits", isDirectory: true)
        try? FileManager.default.removeItem(at: workspaceDirectory)
        try? FileManager.default.removeItem(at: parkedRoot)
        try FileManager.default.createDirectory(at: workspaceDirectory, withIntermediateDirectories: true)
        try Data("local mobile edit".utf8).write(to: workspaceDirectory.appendingPathComponent("local.txt"))
        defer {
            try? FileManager.default.removeItem(at: workspaceDirectory)
            try? FileManager.default.removeItem(at: parkedRoot)
        }

        let client = MockDraftlineWorkspaceClient()
        client.openFailures[3] = DraftlineMobileBridgeError.nativeFailure("final reopen failed")
        let store = DraftlineMobileWorkspaceStore(client: client)
        _ = try await store.openWorkspace(repository: repository, accessToken: "token")

        do {
            _ = try await store.parkLocalEditsAndReloadLatest(repository: repository, accessToken: "token")
            XCTFail("Expected park and reload to throw when final reopen fails.")
        } catch {}

        XCTAssertEqual(client.closeWorkspaceCount, 3)
        XCTAssertEqual(client.openConfigurations.count, 4)
        XCTAssertTrue(FileManager.default.fileExists(atPath: workspaceDirectory.appendingPathComponent("local.txt").path))
        let parkedItems = (try? FileManager.default.contentsOfDirectory(at: parkedRoot, includingPropertiesForKeys: nil)) ?? []
        XCTAssertTrue(parkedItems.isEmpty)
    }

    func testListConflictsUsesDraftlineWorkspaceClient() async throws {
        let client = MockDraftlineWorkspaceClient()
        client.conflicts = [
            MobileConflict(path: "intro.sk", summary: "Review changes.", canResolveOnMobile: true)
        ]
        let store = DraftlineMobileWorkspaceStore(client: client)

        let conflicts = try await store.listConflicts()

        XCTAssertEqual(conflicts, client.conflicts)
    }

    func testResolveConflictsUsesDraftlineWorkspaceClientAndRefreshesSnapshot() async throws {
        let client = MockDraftlineWorkspaceClient()
        client.resolveStatus = MobileSyncStatus(state: .clean, message: "merged")
        client.notes = [
            FileSummary(path: "notes/rehearsal.md", title: "Rehearsal", contents: "# Merged")
        ]
        let store = DraftlineMobileWorkspaceStore(client: client)
        _ = try await store.openWorkspace(repository: repository(id: 29), accessToken: "token")

        let resolution = MobileConflictResolutionRequest(
            path: "notes/rehearsal.md",
            choice: .custom,
            customContent: "# Merged"
        )
        let result = try await store.resolveConflicts([resolution])

        XCTAssertEqual(result.0, MobileSyncStatus(state: .clean, message: "merged"))
        XCTAssertEqual(result.1.notes.map(\.path), ["notes/rehearsal.md"])
        XCTAssertEqual(client.resolutions, [resolution])
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

    private func repository(id: Int64) -> GitHubRepositorySummary {
        GitHubRepositorySummary(
            id: id,
            name: "demo-\(id)",
            fullName: "owner/demo-\(id)",
            isPrivate: false,
            defaultBranch: "main",
            updatedAt: nil
        )
    }

    private static func makeSketch(title: String) -> Sketch {
        Sketch(
            title: title,
            rows: [
                PlanningRow(time: "0:00", narrative: "Narration", demoActions: "Click")
            ],
            createdAt: Date(timeIntervalSince1970: 0),
            updatedAt: Date(timeIntervalSince1970: 0)
        )
    }
}

private final class MockDraftlineWorkspaceClient: DraftlineMobileWorkspaceClient, @unchecked Sendable {
    var storyboards: [FileSummary] = []
    var sketches: [FileSummary] = []
    var notes: [FileSummary] = []
    var sketchDocuments: [String: Sketch] = [:]
    var writtenNotes: [String: String] = [:]
    var assetData: [String: Data] = [:]
    var conflicts: [MobileConflict] = []
    var savedLabels: [String] = []
    var saveSnapshotError: Error?
    var writtenNoteHistory: [(path: String, contents: String)] = []
    var writtenSketchHistory: [(path: String, sketch: Sketch)] = []
    var status = MobileSyncStatus(state: .clean)
    var pullStatus = MobileSyncStatus(state: .clean)
    var pushStatus = MobileSyncStatus(state: .clean)
    var resolveStatus = MobileSyncStatus(state: .clean)
    var statusAfterRefresh: MobileSyncStatus?
    var shelf = MobileShelf(id: "shelf")
    var shelves: [MobileShelf] = []
    var shelvedNames: [String] = []
    var closeWorkspaceCount = 0
    var openConfigurations: [DraftlineMobileWorkspaceConfiguration] = []
    var openFailures: [Int: Error] = [:]
    var syncStatusDelayNanoseconds: UInt64 = 0
    var refreshRemoteError: Error?
    var refreshRemoteCount = 0
    var syncStatusCount = 0
    var pullCount = 0
    var pushCount = 0
    var resolutions: [MobileConflictResolutionRequest] = []
    var listDocumentsCount = 0
    var listStoryboardsCount = 0
    var listSketchesCount = 0
    var listNotesCount = 0

    func openWorkspace(_ workspace: MobileWorkspaceDescriptor) async throws {}

    func openWorkspace(_ configuration: DraftlineMobileWorkspaceConfiguration) async throws {
        openConfigurations.append(configuration)
        if let error = openFailures[openConfigurations.count] {
            throw error
        }
        try FileManager.default.createDirectory(at: configuration.localDirectory, withIntermediateDirectories: true)
    }

    func closeWorkspace() async throws {
        closeWorkspaceCount += 1
    }

    func listDocuments() async throws -> WorkspaceDocumentSummaries {
        listDocumentsCount += 1
        return WorkspaceDocumentSummaries(storyboards: storyboards, sketches: sketches, notes: notes)
    }

    func listStoryboards() async throws -> [FileSummary] {
        listStoryboardsCount += 1
        return storyboards
    }

    func listSketches() async throws -> [FileSummary] {
        listSketchesCount += 1
        return sketches
    }

    func listNotes() async throws -> [FileSummary] {
        listNotesCount += 1
        return notes
    }

    func readStoryboard(path: String) async throws -> Storyboard {
        throw DraftlineMobileBridgeError.nativeBridgeUnavailable
    }

    func readSketch(path: String) async throws -> Sketch {
        guard let sketch = sketchDocuments[path] else {
            throw DraftlineMobileBridgeError.nativeBridgeUnavailable
        }
        return sketch
    }

    func readNote(path: String) async throws -> String {
        notes.first { $0.path == path }?.contents ?? ""
    }

    func readAsset(path: String) async throws -> Data? {
        assetData[path]
    }

    func writeStoryboard(_ storyboard: Storyboard, path: String) async throws {}

    func writeSketch(_ sketch: Sketch, path: String) async throws {
        writtenSketchHistory.append((path: path, sketch: sketch))
        sketchDocuments[path] = sketch
    }

    func writeNote(_ markdown: String, path: String) async throws {
        writtenNoteHistory.append((path: path, contents: markdown))
        writtenNotes[path] = markdown
        notes = notes.map { note in
            note.path == path ? FileSummary(path: note.path, title: note.title, contents: markdown, updatedAt: note.updatedAt) : note
        }
    }

    func saveSnapshot(label: String) async throws {
        if let saveSnapshotError {
            throw saveSnapshotError
        }
        savedLabels.append(label)
    }

    func refreshRemote() async throws {
        refreshRemoteCount += 1
        if let refreshRemoteError {
            throw refreshRemoteError
        }
        if let statusAfterRefresh {
            status = statusAfterRefresh
        }
    }

    func syncStatus() async throws -> MobileSyncStatus {
        syncStatusCount += 1
        if syncStatusDelayNanoseconds > 0 {
            try await Task.sleep(nanoseconds: syncStatusDelayNanoseconds)
        }
        return status
    }

    func pull() async throws -> MobileSyncStatus {
        pullCount += 1
        return pullStatus
    }

    func push() async throws -> MobileSyncStatus {
        pushCount += 1
        return pushStatus
    }

    func shelveAllDirty(name: String) async throws -> MobileShelf {
        shelvedNames.append(name)
        shelves.append(shelf)
        return shelf
    }

    func listShelves() async throws -> [MobileShelf] {
        shelves
    }

    func listConflicts() async throws -> [MobileConflict] {
        conflicts
    }

    func resolveConflicts(_ resolutions: [MobileConflictResolutionRequest]) async throws -> MobileSyncStatus {
        self.resolutions = resolutions
        return resolveStatus
    }
}
