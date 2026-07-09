import XCTest
@testable import CutReadyMobileCore

final class PlayerTimelineTests: XCTestCase {
    func testSketchTimelineUsesFreshNarrationTiming() {
        let row = PlanningRow(
            time: "0:00",
            durationSeconds: 30,
            narrative: "Welcome everyone to the launch demo.",
            demoActions: "Open the app.",
            screenshot: "screenshots/intro.png",
            narration: RowNarration(
                path: ".cutready/narration/intro.m4a",
                sourceText: "Welcome everyone to the launch demo.",
                durationMs: 12_500
            )
        )
        let sketch = sketch(title: "Intro", description: "Intro description.", rows: [row])

        let timeline = PlayerTimeline.sketch(path: "intro.sk", sketch: sketch)

        XCTAssertEqual(timeline.kind, .sketch)
        XCTAssertEqual(timeline.beats.count, 1)
        XCTAssertEqual(timeline.beats[0].narrationText, "Welcome everyone to the launch demo.")
        XCTAssertEqual(timeline.beats[0].sketchDescription, "Intro description.")
        XCTAssertEqual(timeline.beats[0].stageDirectionText, "Open the app.")
        XCTAssertEqual(timeline.beats[0].duration, 12.5, accuracy: 0.001)
        XCTAssertEqual(timeline.beats[0].timingSource, .narration)
        XCTAssertTrue(timeline.usesNarrationTiming)
    }

    func testSketchTimelineFallsBackFromStaleNarrationTiming() {
        let row = PlanningRow(
            time: "0:00",
            durationSeconds: 8,
            narrative: "The edited line should not use stale audio timing.",
            demoActions: "",
            narration: RowNarration(
                path: ".cutready/narration/old.m4a",
                sourceText: "An older narration line.",
                durationMs: 60_000
            )
        )
        let sketch = sketch(title: "Edited", rows: [row])

        let timeline = PlayerTimeline.sketch(path: "edited.sk", sketch: sketch)

        XCTAssertEqual(timeline.beats[0].duration, 8)
        XCTAssertEqual(timeline.beats[0].narrationText, "The edited line should not use stale audio timing.")
        XCTAssertEqual(timeline.beats[0].stageDirectionText, "")
        XCTAssertEqual(timeline.beats[0].timingSource, .rowDuration)
        XCTAssertFalse(timeline.usesNarrationTiming)
    }

    func testSketchTimelineFiltersEmptyRowsAndEstimatesUntimedRows() {
        let empty = PlanningRow(time: "", narrative: "", demoActions: "")
        let untimed = PlanningRow(
            time: "",
            narrative: "This row has enough narration to estimate a rehearsal beat.",
            demoActions: ""
        )

        let timeline = PlayerTimeline.sketch(path: "estimate.sk", sketch: sketch(title: "Estimate", rows: [empty, untimed]))

        XCTAssertEqual(timeline.beats.count, 1)
        XCTAssertEqual(timeline.beats[0].rowIndex, 1)
        XCTAssertEqual(timeline.beats[0].timingSource, .estimated)
        XCTAssertGreaterThanOrEqual(timeline.beats[0].duration, 4)
    }

    func testStoryboardTimelineSequencesSectionsAndSketches() {
        let storyboard = Storyboard(
            title: "Launch Storyboard",
            description: "",
            items: [
                .section(title: "Setup", description: nil, sketches: ["intro.sk"]),
                .sketchRef(path: "handoff.sk")
            ],
            createdAt: Date(timeIntervalSince1970: 0),
            updatedAt: Date(timeIntervalSince1970: 0)
        )
        let sketches = [
            "intro.sk": sketch(title: "Intro", rows: [
                PlanningRow(time: "", durationSeconds: 5, narrative: "Set the hook.", demoActions: "")
            ]),
            "handoff.sk": sketch(title: "Handoff", rows: [
                PlanningRow(time: "", durationSeconds: 7, narrative: "Close with the export.", demoActions: "")
            ])
        ]

        let timeline = PlayerTimeline.storyboard(
            title: storyboard.title,
            storyboard: storyboard,
            sketchesByPath: sketches
        )

        XCTAssertEqual(timeline.kind, .storyboard)
        XCTAssertEqual(timeline.beats.map(\.sketchTitle), ["Intro", "Handoff"])
        XCTAssertEqual(timeline.beats[0].sectionTitle, "Setup")
        XCTAssertNil(timeline.beats[1].sectionTitle)
        XCTAssertEqual(timeline.totalDuration, 12)
    }

    private func sketch(title: String, description: String = "", rows: [PlanningRow]) -> Sketch {
        Sketch(
            title: title,
            description: description.isEmpty ? .null : .string(description),
            rows: rows,
            createdAt: Date(timeIntervalSince1970: 0),
            updatedAt: Date(timeIntervalSince1970: 0)
        )
    }
}
