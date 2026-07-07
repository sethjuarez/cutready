import Foundation

public struct GitHubDeviceAuthorization: Codable, Equatable, Identifiable, Sendable {
    public var deviceCode: String
    public var userCode: String
    public var verificationURI: URL
    public var expiresIn: TimeInterval
    public var interval: TimeInterval

    public var id: String {
        deviceCode
    }

    enum CodingKeys: String, CodingKey {
        case deviceCode = "device_code"
        case userCode = "user_code"
        case verificationURI = "verification_uri"
        case expiresIn = "expires_in"
        case interval
    }

    public init(
        deviceCode: String,
        userCode: String,
        verificationURI: URL,
        expiresIn: TimeInterval,
        interval: TimeInterval
    ) {
        self.deviceCode = deviceCode
        self.userCode = userCode
        self.verificationURI = verificationURI
        self.expiresIn = expiresIn
        self.interval = interval
    }
}

public struct GitHubAccessToken: Codable, Equatable, Sendable {
    public var accessToken: String
    public var scope: String
    public var tokenType: String

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case scope
        case tokenType = "token_type"
    }
}

public struct GitHubRepositorySummary: Codable, Equatable, Identifiable, Sendable {
    public var id: Int64
    public var name: String
    public var fullName: String
    public var isPrivate: Bool
    public var defaultBranch: String
    public var updatedAt: Date?

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case fullName = "full_name"
        case isPrivate = "private"
        case defaultBranch = "default_branch"
        case updatedAt = "updated_at"
    }

    public var repositoryRef: GitHubRepositoryRef {
        let parts = fullName.split(separator: "/", maxSplits: 1).map(String.init)
        let owner = parts.first ?? ""
        return GitHubRepositoryRef(owner: owner, name: name, defaultBranch: defaultBranch)
    }
}

public enum GitHubMobileError: Error, LocalizedError, Equatable {
    case missingClientID
    case authorizationPending
    case authorizationDeclined
    case authorizationExpired
    case unsupportedResponse
    case api(String)

    public var errorDescription: String? {
        switch self {
        case .missingClientID:
            return "Missing GitHub OAuth client ID."
        case .authorizationPending:
            return "Waiting for GitHub authorization."
        case .authorizationDeclined:
            return "GitHub authorization was declined."
        case .authorizationExpired:
            return "GitHub authorization expired."
        case .unsupportedResponse:
            return "GitHub returned an unsupported response."
        case .api(let message):
            return message
        }
    }
}

public struct GitHubWorkspaceOpenProgress: Equatable, Sendable {
    public enum Phase: Equatable, Sendable {
        case checkingCache
        case readingCache
        case fetchingManifest
        case downloadingFiles
        case finalizing
    }

    public var phase: Phase
    public var completed: Int?
    public var total: Int?
    public var currentPath: String?

    public init(phase: Phase, completed: Int? = nil, total: Int? = nil, currentPath: String? = nil) {
        self.phase = phase
        self.completed = completed
        self.total = total
        self.currentPath = currentPath
    }
}

public struct GitHubWorkspaceCache: Sendable {
    public var rootDirectory: URL

    public init(rootDirectory: URL = GitHubWorkspaceCache.defaultRootDirectory()) {
        self.rootDirectory = rootDirectory
    }

