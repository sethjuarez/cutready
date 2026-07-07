import Foundation

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
