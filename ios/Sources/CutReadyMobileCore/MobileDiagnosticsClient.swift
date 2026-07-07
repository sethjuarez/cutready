import AuditaurAppleCore
import Foundation

public enum CutReadyMobileDiagnosticEvent: String, Sendable {
    case appLaunch = "cutready.app.launch"
    case authStart = "cutready.auth.start"
    case authComplete = "cutready.auth.complete"
    case authFailed = "cutready.auth.failed"
    case projectOpen = "cutready.project.open"
    case storyboardOpen = "cutready.storyboard.open"
    case sketchOpen = "cutready.sketch.open"
    case sketchEdit = "cutready.sketch.edit"
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