    public static func defaultRootDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base
            .appendingPathComponent("CutReadyCompanion", isDirectory: true)
            .appendingPathComponent("GitHubWorkspaces", isDirectory: true)
    }

    func snapshot(
        repository: GitHubRepositorySummary,
        titleProvider: (String, String) -> String
    ) throws -> MobileWorkspaceSnapshot? {
        let manifestURL = manifestURL(repository: repository)
        guard FileManager.default.fileExists(atPath: manifestURL.path) else {
            return nil
        }

        let manifest = try JSONDecoder().decode(
            GitHubWorkspaceCacheManifest.self,
            from: Data(contentsOf: manifestURL)
        )
        guard manifest.defaultBranch == repository.defaultBranch else {
            return nil
        }

        let summaries = try manifest.editableFiles.map { path in
            let contents = try String(contentsOf: fileURL(path: path, repository: repository), encoding: .utf8)
            return FileSummary(
                path: path,
                title: titleProvider(path, contents),
                contents: path.lowercased().hasSuffix(".sb") ? nil : contents,
                updatedAt: manifest.hydratedAt
            )
        }

        let descriptor = MobileWorkspaceDescriptor(
            id: repository.fullName,
            name: repository.name,
            source: .github(repository.repositoryRef)
        )

        return MobileWorkspaceSnapshot(
            descriptor: descriptor,
            projects: manifest.projects.isEmpty ? [MobileProjectEntry(path: ".", name: repository.name)] : manifest.projects,
            activeProjectPath: manifest.projects.first?.path ?? ".",
            storyboards: summaries.filter { $0.path.lowercased().hasSuffix(".sb") },
            sketches: summaries.filter { $0.path.lowercased().hasSuffix(".sk") },
            notes: summaries.filter { $0.path.lowercased().hasSuffix(".md") }
        )
    }

    func hydrate(
        repository: GitHubRepositorySummary,
        projects: [MobileProjectEntry],
        editableFiles: [String],
        assetFiles: [String],
        progress: (@Sendable (GitHubWorkspaceOpenProgress) -> Void)? = nil,
        fetchData: (String) async throws -> Data
    ) async throws {
        let workspaceURL = workspaceURL(repository: repository)
        if FileManager.default.fileExists(atPath: workspaceURL.path) {
            try FileManager.default.removeItem(at: workspaceURL)
        }
        try FileManager.default.createDirectory(at: filesURL(repository: repository), withIntermediateDirectories: true)

        let paths = editableFiles + assetFiles
        progress?(GitHubWorkspaceOpenProgress(phase: .downloadingFiles, completed: 0, total: paths.count))
        for (index, path) in paths.enumerated() {
            progress?(GitHubWorkspaceOpenProgress(phase: .downloadingFiles, completed: index, total: paths.count, currentPath: path))
            let data = try await fetchData(path)
            try storeData(data, path: path, repository: repository)
            progress?(GitHubWorkspaceOpenProgress(phase: .downloadingFiles, completed: index + 1, total: paths.count, currentPath: path))
        }

        let manifest = GitHubWorkspaceCacheManifest(
            defaultBranch: repository.defaultBranch,
            hydratedAt: Date(),
            projects: projects,
            editableFiles: editableFiles,
            assetFiles: assetFiles
        )
        let manifestData = try JSONEncoder().encode(manifest)
        try manifestData.write(to: manifestURL(repository: repository), options: .atomic)
    }

    func data(path: String, source: MobileWorkspaceSource) throws -> Data? {
        guard case .github(let repository) = source else {
            return nil
        }
        let url = try fileURL(path: path, repository: repository)
        guard FileManager.default.fileExists(atPath: url.path) else {
            return nil
        }
        return try Data(contentsOf: url)
    }

    func storeData(_ data: Data, path: String, source: MobileWorkspaceSource) throws {
        guard case .github(let repository) = source else {
            return
        }
        try storeData(data, path: path, repository: repository)
    }

    private func storeData(_ data: Data, path: String, repository: GitHubRepositorySummary) throws {
        try storeData(data, path: path, repository: repository.repositoryRef)
    }

    private func storeData(_ data: Data, path: String, repository: GitHubRepositoryRef) throws {
        let url = try fileURL(path: path, repository: repository)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
    }

    private func manifestURL(repository: GitHubRepositorySummary) -> URL {
        workspaceURL(repository: repository).appendingPathComponent("manifest.json")
    }

    private func workspaceURL(repository: GitHubRepositorySummary) -> URL {
        workspaceURL(fullName: repository.fullName, defaultBranch: repository.defaultBranch)
    }

    private func workspaceURL(fullName: String, defaultBranch: String) -> URL {
        rootDirectory
            .appendingPathComponent(safeSegment(fullName), isDirectory: true)
            .appendingPathComponent(safeSegment(defaultBranch), isDirectory: true)
    }

    private func filesURL(repository: GitHubRepositorySummary) -> URL {
        workspaceURL(repository: repository).appendingPathComponent("files", isDirectory: true)
    }

    private func filesURL(repository: GitHubRepositoryRef) -> URL {
        workspaceURL(fullName: repository.displayName, defaultBranch: repository.defaultBranch ?? "main")
            .appendingPathComponent("files", isDirectory: true)
    }

    private func fileURL(path: String, repository: GitHubRepositorySummary) throws -> URL {
        try fileURL(path: path, filesRoot: filesURL(repository: repository))
    }

    private func fileURL(path: String, repository: GitHubRepositoryRef) throws -> URL {
        try fileURL(path: path, filesRoot: filesURL(repository: repository))
    }

    private func fileURL(path: String, filesRoot: URL) throws -> URL {
        let normalized = path
            .replacingOccurrences(of: "\\", with: "/")
            .split(separator: "/", omittingEmptySubsequences: true)
            .map(String.init)
        guard !normalized.isEmpty, !normalized.contains("..") else {
            throw GitHubMobileError.unsupportedResponse
        }

        return normalized.reduce(filesRoot) { url, component in
            url.appendingPathComponent(component)
        }
    }

    private func safeSegment(_ value: String) -> String {
        value
            .replacingOccurrences(of: "/", with: "__")
            .replacingOccurrences(of: ":", with: "_")
    }
}

