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
