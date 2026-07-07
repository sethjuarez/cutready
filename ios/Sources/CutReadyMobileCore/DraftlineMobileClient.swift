import Foundation
#if canImport(DraftlineMobile)
import DraftlineMobile
#endif

public enum MobileSyncState: String, Codable, Sendable {
    case clean
    case dirty
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
#if canImport(DraftlineMobile)
    private var workspaceHandle: OpaquePointer?
#endif
    private let nativeQueue = DispatchQueue(label: "CutReady.DraftlineMobile.native")
    private var workspaceRoot: URL?
    private var credential: DraftlineMobileCredentialDescriptor?

    public init() {}

    deinit {
#if canImport(DraftlineMobile)
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
#if canImport(DraftlineMobile)
        try await onNativeQueue {
            try FileManager.default.createDirectory(at: configuration.localDirectory, withIntermediateDirectories: true)
            if let workspaceHandle {
                draftline_mobile_workspace_free(workspaceHandle)
                self.workspaceHandle = nil
            }
            workspaceRoot = nil
            credential = nil

            let result = try configuration.localDirectory.path.withCString { pathPointer in
                try withNativeContentPolicy(configuration.contentPolicy) { policyPointer in
                    if let remoteURL = configuration.remoteURL?.absoluteString,
                       !FileManager.default.fileExists(atPath: configuration.localDirectory.appendingPathComponent(".git", isDirectory: true).path) {
                        return try withCredentialCallback(configuration.credential) { callback, userData in
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
            workspaceHandle = workspace
            workspaceRoot = configuration.localDirectory
            credential = configuration.credential
        }
#else
        _ = configuration
        throw DraftlineMobileBridgeError.nativeBridgeUnavailable
#endif
    }

    public func closeWorkspace() async throws {
#if canImport(DraftlineMobile)
        try await onNativeQueue {
            if let workspaceHandle {
                draftline_mobile_workspace_free(workspaceHandle)
                self.workspaceHandle = nil
            }
            workspaceRoot = nil
            credential = nil
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
#if canImport(DraftlineMobile)
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
#if canImport(DraftlineMobile)
        let json = try await nativeString { workspace in
            "origin".withCString { remotePointer in
                draftline_mobile_workspace_sync_status_json(workspace, remotePointer)
            }
        }
        return Self.mobileSyncStatus(fromJSON: json)
#else
        throw DraftlineMobileBridgeError.nativeBridgeUnavailable
#endif
    }

    public func pull() async throws -> MobileSyncStatus {
#if canImport(DraftlineMobile)
        try await nativeStatus { workspace in
            try withCredentialCallback(credential) { callback, userData in
                "origin".withCString { remotePointer in
                    draftline_mobile_workspace_fetch_remote(workspace, remotePointer, callback, userData)
                }
            }
        }
        let json = try await nativeString { workspace in
            try withCredentialCallback(credential) { callback, userData in
                "origin".withCString { remotePointer in
                    draftline_mobile_workspace_apply_incoming_json(workspace, remotePointer, callback, userData)
                }
            }
        }
        return Self.mobileSyncStatus(fromJSON: json)
#else
        throw DraftlineMobileBridgeError.nativeBridgeUnavailable
#endif
    }

    public func push() async throws -> MobileSyncStatus {
#if canImport(DraftlineMobile)
        let publishToken = try await nativeString { workspace in
            try withCredentialCallback(credential) { callback, userData in
                "origin".withCString { remotePointer in
                    draftline_mobile_workspace_preflight_publish_json(workspace, remotePointer, callback, userData)
                }
            }
        }
        let json = try await nativeString { workspace in
            try withCredentialCallback(credential) { callback, userData in
                publishToken.withCString { tokenPointer in
                    draftline_mobile_workspace_publish_json(workspace, tokenPointer, callback, userData)
                }
            }
        }
        return Self.mobileSyncStatus(fromJSON: json)
#else
        throw DraftlineMobileBridgeError.nativeBridgeUnavailable
#endif
    }

    public func listConflicts() async throws -> [MobileConflict] {
#if canImport(DraftlineMobile)
        let json = try await nativeString { workspace in
            "origin".withCString { remotePointer in
                draftline_mobile_workspace_preflight_apply_incoming_json(workspace, remotePointer)
            }
        }
        return Self.mobileConflicts(fromJSON: json)
#else
        throw DraftlineMobileBridgeError.nativeBridgeUnavailable
#endif
    }

    public func resolveConflict(path: String, resolution: SimpleConflictResolution) async throws {
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
#if canImport(DraftlineMobile)
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
#if canImport(DraftlineMobile)
        try await nativeStatus { workspace in
            path.withCString { pathPointer in
                data.withUnsafeBytes { bytes in
                    let contentPointer = bytes.bindMemory(to: UInt8.self).baseAddress
                    return draftline_mobile_workspace_write_file(workspace, pathPointer, contentPointer, data.count)
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
                    contents: fileExtension == "sb" ? nil : contents,
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

#if canImport(DraftlineMobile)
    private func nativeString(
        _ operation: (OpaquePointer) throws -> DraftlineMobileStringResult
    ) async throws -> String {
        try await onNativeQueue {
            guard let workspaceHandle else {
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
        _ operation: (OpaquePointer) throws -> DraftlineMobileStatus
    ) async throws {
        try await onNativeQueue {
            guard let workspaceHandle else {
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

    private static func mobileSyncStatus(fromJSON json: String) -> MobileSyncStatus {
        guard let data = json.data(using: .utf8),
              let status = try? JSONDecoder().decode(DraftlineSyncStatusEnvelope.self, from: data) else {
            return MobileSyncStatus(state: .clean, message: json)
        }

        let state: MobileSyncState
        let label = (status.state ?? status.status ?? "").lowercased()
        if label.contains("conflict") || status.hasConflicts == true {
            state = .conflict
        } else if status.isDirty == true {
            state = .dirty
        } else {
            state = .clean
        }

        return MobileSyncStatus(
            state: state,
            ahead: status.ahead ?? 0,
            behind: status.behind ?? 0,
            message: json
        )
    }

    private static func mobileConflicts(fromJSON json: String) -> [MobileConflict] {
        guard let data = json.data(using: .utf8) else {
            return []
        }

        if let envelope = try? JSONDecoder().decode(DraftlineConflictEnvelope.self, from: data) {
            return envelope.conflicts.map {
                MobileConflict(path: $0.path, summary: $0.summary ?? "Conflict requires desktop resolution.", canResolveOnMobile: false)
            }
        }

        return []
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

#if canImport(DraftlineMobile)
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

        var includePathPointers = includePathStrings.map { $0.map { UnsafePointer($0) } }
        var excludePathPointers = excludePathStrings.map { $0.map { UnsafePointer($0) } }
        var includeExtensionPointers = includeExtensionStrings.map { $0.map { UnsafePointer($0) } }

        return try includePathPointers.withUnsafeBufferPointer { includePathBuffer in
            try excludePathPointers.withUnsafeBufferPointer { excludePathBuffer in
                try includeExtensionPointers.withUnsafeBufferPointer { includeExtensionBuffer in
                    var policy = DraftlineMobileContentPolicy(
                        include_paths: includePathBuffer.baseAddress,
                        include_path_count: includePathBuffer.count,
                        exclude_paths: excludePathBuffer.baseAddress,
                        exclude_path_count: excludePathBuffer.count,
                        include_extensions: includeExtensionBuffer.baseAddress,
                        include_extension_count: includeExtensionBuffer.count,
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

private struct DraftlineSyncStatusEnvelope: Decodable {
    var state: String?
    var status: String?
    var ahead: Int?
    var behind: Int?
    var isDirty: Bool?
    var hasConflicts: Bool?
}

private struct DraftlineConflictEnvelope: Decodable {
    var conflicts: [DraftlineConflictItem]
}

private struct DraftlineConflictItem: Decodable {
    var path: String
    var summary: String?
}

#if canImport(DraftlineMobile)
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