public protocol GitHubMobileClientProtocol: Sendable {
    func requestDeviceAuthorization(scopes: [String]) async throws -> GitHubDeviceAuthorization
    func pollAccessToken(deviceCode: String) async throws -> GitHubAccessToken
    func listRepositories(accessToken: String) async throws -> [GitHubRepositorySummary]
    func openWorkspace(
        repository: GitHubRepositorySummary,
        accessToken: String,
        progress: (@Sendable (GitHubWorkspaceOpenProgress) -> Void)?
    ) async throws -> MobileWorkspaceSnapshot
    func assetData(path: String, source: MobileWorkspaceSource, accessToken: String) async throws -> Data?
    func standardImageAsset(path: String, source: MobileWorkspaceSource, accessToken: String) async throws -> Data?
}

public struct MobileWorkspaceSnapshot: Equatable, Sendable {
    public var descriptor: MobileWorkspaceDescriptor
    public var projects: [MobileProjectEntry]
    public var activeProjectPath: String
    public var storyboards: [FileSummary]
    public var sketches: [FileSummary]
    public var notes: [FileSummary]

    public init(
        descriptor: MobileWorkspaceDescriptor,
        projects: [MobileProjectEntry],
        activeProjectPath: String,
        storyboards: [FileSummary],
        sketches: [FileSummary],
        notes: [FileSummary]
    ) {
        self.descriptor = descriptor
        self.projects = projects
        self.activeProjectPath = activeProjectPath
        self.storyboards = storyboards
        self.sketches = sketches
        self.notes = notes
    }
}

public struct GitHubMobileClient: GitHubMobileClientProtocol {
    private let clientID: String
    private let session: URLSession
    private let decoder: JSONDecoder
    private let cache: GitHubWorkspaceCache

    public init(clientID: String = "", session: URLSession = .shared, cache: GitHubWorkspaceCache = GitHubWorkspaceCache()) {
        let trimmedClientID = clientID.trimmingCharacters(in: .whitespacesAndNewlines)
        self.clientID = trimmedClientID
        self.session = session
        self.cache = cache

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        self.decoder = decoder
    }

    public func requestDeviceAuthorization(scopes: [String] = ["repo"]) async throws -> GitHubDeviceAuthorization {
        guard !clientID.isEmpty else {
            throw GitHubMobileError.missingClientID
        }

        let request = try formRequest(
            url: URL(string: "https://github.com/login/device/code")!,
            fields: [
                "client_id": clientID,
                "scope": scopes.joined(separator: " ")
            ]
        )
        let data = try await data(for: request)
        return try decoder.decode(GitHubDeviceAuthorization.self, from: data)
    }

