import XCTest
@testable import CutReadyMobileCore

final class MobileDiagnosticsTests: XCTestCase {
    func testRecordsCutReadyDomainEvent() async throws {
        let exporter = InMemoryAuditaurExporter()
        let diagnostics = CutReadyMobileDiagnostics(sessionId: "test-session", exporter: exporter)

        try await diagnostics.record(
            .sketchEdit,
            attributes: ["surface": "ipad", "field": "narrative"]
        )

        let events = await exporter.exportedEvents()
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].serviceName, "cutready-ios")
        XCTAssertEqual(events[0].sessionId, "test-session")
        XCTAssertEqual(events[0].name, "cutready.sketch.edit")
    }

    func testRecordsSyncSpan() async throws {
        let exporter = InMemoryAuditaurExporter()
        let diagnostics = CutReadyMobileDiagnostics(sessionId: "test-session", exporter: exporter)

        let span = diagnostics.startSpan(.syncPush, attributes: ["entity.count": 2])
        try await diagnostics.recordSpanEvent(span: span, name: "sync.upload.started")
        try await diagnostics.endSpan(span, status: .ok)

        let spans = await exporter.exportedSpans()
        XCTAssertEqual(spans.count, 1)
        XCTAssertEqual(spans[0].name, "cutready.sync.push")
        XCTAssertEqual(spans[0].statusCode, AuditaurSpanStatus.ok.rawValue)
    }
}
