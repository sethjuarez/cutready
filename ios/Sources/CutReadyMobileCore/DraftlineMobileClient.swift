import Foundation

#if os(iOS)
import DraftlineMobileC
#endif

public enum MobileSyncState: String, Codable, Sendable {
    case clean
    case dirty
    case incoming
    case pulling
    case pushing
    case conflict
    case offline
}

public struct MobileSyncStatus: Codable, Equatable, Sendable {
    public var state: MobileSyncState
    public var ahead: Int
    public var behind: Int
    public var message: String?

    public init(state: MobileSyncState, ahead: Int = 0, behind: Int = 0, message: String? = nil) {
        self.state = state
        self.ahead = ahead
        self.behind = behind
        self.message = message
    }
}

public struct DraftlineMobileContentPolicyDescriptor: Codable, Equatable, Sendable {
    public var includePaths: [String]
    public var excludePaths: [String]
    public var includeExtensions: [String]
    public var largeFileThresholdBytes: UInt64?

    public init(
        includePaths: [String],
        excludePaths: [String],
        includeExtensions: [String],
        largeFileThresholdBytes: UInt64? = nil
    ) {
        self.includePaths = includePaths
        self.excludePaths = excludePaths
        self.includeExtensions = includeExtensions
        self.largeFileThresholdBytes = largeFileThresholdBytes
    }
}

public enum DraftlineMobileCredentialDescriptor: Equatable, Sendable {
    case `default`
    case usernamePassword(username: String, password: String)
    case sshAgent(username: String?)
    case sshKey(username: String?, privateKeyPath: String, passphrase: String?)
}

public struct DraftlineMobileWorkspaceConfiguration: Equatable, Sendable {
    public var workspace: MobileWorkspaceDescriptor
    public var localDirectory: URL
    public var remoteURL: URL?
    public var branch: String
    public var contentPolicy: DraftlineMobileContentPolicyDescriptor
    public var credential: DraftlineMobileCredentialDescriptor?

    public init(
        workspace: MobileWorkspaceDescriptor,
        localDirectory: URL,
        remoteURL: URL? = nil,
        branch: String,
        contentPolicy: DraftlineMobileContentPolicyDescriptor = MobileWorkspacePolicy.draftlineContentPolicy,
        credential: DraftlineMobileCredentialDescriptor? = nil
    ) {
        self.workspace = workspace
        self.localDirectory = localDirectory
        self.remoteURL = remoteURL
        self.branch = branch
        self.contentPolicy = contentPolicy
        self.credential = credential
    }
}

public struct DraftlineMobileVersionResult: Codable, Equatable, Sendable {
    public var id: String
    public var label: String

    public init(id: String, label: String) {
        self.id = id
        self.label = label
    }
}

public enum DraftlineMobileBridgeError: Error, Equatable, LocalizedError, Sendable {
    case nativeBridgeUnavailable
    case workspaceNotOpen
    case invalidPath(String)
    case nativeFailure(String)
    case invalidNativeResponse(String)

    public var errorDescription: String? {
        switch self {
        case .nativeBridgeUnavailable:
            return "Draftline's native mobile bridge is not linked into this app build yet."
        case .workspaceNotOpen:
            return "Open a Draftline workspace before reading or writing files."
        case .invalidPath(let path):
            return "The path is not allowed in this mobile workspace: \(path)"
        case .nativeFailure(let message):
            return message
        case .invalidNativeResponse(let message):
            return message
        }
    }
}

public struct MobileConflict: Codable, Equatable, Identifiable, Sendable {
    public var path: String
    public var summary: String
    public var canResolveOnMobile: Bool

    public var id: String { path }

    public init(path: String, summary: String, canResolveOnMobile: Bool) {
        self.path = path
        self.summary = summary
        self.canResolveOnMobile = canResolveOnMobile
    }
}

public enum SimpleConflictResolution: String, Codable, Sendable {
    case useLocal
    case useRemote
}

public protocol DraftlineMobileClient: Sendable {
    func openWorkspace(_ workspace: MobileWorkspaceDescriptor) async throws
    func closeWorkspace() async throws

    func listStoryboards() async throws -> [FileSummary]
    func listSketches() async throws -> [FileSummary]
    func listNotes() async throws -> [FileSummary]

    func readStoryboard(path: String) async throws -> Storyboard
    func readSketch(path: String) async throws -> Sketch
    func readNote(path: String) async throws -> String

