import XCTest
@testable import CutReadyMobileCore

final class StoryboardDocumentTests: XCTestCase {
    func testDecodesStoryboardWithSectionsAndSketchRefs() throws {
        let data = Data("""
        {
          "title": "Launch Storyboard",
          "description": "A guided launch demo.",
          "items": [
            {"type": "section", "title": "Setup", "description": "Frame the customer.", "sketches": ["intro.sk", "context.sk"]},
            {"type": "sketch_ref", "path": "handoff.sk"}
          ],
          "created_at": "2026-06-28T20:00:00Z",
          "updated_at": "2026-06-28T20:20:00Z"
        }
        """.utf8)

        let storyboard = try JSONDecoder().decode(Storyboard.self, from: data)

        XCTAssertEqual(storyboard.title, "Launch Storyboard")
        XCTAssertEqual(storyboard.items.count, 2)
        XCTAssertEqual(storyboard.description, "A guided launch demo.")
        if case .section(let title, let description, let sketches) = storyboard.items[0] {
            XCTAssertEqual(title, "Setup")
            XCTAssertEqual(description, "Frame the customer.")
            XCTAssertEqual(sketches, ["intro.sk", "context.sk"])
        } else {
            XCTFail("Expected a section item")
        }
    }

    func testDecodesLegacyStoryboardSketchesAndSketchItemType() throws {
        let legacyData = Data("""
        {
          "title": "Legacy",
          "sketches": ["intro.sk"],
          "created_at": "2026-06-28T20:00:00Z",
          "updated_at": "2026-06-28T20:20:00Z"
        }
        """.utf8)
        let sketchItemData = Data(#"{"type":"sketch","path":"intro.sk"}"#.utf8)

        let storyboard = try JSONDecoder().decode(Storyboard.self, from: legacyData)
        let item = try JSONDecoder().decode(StoryboardItem.self, from: sketchItemData)

        XCTAssertEqual(storyboard.description, "")
        XCTAssertEqual(storyboard.items, [.sketchRef(path: "intro.sk")])
        XCTAssertEqual(item, .sketchRef(path: "intro.sk"))
    }

    func testStoryboardEncodesDatesAsIsoStrings() throws {
        let storyboard = Storyboard(
            title: "Round trip",
            description: "Dates stay readable by Draftline.",
            items: [.sketchRef(path: "intro.sk")],
            createdAt: Date(timeIntervalSince1970: 1_767_225_600),
            updatedAt: Date(timeIntervalSince1970: 1_767_229_200)
        )

        let data = try JSONEncoder().encode(storyboard)
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let decoded = try JSONDecoder().decode(Storyboard.self, from: data)

        XCTAssertTrue(object?["created_at"] is String)
        XCTAssertEqual(decoded.title, storyboard.title)
        XCTAssertEqual(decoded.items, storyboard.items)
    }
}
