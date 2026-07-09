import Foundation

public enum AuditaurAttributeValue: Equatable, Sendable {
    case string(String)
    case integer(Int)
    case double(Double)
    case bool(Bool)
}

extension AuditaurAttributeValue: ExpressibleByStringLiteral {
    public init(stringLiteral value: String) {
        self = .string(value)
    }
}

extension AuditaurAttributeValue: ExpressibleByIntegerLiteral {
    public init(integerLiteral value: Int) {
        self = .integer(value)
    }
}

extension AuditaurAttributeValue: ExpressibleByFloatLiteral {
    public init(floatLiteral value: Double) {
        self = .double(value)
    }
}

extension AuditaurAttributeValue: ExpressibleByBooleanLiteral {
    public init(booleanLiteral value: Bool) {
        self = .bool(value)
    }
}

public typealias AuditaurAttributes = [String: AuditaurAttributeValue]

public struct AuditaurEvent: Equatable, Sendable {
    public let serviceName: String
    public let sessionId: String
    public let name: String
    public let attributes: AuditaurAttributes
    public let timestamp: Date
}

public struct AuditaurSpan: Equatable, Sendable {
    public let id: UUID
    public let serviceName: String
    public let sessionId: String
    public let name: String
    public let attributes: AuditaurAttributes
    public let startedAt: Date
}

public enum AuditaurSpanStatus: String, Sendable {
    case ok
    case error
}

public struct AuditaurCompletedSpan: Equatable, Sendable {
    public let span: AuditaurSpan
    public let statusCode: String
    public let statusMessage: String?
    public let endedAt: Date

    public var name: String {
        span.name
    }
}

public protocol AuditaurExporting: Sendable {
    func exportEvent(_ event: AuditaurEvent) async throws
    func exportSpan(_ span: AuditaurCompletedSpan) async throws
}

public final class AuditaurDiagnostics: Sendable {
    private let serviceName: String
    private let sessionId: String
    private let exporter: any AuditaurExporting

    public init(serviceName: String, sessionId: String, exporter: any AuditaurExporting) {
        self.serviceName = serviceName
        self.sessionId = sessionId
        self.exporter = exporter
    }

    public func recordEvent(name: String, attributes: AuditaurAttributes = [:]) async throws {
        try await exporter.exportEvent(
            AuditaurEvent(
                serviceName: serviceName,
                sessionId: sessionId,
                name: name,
                attributes: attributes,
                timestamp: Date()
            )
        )
    }

    public func capture(error: Error, name: String, attributes: AuditaurAttributes = [:]) async throws {
        var merged = attributes
        merged["error.localizedDescription"] = .string(error.localizedDescription)
        try await recordEvent(name: name, attributes: merged)
    }

    public func startSpan(name: String, attributes: AuditaurAttributes = [:]) -> AuditaurSpan {
        AuditaurSpan(
            id: UUID(),
            serviceName: serviceName,
            sessionId: sessionId,
            name: name,
            attributes: attributes,
            startedAt: Date()
        )
    }

    public func endSpan(
        _ span: AuditaurSpan,
        status: AuditaurSpanStatus,
        statusMessage: String? = nil
    ) async throws {
        try await exporter.exportSpan(
            AuditaurCompletedSpan(
                span: span,
                statusCode: status.rawValue,
                statusMessage: statusMessage,
                endedAt: Date()
            )
        )
    }

    public func recordSpanEvent(
        span: AuditaurSpan,
        name: String,
        attributes: AuditaurAttributes = [:]
    ) async throws {
        var merged = attributes
        merged["span.id"] = .string(span.id.uuidString)
        try await recordEvent(name: name, attributes: merged)
    }
}

public actor InMemoryAuditaurExporter: AuditaurExporting {
    private var events: [AuditaurEvent] = []
    private var spans: [AuditaurCompletedSpan] = []

    public init() {}

    public func exportEvent(_ event: AuditaurEvent) {
        events.append(event)
    }

    public func exportSpan(_ span: AuditaurCompletedSpan) {
        spans.append(span)
    }

    public func exportedEvents() -> [AuditaurEvent] {
        events
    }

    public func exportedSpans() -> [AuditaurCompletedSpan] {
        spans
    }
}

public struct FileAuditaurExporter: AuditaurExporting {
    private let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    public func exportEvent(_ event: AuditaurEvent) async throws {
        try writeJSON(payload: event.dictionaryPayload(kind: "event"))
    }

    public func exportSpan(_ span: AuditaurCompletedSpan) async throws {
        try writeJSON(payload: span.dictionaryPayload(kind: "span"))
    }

    private func writeJSON(payload: [String: Any]) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let fileURL = directory.appendingPathComponent("\(UUID().uuidString).json")
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: fileURL, options: .atomic)
    }
}

public struct AuditaurHTTPExporter: AuditaurExporting {
    private let endpoint: URL
    private let session: URLSession