    public func pollAccessToken(deviceCode: String) async throws -> GitHubAccessToken {
        guard !clientID.isEmpty else {
            throw GitHubMobileError.missingClientID
        }

        let request = try formRequest(
            url: URL(string: "https://github.com/login/oauth/access_token")!,
            fields: [
                "client_id": clientID,
                "device_code": deviceCode,
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code"
            ]
        )
        let data = try await data(for: request)

        if let response = try? decoder.decode(GitHubAccessToken.self, from: data) {
            return response
        }

        let error = try decoder.decode(GitHubOAuthError.self, from: data)
        switch error.error {
        case "authorization_pending":
            throw GitHubMobileError.authorizationPending
        case "access_denied":
            throw GitHubMobileError.authorizationDeclined
        case "expired_token":
            throw GitHubMobileError.authorizationExpired
        default:
            throw GitHubMobileError.api(error.errorDescription ?? error.error)
        }
    }

    public func listRepositories(accessToken: String) async throws -> [GitHubRepositorySummary] {
        var repositories: [GitHubRepositorySummary] = []
        var page = 1

        while true {
            let request = try apiRequest(
                path: "/user/repos",
                accessToken: accessToken,
                queryItems: [
                    URLQueryItem(name: "affiliation", value: "owner,collaborator,organization_member"),
                    URLQueryItem(name: "sort", value: "updated"),
                    URLQueryItem(name: "per_page", value: "100"),
                    URLQueryItem(name: "page", value: "\(page)")
                ]
            )
            let data = try await data(for: request)
            let pageRepositories = try decoder.decode([GitHubRepositorySummary].self, from: data)
            repositories.append(contentsOf: pageRepositories)

            guard pageRepositories.count == 100 else {
                return repositories
            }
            page += 1
        }
    }

    public func openWorkspace(
        repository: GitHubRepositorySummary,
        accessToken: String,
        progress: (@Sendable (GitHubWorkspaceOpenProgress) -> Void)? = nil
    ) async throws -> MobileWorkspaceSnapshot {
        progress?(GitHubWorkspaceOpenProgress(phase: .checkingCache))
        if let cached = try cache.snapshot(repository: repository, titleProvider: title(for:contents:)) {
            progress?(GitHubWorkspaceOpenProgress(phase: .readingCache))
            return cached
        }

        progress?(GitHubWorkspaceOpenProgress(phase: .fetchingManifest))
        let tree = try await repositoryTree(repository: repository, accessToken: accessToken)
        let projects = try await projectEntries(repository: repository, accessToken: accessToken)
        let files = tree.tree
            .filter { $0.type == "blob" && MobileWorkspacePolicy.canEdit(path: $0.path) }
            .sorted { $0.path < $1.path }
        let assets = tree.tree
            .filter { $0.type == "blob" && MobileWorkspacePolicy.canReadAsset(path: $0.path) }
            .sorted { $0.path < $1.path }

        try await cache.hydrate(
            repository: repository,
            projects: projects,
            editableFiles: files.map(\.path),
            assetFiles: assets.map(\.path),
            progress: progress,
            fetchData: { path in
                try await rawFileData(
                    path: path,
                    fullName: repository.fullName,
                    defaultBranch: repository.defaultBranch,
                    accessToken: accessToken
                )
            }
        )
        progress?(GitHubWorkspaceOpenProgress(phase: .finalizing))
        guard let cached = try cache.snapshot(repository: repository, titleProvider: title(for:contents:)) else {
            throw GitHubMobileError.unsupportedResponse
        }
        return cached
    }

    public func assetData(path: String, source: MobileWorkspaceSource, accessToken: String) async throws -> Data? {
        guard MobileWorkspacePolicy.canReadAsset(path: path) else {
            return nil
        }

        switch source {
        case .github(let repository):
            if let cached = try cache.data(path: path, source: source) {
                return cached
            }

            guard let data = try await optionalRawFileData(
                path: path,
                fullName: repository.displayName,
                defaultBranch: repository.defaultBranch ?? "main",
                accessToken: accessToken
            ) else {
                return nil
            }
            try cache.storeData(data, path: path, source: source)
            return data
        }
    }