    func writeStoryboard(_ storyboard: Storyboard, path: String) async throws
    func writeSketch(_ sketch: Sketch, path: String) async throws
    func writeNote(_ markdown: String, path: String) async throws

    func saveSnapshot(label: String) async throws
    func syncStatus() async throws -> MobileSyncStatus
    func pull() async throws -> MobileSyncStatus
    func push() async throws -> MobileSyncStatus

    func listConflicts() async throws -> [MobileConflict]
    func resolveConflict(path: String, resolution: SimpleConflictResolution) async throws
}

public protocol DraftlineMobileWorkspaceClient: DraftlineMobileClient {
    func openWorkspace(_ configuration: DraftlineMobileWorkspaceConfiguration) async throws
    func readAsset(path: String) async throws -> Data?
}

public final class DraftlineNativeMobileClient: DraftlineMobileWorkspaceClient, @unchecked Sendable {
#if os(iOS)
    private var workspaceHandle: OpaquePointer?
#endif
    private let nativeQueue = DispatchQueue(label: "CutReady.DraftlineMobile.native")
    private var workspaceRoot: URL?
    private var credential: DraftlineMobileCredentialDescriptor?

    public init() {}

    deinit {
#if os(iOS)
        if let workspaceHandle {
            draftline_mobile_workspace_free(workspaceHandle)
        }
#endif
    }

    public func openWorkspace(_ workspace: MobileWorkspaceDescriptor) async throws {
        let branch: String
        switch workspace.source {
        case .github(let repository):
            branch = repository.defaultBranch ?? "main"
        }
        try await openWorkspace(
            DraftlineMobileWorkspaceConfiguration(
                workspace: workspace,
                localDirectory: Self.defaultWorkspaceDirectory(for: workspace),
                branch: branch
            )
        )
    }

    public func openWorkspace(_ configuration: DraftlineMobileWorkspaceConfiguration) async throws {
#if os(iOS)
        try await onNativeQueue {
            try FileManager.default.createDirectory(at: configuration.localDirectory, withIntermediateDirectories: true)
            if let workspaceHandle = self.workspaceHandle {
                draftline_mobile_workspace_free(workspaceHandle)
                self.workspaceHandle = nil
            }
            self.workspaceRoot = nil
            self.credential = nil

            let result = configuration.localDirectory.path.withCString { pathPointer in
                self.withNativeContentPolicy(configuration.contentPolicy) { policyPointer in
                    if let remoteURL = configuration.remoteURL?.absoluteString,
                       !FileManager.default.fileExists(atPath: configuration.localDirectory.appendingPathComponent(".git", isDirectory: true).path) {
                        return self.withCredentialCallback(configuration.credential) { callback, userData in
                            remoteURL.withCString { remotePointer in
                                draftline_mobile_workspace_clone(remotePointer, pathPointer, policyPointer, callback, userData)
                            }
                        }
                    }

                    return draftline_mobile_workspace_open_or_init(pathPointer, policyPointer)
                }
            }

            try Self.check(result.status)
            guard let workspace = result.workspace else {
                throw DraftlineMobileBridgeError.invalidNativeResponse("Draftline did not return a workspace handle.")
            }
            self.workspaceHandle = workspace
            self.workspaceRoot = configuration.localDirectory
            self.credential = configuration.credential
        }
#else
        _ = configuration
        throw DraftlineMobileBridgeError.nativeBridgeUnavailable
#endif
    }

    public func closeWorkspace() async throws {
#if os(iOS)
        try await onNativeQueue {
            if let workspaceHandle = self.workspaceHandle {
                draftline_mobile_workspace_free(workspaceHandle)
                self.workspaceHandle = nil
            }
            self.workspaceRoot = nil
            self.credential = nil
        }
#else
        workspaceRoot = nil
        credential = nil
#endif
    }

    public func listStoryboards() async throws -> [FileSummary] {
        try await onNativeQueue { try self.fileSummaries(extension: "sb") }
    }

    public func listSketches() async throws -> [FileSummary] {
        try await onNativeQueue { try self.fileSummaries(extension: "sk") }
    }

    public func listNotes() async throws -> [FileSummary] {
        try await onNativeQueue { try self.fileSummaries(extension: "md") }
    }

