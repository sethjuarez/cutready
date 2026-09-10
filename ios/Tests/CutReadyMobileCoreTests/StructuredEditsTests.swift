import XCTest
@testable import CutReadyMobileCore

final class StructuredEditsTests: XCTestCase {
    func testUpdatesRowNarrativeWithoutChangingOtherFields() throws {
        let now = Date(timeIntervalSince1970: 10)
        var sketch = makeSketch()

        try MobileEdits.apply(
            .updateRowText(index: 0, RowTextUpdate(narrative: "Updated narration")),
            to: &sketch,
            now: now
        )

        XCTAssertEqual(sketch.rows[0].narrative, "Updated narration")
        XCTAssertEqual(sketch.rows[0].demoActions, "Click Launch")
        XCTAssertEqual(sketch.updatedAt, now)
    }

    func testLockedCellRejectsMobileEdit() throws {
        var sketch = makeSketch(
            rows: [
                PlanningRow(
                    locks: [.narrative: true],
                    time: "0:00",
                    narrative: "Original narration",
                    demoActions: "Click Launch"
                )
            ]
        )

        XCTAssertThrowsError(
            try MobileEdits.apply(
                .updateRowText(index: 0, RowTextUpdate(narrative: "Updated narration")),
                to: &sketch
            )
        ) { error in
            XCTAssertEqual(error as? MobileEditError, .lockedCell(index: 0, field: .narrative))
        }
    }

    func testReordersRowsWhenIDsMatchExactly() throws {
        var sketch = makeSketch(rows: [
            PlanningRow(time: "0:00", narrative: "First", demoActions: "Open"),
            PlanningRow(time: "0:10", narrative: "Second", demoActions: "Click")
        ])

        try MobileEdits.apply(.reorderRows([1, 0]), to: &sketch)

        XCTAssertEqual(sketch.rows.map(\.narrative), ["Second", "First"])
    }

    func testRejectsInvalidReorder() throws {
        var sketch = makeSketch()

        XCTAssertThrowsError(try MobileEdits.apply(.reorderRows([0, 2]), to: &sketch)) { error in
            XCTAssertEqual(error as? MobileEditError, .invalidReorder(indices: [0, 2]))
        }
    }

    func testRowTextEditPreservesDesktopOnlyAndUnknownFields() throws {
        // A populated desktop sketch: row carries motion_points/typing_spots/
        // motion_plan/narration_plan the mobile model does not model, plus an
        // unknown future field at both row and document level (issue #272).
        let data = Data("""
        {
          "title": "Preserve everything",
          "description": "",
          "rows": [
            {
              "time": "0:20",
              "narrative": "Welcome",
              "demo_actions": "",
              "screenshot": "screenshots/intro.png",
              "motion_points": [
                { "rank": 1, "x": 0.5, "y": 0.5, "label": null }
              ],
              "typing_spots": [{ "x": 0.1, "y": 0.2, "text": "hi" }],
              "motion_plan": { "keyframes": [{ "t": 0.0, "scale": 1.0 }] },
              "narration_plan": { "ssml": "<speak>Welcome</speak>" },
              "future_row_field": { "nested": [1, 2, 3] }
            }
          ],
          "state": "draft",
          "created_at": "2026-06-28T20:00:00Z",
          "updated_at": "2026-06-28T20:20:00Z",
          "future_document_field": ["still", "here"]
        }
        """.utf8)

        var sketch = try JSONDecoder().decode(Sketch.self, from: data)
        let originalRowExtras = sketch.rows[0].unknownFields
        let originalDocExtras = sketch.unknownFields
        XCTAssertNotNil(originalRowExtras["motion_points"])
        XCTAssertNotNil(originalRowExtras["typing_spots"])
        XCTAssertNotNil(originalRowExtras["motion_plan"])
        XCTAssertNotNil(originalRowExtras["narration_plan"])
        XCTAssertNotNil(originalRowExtras["future_row_field"])
        XCTAssertNotNil(originalDocExtras["future_document_field"])

        try MobileEdits.apply(
            .updateRowText(index: 0, RowTextUpdate(narrative: "Updated welcome")),
            to: &sketch,
            now: Date(timeIntervalSince1970: 99)
        )

        let encoded = try JSONEncoder().encode(sketch)
        let roundTripped = try JSONDecoder().decode(Sketch.self, from: encoded)

        XCTAssertEqual(roundTripped.rows[0].narrative, "Updated welcome")
        // Every untouched field survives the decode -> edit -> encode round trip.
        XCTAssertEqual(roundTripped.rows[0].unknownFields, originalRowExtras)
        XCTAssertEqual(roundTripped.unknownFields, originalDocExtras)
        // Null semantics inside preserved data are retained.
        if case let .array(points)? = roundTripped.rows[0].unknownFields["motion_points"],
           case let .object(first)? = points.first {
            XCTAssertEqual(first["label"], .null)
        } else {
            XCTFail("motion_points did not round trip as an array of objects")
        }
    }

    private func makeSketch(rows: [PlanningRow]? = nil) -> Sketch {
        Sketch(
            title: "Intro",
            rows: rows ?? [
                PlanningRow(time: "0:00", narrative: "Original narration", demoActions: "Click Launch")
            ],
            createdAt: Date(timeIntervalSince1970: 0),
            updatedAt: Date(timeIntervalSince1970: 0)
        )
    }
}
