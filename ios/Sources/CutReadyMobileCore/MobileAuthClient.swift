import Foundation

public enum OAuthProvider: String, Codable, CaseIterable, Sendable {
    case cutready
    case github
    case microsoft
}

public enum MobileAuthState: String, Codable, Sendable {
    case signedOut = "signed_out"
    case signingIn = "signing_in"
    case signedIn = "signed_in"
    case refreshing
    case failed
}

public struct MobileAuthSession: Codable, Equatable, Sendable {
    public var provider: OAuthProvider
    public var accountLabel: String
    public var scopes: [String]
    public var expiresAt: Date?

    public init(provider: OAuthProvider, accountLabel: String, scopes: [String], expiresAt: Date? = nil) {
        self.provider = provider
        self.accountLabel = accountLabel
        self.scopes = scopes
        self.expiresAt = expiresAt
    }
}

public struct OAuthSignInRequest: Codable, Equatable, Sendable {
    public var provider: OAuthProvider
    public var callbackURLScheme: String
    public var scopes: [String]

    public init(provider: OAuthProvider, callbackURLScheme: String, scopes: [String] = []) {
        self.provider = provider
        self.callbackURLScheme = callbackURLScheme
        self.scopes = scopes
    }
}

public struct OAuthSignInChallenge: Codable, Equatable, Sendable {
    public var authorizationURL: URL
    public var callbackURLScheme: String

    public init(authorizationURL: URL, callbackURLScheme: String) {
        self.authorizationURL = authorizationURL
        self.callbackURLScheme = callbackURLScheme
    }
}

public protocol MobileAuthClient: Sendable {
    func currentSession() async throws -> MobileAuthSession?
    func beginSignIn(_ request: OAuthSignInRequest) async throws -> OAuthSignInChallenge
    func completeSignIn(callbackURL: URL) async throws -> MobileAuthSession
    func refreshSession() async throws -> MobileAuthSession
    func signOut() async throws
}
