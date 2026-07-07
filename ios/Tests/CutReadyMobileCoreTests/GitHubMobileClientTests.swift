import XCTest
@testable import CutReadyMobileCore

final class GitHubMobileClientTests: XCTestCase {
    override func tearDown() {
        MockURLProtocol.requestHandler = nil
        super.tearDown()
    }

    func testListRepositoriesUsesBearerTokenAuthorization() async throws {
        let session = URLSession(configuration: mockSessionConfiguration())
        let client = GitHubMobileClient(session: session)

        MockURLProtocol.requestHandler = { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer gh_test_token")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/vnd.github+json")
            XCTAssertEqual(request.url?.path, "/user/repos")

            let response = try XCTUnwrap(HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            ))
            let data = Data("""
            [
              {
                "id": 42,
                "name": "cutready-demo",
                "full_name": "sethjuarez/cutready-demo",
                "private": true,
                "default_branch": "main",
                "updated_at": "2026-07-07T17:00:00Z"
              }
            ]
            """.utf8)
            return (response, data)
        }

        let repositories = try await client.listRepositories(accessToken: "gh_test_token")

        XCTAssertEqual(repositories.count, 1)
        XCTAssertEqual(repositories[0].fullName, "sethjuarez/cutready-demo")
        XCTAssertEqual(repositories[0].repositoryRef.owner, "sethjuarez")
    }

    func testListRepositoriesToleratesFractionalDatesAndMissingDefaultBranch() async throws {
        let session = URLSession(configuration: mockSessionConfiguration())
        let client = GitHubMobileClient(session: session)

        MockURLProtocol.requestHandler = { request in
            let response = try XCTUnwrap(HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            ))
            let data = Data("""
            [
              {
                "id": 42,
                "name": "empty-demo",
                "full_name": "sethjuarez/empty-demo",
                "private": false,
                "updated_at": "2026-07-07T17:00:00.123Z"
              }
            ]
            """.utf8)
            return (response, data)
        }

        let repositories = try await client.listRepositories(accessToken: "gh_test_token")

        XCTAssertEqual(repositories[0].defaultBranch, "main")
        XCTAssertNotNil(repositories[0].updatedAt)
    }

    private func mockSessionConfiguration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        return configuration
    }
}

private final class MockURLProtocol: URLProtocol {
    static var requestHandler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let requestHandler = Self.requestHandler else {
            client?.urlProtocol(self, didFailWithError: GitHubMobileClientTestError.missingHandler)
            return
        }

        do {
            let (response, data) = try requestHandler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private enum GitHubMobileClientTestError: Error {
    case missingHandler
}
