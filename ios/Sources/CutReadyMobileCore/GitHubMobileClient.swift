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

public protocol GitHubMobileClientProtocol: Sendable {
    func requestDeviceAuthorization(scopes: [String]) async throws -> GitHubDeviceAuthorization
    func pollAccessToken(deviceCode: String) async throws -> GitHubAccessToken
    func listRepositories(accessToken: String) async throws -> [GitHubRepositorySummary]
    func openWorkspace(repository: GitHubRepositorySummary, accessToken: String) async throws -> MobileWorkspaceSnapshot
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

    public init(clientID: String = "", session: URLSession = .shared) {
        let trimmedClientID = clientID.trimmingCharacters(in: .whitespacesAndNewlines)
        self.clientID = trimmedClientID
        self.session = session

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

    public func openWorkspace(repository: GitHubRepositorySummary, accessToken: String) async throws -> MobileWorkspaceSnapshot {
        let tree = try await repositoryTree(repository: repository, accessToken: accessToken)
        let projects = try await projectEntries(repository: repository, accessToken: accessToken)
        let files = tree.tree
            .filter { $0.type == "blob" && MobileWorkspacePolicy.canEdit(path: $0.path) }
            .sorted { $0.path < $1.path }

        let storyboards = try await summaries(
            for: files.filter { $0.path.lowercased().hasSuffix(".sb") },
            repository: repository,
            accessToken: accessToken
        )
        let sketches = try await summaries(
            for: files.filter { $0.path.lowercased().hasSuffix(".sk") },
            repository: repository,
            accessToken: accessToken,
            includeContents: true
        )
        let notes = try await summaries(
            for: files.filter { $0.path.lowercased().hasSuffix(".md") },
            repository: repository,
            accessToken: accessToken,
            includeContents: true
        )

        let descriptor = MobileWorkspaceDescriptor(
            id: repository.fullName,
            name: repository.name,
            source: .github(repository.repositoryRef)
        )

        return MobileWorkspaceSnapshot(
            descriptor: descriptor,
            projects: projects,
            activeProjectPath: projects.first?.path ?? ".",
            storyboards: storyboards,
            sketches: sketches,
            notes: notes
        )
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

    private func summaries(
        for files: [GitHubTreeItem],
        repository: GitHubRepositorySummary,
        accessToken: String,
        includeContents: Bool = false
    ) async throws -> [FileSummary] {
        var summaries: [FileSummary] = []
        for file in files {
            let contents = try await fileContents(path: file.path, repository: repository, accessToken: accessToken)
            summaries.append(
                FileSummary(
                    path: file.path,
                    title: title(for: file, contents: contents),
                    contents: includeContents ? contents : nil,
                    updatedAt: nil
                )
            )
        }
        return summaries
    }

    private func title(for file: GitHubTreeItem, contents: String) -> String {
        switch (file.path as NSString).pathExtension.lowercased() {
        case "sb", "sk":
            return jsonTitle(from: contents) ?? fallbackTitle(for: file.path)
        case "md":
            return markdownTitle(from: contents) ?? fallbackTitle(for: file.path)
        default:
            return fallbackTitle(for: file.path)
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

    private func apiRequest(path: String, accessToken: String, queryItems: [URLQueryItem]) throws -> URLRequest {
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
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
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

    private func markdownTitle(from contents: String) -> String? {
        contents
            .split(separator: "\n", omittingEmptySubsequences: false)
            .lazy
            .compactMap { line -> String? in
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                guard trimmed.hasPrefix("# ") else { return nil }
                return String(trimmed.dropFirst(2)).trimmingCharacters(in: .whitespaces)
            }
            .first
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