    public func standardImageAsset(path: String, source: MobileWorkspaceSource, accessToken: String) async throws -> Data? {
        guard MobileWorkspacePolicy.canReadStandardImage(path: path) else {
            return nil
        }

        return try await assetData(path: path, source: source, accessToken: accessToken)
    }

    private func projectEntries(repository: GitHubRepositorySummary, accessToken: String) async throws -> [MobileProjectEntry] {
        guard let contents = try await optionalFileContents(
            path: ".cutready/projects.json",
            repository: repository,
            accessToken: accessToken
        ) else {
            return [
                MobileProjectEntry(path: ".", name: repository.name)
            ]
        }

        let data = Data(contents.utf8)
        let manifest = try decoder.decode(GitHubProjectManifest.self, from: data)
        return manifest.projects.isEmpty ? [MobileProjectEntry(path: ".", name: repository.name)] : manifest.projects
    }

    private func repositoryTree(repository: GitHubRepositorySummary, accessToken: String) async throws -> GitHubTreeResponse {
        let encodedBranch = repository.defaultBranch.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? repository.defaultBranch
        let request = try apiRequest(
            path: "/repos/\(repository.fullName)/git/trees/\(encodedBranch)",
            accessToken: accessToken,
            queryItems: [URLQueryItem(name: "recursive", value: "1")]
        )
        let data = try await data(for: request)
        return try decoder.decode(GitHubTreeResponse.self, from: data)
    }