    public func readStoryboard(path: String) async throws -> Storyboard {
        guard MobileWorkspacePolicy.canEdit(path: path) else {
            throw DraftlineMobileBridgeError.invalidPath(path)
        }
        let data = try await readUTF8File(path: path).data(using: .utf8) ?? Data()
        return try JSONDecoder().decode(Storyboard.self, from: data)
    }

    public func readSketch(path: String) async throws -> Sketch {
        guard MobileWorkspacePolicy.canEdit(path: path) else {
            throw DraftlineMobileBridgeError.invalidPath(path)
        }
        let data = try await readUTF8File(path: path).data(using: .utf8) ?? Data()
        return try JSONDecoder().decode(Sketch.self, from: data)
    }

    public func readNote(path: String) async throws -> String {
        guard MobileWorkspacePolicy.canEdit(path: path) else {
            throw DraftlineMobileBridgeError.invalidPath(path)
        }
        return try await readUTF8File(path: path)
    }

    public func readAsset(path: String) async throws -> Data? {
        guard MobileWorkspacePolicy.canReadAsset(path: path) else {
            throw DraftlineMobileBridgeError.invalidPath(path)
        }
        return try await onNativeQueue { try self.assetData(path: path) }
    }

    public func writeStoryboard(_ storyboard: Storyboard, path: String) async throws {
        guard MobileWorkspacePolicy.canEdit(path: path) else {
            throw DraftlineMobileBridgeError.invalidPath(path)
        }
        let data = try JSONEncoder().encode(storyboard)
        try await writeFile(data, path: path)
    }

    public func writeSketch(_ sketch: Sketch, path: String) async throws {
        guard MobileWorkspacePolicy.canEdit(path: path) else {
            throw DraftlineMobileBridgeError.invalidPath(path)
        }
        let data = try JSONEncoder().encode(sketch)
        try await writeFile(data, path: path)
    }

    public func writeNote(_ markdown: String, path: String) async throws {
        guard MobileWorkspacePolicy.canEdit(path: path) else {
            throw DraftlineMobileBridgeError.invalidPath(path)
        }
        try await writeFile(Data(markdown.utf8), path: path)
    }

    public func saveSnapshot(label: String) async throws {
#if os(iOS)
        _ = try await nativeString { workspace in
            label.withCString { labelPointer in
                draftline_mobile_workspace_save_version_json(workspace, labelPointer)
            }
        }
#else
        _ = label
        throw DraftlineMobileBridgeError.nativeBridgeUnavailable
#endif
    }

    public func syncStatus() async throws -> MobileSyncStatus {
#if os(iOS)
        let json = try await nativeString { workspace in
            "origin".withCString { remotePointer in
                draftline_mobile_workspace_sync_status_json(workspace, remotePointer)
            }
        }
        return try Self.mobileSyncStatus(fromJSON: json)
#else
        throw DraftlineMobileBridgeError.nativeBridgeUnavailable
#endif
    }

    public func pull() async throws -> MobileSyncStatus {
#if os(iOS)
        try await nativeStatus { workspace in
            self.withCredentialCallback(self.credential) { callback, userData in
                "origin".withCString { remotePointer in
                    draftline_mobile_workspace_fetch_remote(workspace, remotePointer, callback, userData)
                }
            }
        }

        let preflightJSON = try await nativeString { workspace in
            "origin".withCString { remotePointer in
                draftline_mobile_workspace_preflight_apply_incoming_json(workspace, remotePointer)
            }
        }
        let preflight = try Self.applyIncomingReport(fromJSON: preflightJSON)
        guard preflight.canProceed else {
            return try Self.mobileSyncStatus(fromApplyPreflightJSON: preflightJSON)
        }

        let json = try await nativeString { workspace in
            self.withCredentialCallback(self.credential) { callback, userData in
                "origin".withCString { remotePointer in
                    draftline_mobile_workspace_apply_incoming_json(workspace, remotePointer, callback, userData)
                }
            }
        }
        let applyStatus = try Self.mobileSyncStatus(fromApplyResultJSON: json)
        let statusJSON = try await nativeString { workspace in
            "origin".withCString { remotePointer in
                draftline_mobile_workspace_sync_status_json(workspace, remotePointer)
            }
        }
        var status = try Self.mobileSyncStatus(fromJSON: statusJSON)
        status.message = applyStatus.message
        return status
#else
        throw DraftlineMobileBridgeError.nativeBridgeUnavailable
#endif
    }

