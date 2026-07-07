import Foundation

public struct RecentWorkspace: Codable, Equatable, Identifiable, Sendable {
    public var repository: GitHubRepositorySummary
    public var openedAt: Date

    public var id: Int64 {
        repository.id
    }

    public init(repository: GitHubRepositorySummary, openedAt: Date = Date()) {
        self.repository = repository
        self.openedAt = openedAt
    }
}

public struct RecentWorkspaceStore {
    private let key: String
    private let defaults: UserDefaults
    private let limit: Int

    public init(
        key: String = "com.cutready.companion.recentWorkspaces",
        defaults: UserDefaults = .standard,
        limit: Int = 8
    ) {
        self.key = key
        self.defaults = defaults
        self.limit = limit
    }

    public func load() -> [RecentWorkspace] {
        guard let data = defaults.data(forKey: key) else {
            return []
        }

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return (try? decoder.decode([RecentWorkspace].self, from: data)) ?? []
    }

    public func record(repository: GitHubRepositorySummary, openedAt: Date = Date()) {
        var workspaces = load()
        workspaces.removeAll { $0.repository.fullName == repository.fullName }
        workspaces.insert(RecentWorkspace(repository: repository, openedAt: openedAt), at: 0)
        workspaces = Array(workspaces.prefix(limit))

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        if let data = try? encoder.encode(workspaces) {
            defaults.set(data, forKey: key)
        }
    }
}
