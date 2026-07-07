import XCTest
@testable import CutReadyMobileCore

final class NoteDocumentTests: XCTestCase {
    func testParsesFrontmatterFieldsAndBody() {
        let document = parseNoteDocument("""
        ---
        Audience: Product team
        Status: "Needs: review"
        ---
        # Planning notes

        Body copy.
        """)

        XCTAssertEqual(document.metadata.fields["Audience"], "Product team")
        XCTAssertEqual(document.metadata.fields["Status"], "Needs: review")
        XCTAssertEqual(document.body, "# Planning notes\n\nBody copy.")
    }

    func testLeavesPlainMarkdownUntouched() {
        let markdown = "# Title\n\nNo metadata."
        let document = parseNoteDocument(markdown)

        XCTAssertTrue(document.metadata.fields.isEmpty)
        XCTAssertEqual(document.body, markdown)
    }

    func testTreatsUnclosedFrontmatterAsBody() {
        let markdown = "---\nStatus: Draft\n# Missing close"
        let document = parseNoteDocument(markdown)

        XCTAssertTrue(document.metadata.fields.isEmpty)
        XCTAssertEqual(document.body, markdown)
    }
}