    public func push() async throws -> MobileSyncStatus {
#if os(iOS)
        let preflightJSON = try await nativeString { workspace in
            self.withCredentialCallback(self.credential) { callback, userData in
                "origin".withCString { remotePointer in
                    draftline_mobile_workspace_preflight_publish_json(workspace, remotePointer, callback, userData)
                }
            }
        }
        let preflight = try Self.publishPreflight(fromJSON: preflightJSON)
        guard preflight.canPublish else {
            return Self.mobileSyncStatus(
                from: preflight.syncStatus,
                fallbackMessage: "Pull latest changes before publishing mobile edits."
            )
        }
        let publishToken = try Self.publishTokenJSON(from: preflight.token)
        let json = try await nativeString { workspace in
            self.withCredentialCallback(self.credential) { callback, userData in
                publishToken.withCString { tokenPointer in
                    draftline_mobile_workspace_publish_json(workspace, tokenPointer, callback, userData)
                }
            }
        }
        return try Self.mobileSyncStatus(fromPublishResultJSON: json)
#else
        throw DraftlineMobileBridgeError.nativeBridgeUnavailable
#endif
    }

    public func listConflicts() async throws -> [MobileConflict] {
#if os(iOS)
        let json = try await nativeString { workspace in
            "origin".withCString { remotePointer in
                draftline_mobile_workspace_preflight_apply_incoming_json(workspace, remotePointer)
            }
        }
        return try Self.mobileConflicts(fromJSON: json)
#else
        throw DraftlineMobileBridgeError.nativeBridgeUnavailable
#endif
    }

    public func resolveConflict(path: String, resolution: SimpleConflictResolution) async throws {
        _ = path
        _ = resolution
        throw DraftlineMobileBridgeError.nativeBridgeUnavailable
    }