    public init(endpoint: URL, session: URLSession = .shared) {
        self.endpoint = endpoint
        self.session = session
    }

    public func exportEvent(_ event: AuditaurEvent) async throws {
        try await postJSON(payload: event.dictionaryPayload(kind: "event"))
    }

    public func exportSpan(_ span: AuditaurCompletedSpan) async throws {
        try await postJSON(payload: span.dictionaryPayload(kind: "span"))
    }

    private func postJSON(payload: [String: Any]) async throws {
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)
        _ = try await session.data(for: request)
    }
}

private extension AuditaurEvent {
    func dictionaryPayload(kind: String) -> [String: Any] {
        [
            "kind": kind,
            "serviceName": serviceName,
            "sessionId": sessionId,
            "name": name,
            "attributes": attributes.dictionaryValue,
            "timestamp": ISO8601DateFormatter().string(from: timestamp)
        ]
    }
}

private extension AuditaurCompletedSpan {
    func dictionaryPayload(kind: String) -> [String: Any] {
        [
            "kind": kind,
            "serviceName": span.serviceName,
            "sessionId": span.sessionId,
            "name": span.name,
            "attributes": span.attributes.dictionaryValue,
            "startedAt": ISO8601DateFormatter().string(from: span.startedAt),
            "endedAt": ISO8601DateFormatter().string(from: endedAt),
            "statusCode": statusCode,
            "statusMessage": statusMessage as Any
        ]
    }
}

private extension Dictionary where Key == String, Value == AuditaurAttributeValue {
    var dictionaryValue: [String: Any] {
        mapValues { value in
            switch value {
            case .string(let string):
                return string
            case .integer(let integer):
                return integer
            case .double(let double):
                return double
            case .bool(let bool):
                return bool
            }
        }
    }
}

public enum CutReadyMobileDiagnosticEvent: String, Sendable {
    case appLaunch = "cutready.app.launch"
    case authStart = "cutready.auth.start"
    case authComplete = "cutready.auth.complete"
    case authFailed = "cutready.auth.failed"
    case projectOpen = "cutready.project.open"
    case storyboardOpen = "cutready.storyboard.open"
    case sketchOpen = "cutready.sketch.open"
    case sketchEdit = "cutready.sketch.edit"
    case syncRefresh = "cutready.sync.refresh"
    case syncPull = "cutready.sync.pull"
    case syncPush = "cutready.sync.push"
    case syncFailed = "cutready.sync.failed"
    case draftlineError = "cutready.draftline.error"
    case agentiveRewrite = "cutready.agentive.rewrite"
    case agentiveFailed = "cutready.agentive.failed"
    case conflictDetected = "cutready.conflict.detected"
}

public struct CutReadyMobileDiagnostics {
    private let diagnostics: AuditaurDiagnostics

    public init(serviceName: String = "cutready-ios", sessionId: String, exporter: any AuditaurExporting) {
        self.diagnostics = AuditaurDiagnostics(
            serviceName: serviceName,
            sessionId: sessionId,
            exporter: exporter
        )
    }

    public init(serviceName: String = "cutready-ios", sessionId: String, diagnosticsDirectory: URL) {
        self.init(
            serviceName: serviceName,
            sessionId: sessionId,
            exporter: FileAuditaurExporter(directory: diagnosticsDirectory)
        )
    }

    public init(serviceName: String = "cutready-ios", sessionId: String, endpoint: URL) {
        self.init(
            serviceName: serviceName,
            sessionId: sessionId,
            exporter: AuditaurHTTPExporter(endpoint: endpoint)
        )
    }

    public func record(
        _ event: CutReadyMobileDiagnosticEvent,
        attributes: AuditaurAttributes = [:]
    ) async throws {
        try await diagnostics.recordEvent(name: event.rawValue, attributes: attributes)
    }

    public func capture(
        _ error: Error,
        name: CutReadyMobileDiagnosticEvent,
        attributes: AuditaurAttributes = [:]
    ) async throws {
        try await diagnostics.capture(error: error, name: name.rawValue, attributes: attributes)
    }

    public func startSpan(
        _ event: CutReadyMobileDiagnosticEvent,
        attributes: AuditaurAttributes = [:]
    ) -> AuditaurSpan {
        diagnostics.startSpan(name: event.rawValue, attributes: attributes)
    }

    public func endSpan(
        _ span: AuditaurSpan,
        status: AuditaurSpanStatus,
        statusMessage: String? = nil
    ) async throws {
        try await diagnostics.endSpan(span, status: status, statusMessage: statusMessage)
    }

    public func recordSpanEvent(
        span: AuditaurSpan,
        name: String,
        attributes: AuditaurAttributes = [:]
    ) async throws {
        try await diagnostics.recordSpanEvent(span: span, name: name, attributes: attributes)
    }
}