    private func title(for path: String, contents: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "sb", "sk":
            return jsonTitle(from: contents) ?? fallbackTitle(for: path)
        case "md":
            return noteTitle(for: path)
        default:
            return fallbackTitle(for: path)
        }
    }

    private func fileContents(
        path: String,
        repository: GitHubRepositorySummary,
        accessToken: String
    ) async throws -> String {
        let request = try apiRequest(
            path: "/repos/\(repository.fullName)/contents/\(path)",
            accessToken: accessToken,
            queryItems: [URLQueryItem(name: "ref", value: repository.defaultBranch)]
        )
        let data = try await data(for: request)
        let response = try decoder.decode(GitHubContentResponse.self, from: data)
        guard response.encoding == "base64" else {
            throw GitHubMobileError.unsupportedResponse
        }

        let stripped = response.content.replacingOccurrences(of: "\n", with: "")
        guard
            let contentData = Data(base64Encoded: stripped),
            let contents = String(data: contentData, encoding: .utf8)
        else {
            throw GitHubMobileError.unsupportedResponse
        }
        return contents
    }

    private func fileData(
        path: String,
        repository: GitHubRepositorySummary,
        accessToken: String
    ) async throws -> Data {
        try await fileData(
            path: path,
            fullName: repository.fullName,
            defaultBranch: repository.defaultBranch,
            accessToken: accessToken
        )
    }

    private func fileData(
        path: String,
        fullName: String,
        defaultBranch: String,
        accessToken: String
    ) async throws -> Data {
        let request = try apiRequest(
            path: "/repos/\(fullName)/contents/\(path)",
            accessToken: accessToken,
            queryItems: [URLQueryItem(name: "ref", value: defaultBranch)]
        )
        let data = try await data(for: request)
        let response = try decoder.decode(GitHubContentResponse.self, from: data)
        guard response.encoding == "base64" else {
            throw GitHubMobileError.unsupportedResponse
        }

        let stripped = response.content.replacingOccurrences(of: "\n", with: "")
        guard let contentData = Data(base64Encoded: stripped) else {
            throw GitHubMobileError.unsupportedResponse
        }
        return contentData
    }

    private func rawFileData(
        path: String,
        fullName: String,
        defaultBranch: String,
        accessToken: String
    ) async throws -> Data {
        let request = try apiRequest(
            path: "/repos/\(fullName)/contents/\(path)",
            accessToken: accessToken,
            queryItems: [URLQueryItem(name: "ref", value: defaultBranch)],
            accept: "application/vnd.github.raw"
        )
        return try await data(for: request)
    }

    private func optionalFileData(
        path: String,
        repository: GitHubRepositorySummary,
        accessToken: String
    ) async throws -> Data? {
        try await optionalFileData(
            path: path,
            fullName: repository.fullName,
            defaultBranch: repository.defaultBranch,
            accessToken: accessToken
        )
    }

    private func optionalFileData(
        path: String,
        fullName: String,
        defaultBranch: String,
        accessToken: String
    ) async throws -> Data? {
        do {
            return try await fileData(path: path, fullName: fullName, defaultBranch: defaultBranch, accessToken: accessToken)
        } catch GitHubMobileError.unsupportedResponse {
            return nil
        } catch GitHubMobileError.api(let message) where message.localizedCaseInsensitiveContains("not found") {
            return nil
        }
    }

    private func optionalRawFileData(
        path: String,
        fullName: String,
        defaultBranch: String,
        accessToken: String
    ) async throws -> Data? {
        do {
            return try await rawFileData(path: path, fullName: fullName, defaultBranch: defaultBranch, accessToken: accessToken)
        } catch GitHubMobileError.api(let message) where message.localizedCaseInsensitiveContains("not found") {
            return nil
        }
    }

    private func optionalFileContents(
        path: String,
        repository: GitHubRepositorySummary,
        accessToken: String
    ) async throws -> String? {
        do {
            return try await fileContents(path: path, repository: repository, accessToken: accessToken)
        } catch GitHubMobileError.api(let message) where message.localizedCaseInsensitiveContains("not found") {
            return nil
        }
    }

    private func data(for request: URLRequest) async throws -> Data {
        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw GitHubMobileError.unsupportedResponse
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            let message = (try? decoder.decode(GitHubAPIError.self, from: data).message) ?? HTTPURLResponse.localizedString(forStatusCode: httpResponse.statusCode)
            throw GitHubMobileError.api(message)
        }
        return data
    }

    private func formRequest(url: URL, fields: [String: String]) throws -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = fields
            .map { key, value in
                "\(escape(key))=\(escape(value))"
            }
            .joined(separator: "&")
            .data(using: .utf8)
        return request
    }

    private func apiRequest(
        path: String,
        accessToken: String,
        queryItems: [URLQueryItem],
        accept: String = "application/vnd.github+json"
    ) throws -> URLRequest {
        var components = URLComponents()
        components.scheme = "https"
        components.host = "api.github.com"
        components.path = path
        components.queryItems = queryItems.isEmpty ? nil : queryItems
        guard let url = components.url else {
            throw GitHubMobileError.unsupportedResponse
        }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue(accept, forHTTPHeaderField: "Accept")
        request.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        return request
    }

    private func escape(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? value
    }

    private func jsonTitle(from contents: String) -> String? {
        guard
            let data = contents.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let title = object["title"] as? String,
            !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            return nil
        }
        return title
    }

    private func noteTitle(for path: String) -> String {
        URL(fileURLWithPath: path)
            .deletingPathExtension()
            .lastPathComponent
    }

    private func fallbackTitle(for path: String) -> String {
        URL(fileURLWithPath: path)
            .deletingPathExtension()
            .lastPathComponent
            .replacingOccurrences(of: "-", with: " ")
            .replacingOccurrences(of: "_", with: " ")
            .capitalized
    }

}

private struct GitHubOAuthError: Codable {
    var error: String
    var errorDescription: String?

    enum CodingKeys: String, CodingKey {
        case error
        case errorDescription = "error_description"
    }
}

private struct GitHubAPIError: Codable {
    var message: String
}

private struct GitHubProjectManifest: Codable {
    var projects: [MobileProjectEntry]
}

private struct GitHubWorkspaceCacheManifest: Codable {
    var defaultBranch: String
    var hydratedAt: Date
    var projects: [MobileProjectEntry]
    var editableFiles: [String]
    var assetFiles: [String]
}

private struct GitHubTreeResponse: Codable {
    var tree: [GitHubTreeItem]
}

private struct GitHubTreeItem: Codable {
    var path: String
    var type: String
}

private struct GitHubContentResponse: Codable {
    var content: String
    var encoding: String
}