    public static func defaultWorkspaceDirectory(for workspace: MobileWorkspaceDescriptor) -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base
            .appendingPathComponent("CutReadyCompanion", isDirectory: true)
            .appendingPathComponent("DraftlineWorkspaces", isDirectory: true)
            .appendingPathComponent(workspace.id.safeMobileWorkspaceSegment, isDirectory: true)
    }

    private func readUTF8File(path: String) async throws -> String {
#if os(iOS)
        try await nativeString { workspace in
            path.withCString { pathPointer in
                draftline_mobile_workspace_read_file(workspace, pathPointer)
            }
        }
#else
        _ = path
        throw DraftlineMobileBridgeError.nativeBridgeUnavailable
#endif
    }

    private func writeFile(_ data: Data, path: String) async throws {
#if os(iOS)
        try await nativeStatus { workspace in
            path.withCString { pathPointer in
                data.withUnsafeBytes { bytes in
                    let contentPointer = bytes.bindMemory(to: UInt8.self).baseAddress
                    return draftline_mobile_workspace_write_file(workspace, pathPointer, contentPointer, UInt(data.count))
                }
            }
        }
#else
        _ = data
        _ = path
        throw DraftlineMobileBridgeError.nativeBridgeUnavailable
#endif
    }

    private func fileSummaries(extension fileExtension: String) throws -> [FileSummary] {
        guard let workspaceRoot else {
            throw DraftlineMobileBridgeError.workspaceNotOpen
        }

        guard let enumerator = FileManager.default.enumerator(
            at: workspaceRoot,
            includingPropertiesForKeys: [.isRegularFileKey, .contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else {
            return []
        }

        var summaries: [FileSummary] = []
        for case let fileURL as URL in enumerator {
            let values = try fileURL.resourceValues(forKeys: [.isRegularFileKey, .contentModificationDateKey])
            guard values.isRegularFile == true else {
                continue
            }

            let path = fileURL.pathRelative(to: workspaceRoot)
            guard MobileWorkspacePolicy.canEdit(path: path),
                  (path as NSString).pathExtension.lowercased() == fileExtension,
                  let contents = try? String(contentsOf: fileURL, encoding: .utf8) else {
                continue
            }

            summaries.append(
                FileSummary(
                    path: path,
                    title: Self.title(for: path, contents: contents),
                    contents: contents,
                    updatedAt: values.contentModificationDate
                )
            )
        }

        return summaries.sorted { $0.path < $1.path }
    }

    private func assetData(path: String) throws -> Data? {
        guard let workspaceRoot else {
            throw DraftlineMobileBridgeError.workspaceNotOpen
        }

        let url = try workspaceRoot.safeAppendingWorkspacePath(path)
        guard FileManager.default.fileExists(atPath: url.path) else {
            return nil
        }
        return try Data(contentsOf: url)
    }

#if os(iOS)
    private func nativeString(
        _ operation: @escaping (OpaquePointer) throws -> DraftlineMobileStringResult
    ) async throws -> String {
        try await onNativeQueue {
            guard let workspaceHandle = self.workspaceHandle else {
                throw DraftlineMobileBridgeError.workspaceNotOpen
            }
            let result = try operation(workspaceHandle)
            try Self.check(result.status)
            guard let value = result.value else {
                return ""
            }
            defer {
                draftline_mobile_string_free(value)
            }
            return String(cString: value)
        }
    }

    private func nativeStatus(
        _ operation: @escaping (OpaquePointer) throws -> DraftlineMobileStatus
    ) async throws {
        try await onNativeQueue {
            guard let workspaceHandle = self.workspaceHandle else {
                throw DraftlineMobileBridgeError.workspaceNotOpen
            }
            try Self.check(try operation(workspaceHandle))
        }
    }
#endif

    private func onNativeQueue<T>(_ body: @escaping () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            nativeQueue.async {
                do {
                    continuation.resume(returning: try body())
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    static func mobileSyncStatus(fromJSON json: String) throws -> MobileSyncStatus {
        try mobileSyncStatus(from: draftlineSyncStatus(fromJSON: json))
    }

    static func mobileSyncStatus(fromApplyResultJSON json: String) throws -> MobileSyncStatus {
        let result = try decode(DraftlineApplyIncomingResult.self, fromJSON: json)
        return MobileSyncStatus(
            state: .clean,
            message: result.appliedCount > 0 ? "Pulled \(result.appliedCount) incoming snapshot(s)." : "Workspace is already up to date."
        )
    }

    static func mobileSyncStatus(fromApplyPreflightJSON json: String) throws -> MobileSyncStatus {
        try mobileSyncStatus(from: applyIncomingReport(fromJSON: json))
    }

    static func mobileSyncStatus(fromPublishResultJSON json: String) throws -> MobileSyncStatus {
        let result = try decode(DraftlinePublishResult.self, fromJSON: json)
        return MobileSyncStatus(
            state: .clean,
            message: result.publishedVersions > 0 ? "Published \(result.publishedVersions) mobile snapshot(s)." : "No mobile snapshots needed publishing."
        )
    }

    static func mobileConflicts(fromJSON json: String) throws -> [MobileConflict] {
        let report = try applyIncomingReport(fromJSON: json)
        var conflicts = report.dirtyFiles.map { file in
            MobileConflict(
                path: file.path,
                summary: "Local \(file.kind.mobileLabel) blocks pulling incoming changes. Resolve this on desktop.",
                canResolveOnMobile: false
            )
        }
        conflicts.append(contentsOf: report.fileHazards.map { hazard in
            MobileConflict(
                path: hazard.path,
                summary: "Incoming changes would overwrite a \(hazard.kind.mobileLabel) file. Resolve this on desktop.",
                canResolveOnMobile: false
            )
        })

        if conflicts.isEmpty, report.syncStatus.state == .needsMerge {
            conflicts.append(
                MobileConflict(
                    path: report.syncStatus.variation,
                    summary: "This workspace needs a Draftline merge. Open it on desktop to resolve the history.",
                    canResolveOnMobile: false
                )
            )
        }
        return conflicts
    }

    static func applyIncomingReport(fromJSON json: String) throws -> DraftlineApplyIncomingReport {
        try decode(DraftlineApplyIncomingReport.self, fromJSON: json)
    }

    static func publishPreflight(fromJSON json: String) throws -> DraftlinePublishPreflight {
        try decode(DraftlinePublishPreflight.self, fromJSON: json)
    }

    private static func draftlineSyncStatus(fromJSON json: String) throws -> DraftlineSyncStatus {
        try decode(DraftlineSyncStatus.self, fromJSON: json)
    }

    private static func mobileSyncStatus(
        from report: DraftlineApplyIncomingReport
    ) -> MobileSyncStatus {
        let blockingCount = report.dirtyFiles.count + report.fileHazards.count
        let message: String
        if report.syncStatus.state == .needsMerge {
            message = "Incoming changes need a Draftline merge on desktop."
        } else if blockingCount > 0 {
            message = "\(blockingCount) local file issue(s) block pulling latest changes."
        } else {
            message = "Incoming changes are not safe to apply on mobile."
        }
        var status = mobileSyncStatus(from: report.syncStatus, fallbackMessage: message)
        if blockingCount > 0 || report.syncStatus.state == .needsMerge {
            status.state = .conflict
        }
        return status
    }

    private static func mobileSyncStatus(
        from status: DraftlineSyncStatus,
        fallbackMessage: String? = nil
    ) -> MobileSyncStatus {
        MobileSyncStatus(
            state: status.state.mobileState,
            ahead: status.ahead,
            behind: status.behind,
            message: fallbackMessage ?? status.state.mobileMessage(ahead: status.ahead, behind: status.behind)
        )
    }

    private static func publishTokenJSON(from token: DraftlinePublishToken) throws -> String {
        let data = try JSONEncoder().encode(token)
        guard let json = String(data: data, encoding: .utf8) else {
            throw DraftlineMobileBridgeError.invalidNativeResponse("Draftline publish token was not valid UTF-8 JSON.")
        }
        return json
    }

    private static func decode<T: Decodable>(_ type: T.Type, fromJSON json: String) throws -> T {
        guard let data = json.data(using: .utf8) else {
            throw DraftlineMobileBridgeError.invalidNativeResponse("Draftline returned non-UTF-8 JSON.")
        }
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw DraftlineMobileBridgeError.invalidNativeResponse("Draftline returned unexpected JSON: \(error.localizedDescription)")
        }
    }

    private static func title(for path: String, contents: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "sb", "sk":
            return jsonTitle(from: contents) ?? fallbackTitle(for: path)
        case "md":
            return fallbackTitle(for: path)
        default:
            return fallbackTitle(for: path)
        }
    }

    private static func jsonTitle(from contents: String) -> String? {
        guard let data = contents.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let title = object["title"] as? String,
              !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return title
    }

    private static func fallbackTitle(for path: String) -> String {
        URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent
    }

#if os(iOS)
    private static func check(_ status: DraftlineMobileStatus) throws {
        guard status.code.rawValue == 0 else {
            let message: String
            if let statusMessage = status.message {
                message = String(cString: statusMessage)
                draftline_mobile_string_free(statusMessage)
            } else {
                message = "Draftline mobile bridge failed with status code \(status.code.rawValue)."
            }
            throw DraftlineMobileBridgeError.nativeFailure(message)
        }
    }

    private func withNativeContentPolicy<T>(
        _ descriptor: DraftlineMobileContentPolicyDescriptor,
        _ body: (UnsafePointer<DraftlineMobileContentPolicy>) throws -> T
    ) rethrows -> T {
        let includePathStrings = descriptor.includePaths.map { strdup($0) }
        let excludePathStrings = descriptor.excludePaths.map { strdup($0) }
        let includeExtensionStrings = descriptor.includeExtensions.map { strdup($0) }
        defer {
            includePathStrings.forEach { free($0) }
            excludePathStrings.forEach { free($0) }
            includeExtensionStrings.forEach { free($0) }
        }

        let includePathPointers = includePathStrings.map { $0.map { UnsafePointer($0) } }
        let excludePathPointers = excludePathStrings.map { $0.map { UnsafePointer($0) } }
        let includeExtensionPointers = includeExtensionStrings.map { $0.map { UnsafePointer($0) } }

        return try includePathPointers.withUnsafeBufferPointer { includePathBuffer in
            try excludePathPointers.withUnsafeBufferPointer { excludePathBuffer in
                try includeExtensionPointers.withUnsafeBufferPointer { includeExtensionBuffer in
                    var policy = DraftlineMobileContentPolicy(
                        include_paths: includePathBuffer.baseAddress,
                        include_path_count: UInt(includePathBuffer.count),
                        exclude_paths: excludePathBuffer.baseAddress,
                        exclude_path_count: UInt(excludePathBuffer.count),
                        include_extensions: includeExtensionBuffer.baseAddress,
                        include_extension_count: UInt(includeExtensionBuffer.count),
                        large_file_threshold_bytes: descriptor.largeFileThresholdBytes ?? 0
                    )
                    return try body(&policy)
                }
            }
        }
    }

    private func withCredentialCallback<T>(
        _ credential: DraftlineMobileCredentialDescriptor?,
        _ body: (DraftlineMobileCredentialCallback?, UnsafeMutableRawPointer?) throws -> T
    ) rethrows -> T {
        guard let credential else {
            return try body(nil, nil)
        }

        let box = DraftlineCredentialCallbackBox(credential: credential)
        let retained = Unmanaged.passRetained(box)
        defer {
            retained.release()
        }
        return try body(draftlineCredentialCallback, retained.toOpaque())
    }
#endif
}

struct DraftlineSyncStatus: Codable, Equatable, Sendable {
    var remote: String
    var variation: String
    var ahead: Int
    var behind: Int
    var state: DraftlineSyncState
    var incoming: [DraftlineRemoteVersionSummary]
}

enum DraftlineSyncState: String, Codable, Equatable, Sendable {
    case upToDate = "UpToDate"
    case localAhead = "LocalAhead"
    case incomingAvailable = "IncomingAvailable"
    case needsMerge = "NeedsMerge"
    case noRemoteVersion = "NoRemoteVersion"

    var mobileState: MobileSyncState {
        switch self {
        case .upToDate:
            return .clean
        case .localAhead, .noRemoteVersion:
            return .dirty
        case .incomingAvailable:
            return .incoming
        case .needsMerge:
            return .conflict
        }
    }

    func mobileMessage(ahead: Int, behind: Int) -> String {
        switch self {
        case .upToDate:
            return "Workspace is up to date."
        case .localAhead:
            return "\(ahead) mobile snapshot(s) ready to push."
        case .incomingAvailable:
            return "\(behind) incoming snapshot(s) ready to pull."
        case .needsMerge:
            return "Local and remote histories diverged. Resolve this on desktop."
        case .noRemoteVersion:
            return "No remote Draftline version exists yet; publish this workspace from mobile."
        }
    }
}

struct DraftlineRemoteVersionSummary: Codable, Equatable, Sendable {
    var id: String
    var label: String
    var author: DraftlineContributor
    var timeSeconds: Int64

    enum CodingKeys: String, CodingKey {
        case id
        case label
        case author
        case timeSeconds = "time_seconds"
    }
}

struct DraftlineContributor: Codable, Equatable, Sendable {
    var name: String
    var email: String?
}

struct DraftlineApplyIncomingReport: Codable, Equatable, Sendable {
    var syncStatus: DraftlineSyncStatus
    var dirtyFiles: [DraftlineChangedFile]
    var fileHazards: [DraftlineFileHazard]
    var isFastForward: Bool
    var canProceed: Bool

    enum CodingKeys: String, CodingKey {
        case syncStatus = "sync_status"
        case dirtyFiles = "dirty_files"
        case fileHazards = "file_hazards"
        case isFastForward = "is_fast_forward"
        case canProceed = "can_proceed"
    }
}

struct DraftlineApplyIncomingResult: Codable, Equatable, Sendable {
    var appliedCount: Int

    enum CodingKeys: String, CodingKey {
        case appliedCount = "applied_count"
    }
}

struct DraftlinePublishPreflight: Codable, Equatable, Sendable {
    var remote: String
    var variation: String
    var expectedRemoteOID: String?
    var localOID: String
    var syncStatus: DraftlineSyncStatus
    var token: DraftlinePublishToken
    var canPublish: Bool

    enum CodingKeys: String, CodingKey {
        case remote
        case variation
        case expectedRemoteOID = "expected_remote_oid"
        case localOID = "local_oid"
        case syncStatus = "sync_status"
        case token
        case canPublish = "can_publish"
    }
}

struct DraftlinePublishToken: Codable, Equatable, Sendable {
    var remote: String
    var variation: String
    var expectedRemoteOID: String?
    var localOID: String

    enum CodingKeys: String, CodingKey {
        case remote
        case variation
        case expectedRemoteOID = "expected_remote_oid"
        case localOID = "local_oid"
    }
}

struct DraftlinePublishResult: Codable, Equatable, Sendable {
    var remote: String
    var variation: String
    var publishedVersions: Int

    enum CodingKeys: String, CodingKey {
        case remote
        case variation
        case publishedVersions = "published_versions"
    }
}

struct DraftlineChangedFile: Codable, Equatable, Sendable {
    var path: String
    var kind: DraftlineChangeKind
    var isBinary: Bool
    var isLarge: Bool

    enum CodingKeys: String, CodingKey {
        case path
        case kind
        case isBinary = "is_binary"
        case isLarge = "is_large"
    }
}

enum DraftlineChangeKind: String, Codable, Equatable, Sendable {
    case added = "Added"
    case modified = "Modified"
    case deleted = "Deleted"
    case renamed = "Renamed"
    case conflicted = "Conflicted"
    case typeChanged = "TypeChanged"

    var mobileLabel: String {
        switch self {
        case .added:
            return "added"
        case .modified:
            return "modified"
        case .deleted:
            return "deleted"
        case .renamed:
            return "renamed"
        case .conflicted:
            return "conflicted"
        case .typeChanged:
            return "type-changed"
        }
    }
}

struct DraftlineFileHazard: Codable, Equatable, Sendable {
    var path: String
    var kind: DraftlineFileHazardKind
}

enum DraftlineFileHazardKind: String, Codable, Equatable, Sendable {
    case ignored
    case untracked
    case policyExcluded = "policy_excluded"

    var mobileLabel: String {
        switch self {
        case .ignored:
            return "ignored"
        case .untracked:
            return "untracked"
        case .policyExcluded:
            return "policy-excluded"
        }
    }
}

#if os(iOS)
private final class DraftlineCredentialCallbackBox {
    private let username: UnsafeMutablePointer<CChar>?
    private let password: UnsafeMutablePointer<CChar>?
    private let privateKeyPath: UnsafeMutablePointer<CChar>?
    private let passphrase: UnsafeMutablePointer<CChar>?
    private let kind: DraftlineMobileCredentialKind

    init(credential: DraftlineMobileCredentialDescriptor) {
        switch credential {
        case .default:
            kind = DraftlineMobileCredentialKind(rawValue: 0)
            username = nil
            password = nil
            privateKeyPath = nil
            passphrase = nil
        case .usernamePassword(let username, let password):
            kind = DraftlineMobileCredentialKind(rawValue: 1)
            self.username = strdup(username)
            self.password = strdup(password)
            privateKeyPath = nil
            passphrase = nil
        case .sshAgent(let username):
            kind = DraftlineMobileCredentialKind(rawValue: 2)
            self.username = username.map { strdup($0) }
            password = nil
            privateKeyPath = nil
            passphrase = nil
        case .sshKey(let username, let privateKeyPath, let passphrase):
            kind = DraftlineMobileCredentialKind(rawValue: 3)
            self.username = username.map { strdup($0) }
            password = nil
            self.privateKeyPath = strdup(privateKeyPath)
            self.passphrase = passphrase.map { strdup($0) }
        }
    }

    deinit {
        free(username)
        free(password)
        free(privateKeyPath)
        free(passphrase)
    }

    var nativeCredential: DraftlineMobileCredential {
        DraftlineMobileCredential(
            kind: kind,
            username: UnsafePointer(username),
            password: UnsafePointer(password),
            public_key_path: nil,
            private_key_path: UnsafePointer(privateKeyPath),
            passphrase: UnsafePointer(passphrase)
        )
    }
}

private let draftlineCredentialCallback: DraftlineMobileCredentialCallback = { _, credentialOut, userData in
    guard let credentialOut, let userData else {
        return DraftlineMobileStatusCode(rawValue: 6)
    }

    let box = Unmanaged<DraftlineCredentialCallbackBox>.fromOpaque(userData).takeUnretainedValue()
    credentialOut.pointee = box.nativeCredential
    return DraftlineMobileStatusCode(rawValue: 0)
}
#endif

private extension String {
    var safeMobileWorkspaceSegment: String {
        replacingOccurrences(of: "/", with: "__")
            .replacingOccurrences(of: ":", with: "_")
    }
}

private extension URL {
    func pathRelative(to baseURL: URL) -> String {
        let basePath = baseURL.standardizedFileURL.path
        let fullPath = standardizedFileURL.path
        guard fullPath.hasPrefix(basePath) else {
            return lastPathComponent
        }
        return String(fullPath.dropFirst(basePath.count))
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    func safeAppendingWorkspacePath(_ path: String) throws -> URL {
        let components = path
            .replacingOccurrences(of: "\\", with: "/")
            .split(separator: "/", omittingEmptySubsequences: true)
            .map(String.init)
        guard !components.isEmpty, !components.contains("..") else {
            throw DraftlineMobileBridgeError.invalidPath(path)
        }
        return components.reduce(self) { url, component in
            url.appendingPathComponent(component)
        }
    }
}
