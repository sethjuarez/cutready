import XCTest
@testable import CutReadyMobileCore

final class SketchDocumentTests: XCTestCase {
    func testDecodesExampleSketchWithPathBackedVisual() throws {
        let data = Data("""
        {
          "title": "Plan the demo",
          "locked": false,
          "description": "Show how a rough idea becomes a structured CutReady sketch.",
          "rows": [
            {
              "locked": false,
              "locks": {},
              "time": "0:00",
              "duration_seconds": 20,
              "narrative": "Start with a clear promise.",
              "demo_actions": "Open the CutReady workspace.",
              "screenshot": ".cutready/screenshots/home-overview.png",
              "visual": ".cutready/visuals/demo-loop.json",
              "design_plan": "Use a loop metaphor.",
              "narration": {
                "path": ".cutready/narration/row-1.webm",
                "source_text": "Start with a clear promise.",
                "source_text_hash": "abc123",
                "mime_type": "audio/webm;codecs=opus",
                "duration_ms": 10263,
                "byte_size": 164516,
                "recorded_at": "2026-07-03T10:41:38.749864800Z"
              }
            }
          ],
          "metadata": {
            "fields": {
              "Audience": "New CutReady users",
              "Goal": "Explain sketch-first planning"
            }
          },
          "state": "draft",
          "created_at": "2026-06-28T20:00:00Z",
          "updated_at": "2026-06-28T20:20:00Z"
        }
        """.utf8)

        let sketch = try JSONDecoder().decode(Sketch.self, from: data)

        XCTAssertEqual(sketch.title, "Plan the demo")
        XCTAssertEqual(sketch.rows.count, 1)
        XCTAssertEqual(sketch.rows[0].visual, .string(".cutready/visuals/demo-loop.json"))
        XCTAssertEqual(sketch.rows[0].narration?.path, ".cutready/narration/row-1.webm")
        XCTAssertEqual(sketch.rows[0].narration?.mimeType, "audio/webm;codecs=opus")
        XCTAssertEqual(sketch.metadata?.fields?["Audience"], "New CutReady users")
    }

    func testDecodesLegacyNumericSketchDates() throws {
        let data = Data("""
        {
          "title": "Numeric dates",
          "description": "",
          "rows": [],
          "state": "draft",
          "created_at": 789004800,
          "updated_at": 1783530000
        }
        """.utf8)

        let sketch = try JSONDecoder().decode(Sketch.self, from: data)

        XCTAssertEqual(sketch.title, "Numeric dates")
        XCTAssertGreaterThan(sketch.createdAt.timeIntervalSince1970, 1_500_000_000)
        XCTAssertEqual(sketch.updatedAt.timeIntervalSince1970, 1_783_530_000, accuracy: 0.001)
    }

    func testDecodesNullSketchDatesAsDefaults() throws {
        let data = Data("""
        {
          "title": "Null dates",
          "description": "",
          "rows": [],
          "state": "draft",
          "created_at": null,
          "updated_at": null
        }
        """.utf8)

        let sketch = try JSONDecoder().decode(Sketch.self, from: data)

        XCTAssertEqual(sketch.createdAt.timeIntervalSince1970, 0, accuracy: 0.001)
        XCTAssertEqual(sketch.updatedAt, sketch.createdAt)
    }

    func testEncodesSketchDatesAsIsoStrings() throws {
        let sketch = Sketch(
            title: "ISO dates",
            rows: [],
            createdAt: Date(timeIntervalSince1970: 1_783_530_000),
            updatedAt: Date(timeIntervalSince1970: 1_783_530_060)
        )

        let data = try JSONEncoder().encode(sketch)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(object["created_at"] as? String, "2026-07-08T17:00:00.000Z")
        XCTAssertEqual(object["updated_at"] as? String, "2026-07-08T17:01:00.000Z")
    }
}
