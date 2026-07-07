import Foundation

public struct GitHubRepositoryRef: Codable, Equatable, Hashable, Sendable {
    public var owner: String
    public var name: String
    public var defaultBranch: String?

    public init(owner: String, name: String, defaultBranch: String? = nil) {
        self.owner = owner
        self.name = name
        self.defaultBranch = defaultBranch
    }

    public var displayName: String {
        "\(owner)/\(name)"
    }
}

public enum MobileWorkspaceSource: Codable, Equatable, Hashable, Sendable {
    case github(GitHubRepositoryRef)
}

public struct MobileWorkspaceDescriptor: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var source: MobileWorkspaceSource

    public init(id: String, name: String, source: MobileWorkspaceSource) {
        self.id = id
        self.name = name
        self.source = source
    }
}

public struct MobileProjectEntry: Codable, Equatable, Identifiable, Sendable {
    public var path: String
    public var name: String
    public var description: String?

    public var id: String { path }

    public init(path: String, name: String, description: String? = nil) {
        self.path = path
        self.name = name
        self.description = description
    }
}

public enum MobileWorkspacePolicy {
    public static let editableExtensions: Set<String> = ["sb", "sk", "md"]
    public static let standardImageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp"]
    public static let readableAssetDirectories: Set<String> = [
        ".cutready/screenshots",
        ".cutready/visuals",
        ".cutready/narration"
    ]

    public static func canEdit(path: String) -> Bool {
        let normalized = normalize(path)
        guard !normalized.isEmpty, !containsTraversal(normalized) else {
            return false
        }

        return editableExtensions.contains((normalized as NSString).pathExtension.lowercased())
    }

    public static func canReadAsset(path: String) -> Bool {
        let normalized = normalize(path)
        guard !normalized.isEmpty, !containsTraversal(normalized) else {
            return false
        }

        return readableAssetDirectories.contains { directory in
            normalized == directory || normalized.hasPrefix("\(directory)/") || normalized.contains("/\(directory)/")
        }
    }

    public static func canReadStandardImage(path: String) -> Bool {
        canReadAsset(path: path) && standardImageExtensions.contains((normalize(path) as NSString).pathExtension.lowercased())
    }

    public static func canReadNarration(path: String) -> Bool {
        canReadAsset(path: path) && normalize(path).contains(".cutready/narration/")
    }

    public static var draftlineContentPolicy: DraftlineMobileContentPolicyDescriptor {
        DraftlineMobileContentPolicyDescriptor(
            includePaths: (Array(readableAssetDirectories) + [".cutready/projects.json"]).sorted(),
            excludePaths: [
                ".git",
                ".chats",
                ".cutready/agent-state.db",
                ".cutready/memory.json",
                ".cutready/locks.json",
                ".cutready/recordings"
            ],
            includeExtensions: Array(editableExtensions).sorted()
        )
    }

    private static func normalize(_ path: String) -> String {
        path
            .replacingOccurrences(of: "\\", with: "/")
            .split(separator: "/", omittingEmptySubsequences: true)
            .joined(separator: "/")
    }

    private static func containsTraversal(_ path: String) -> Bool {
        path.split(separator: "/").contains("..")
    }
}
