import XCTest
@testable import CutReadyMobileCore

final class MobileWorkspacePolicyTests: XCTestCase {
    func testAllowsOnlyCutReadyEditableDocuments() {
        XCTAssertTrue(MobileWorkspacePolicy.canEdit(path: "demo/storyboard.sb"))
        XCTAssertTrue(MobileWorkspacePolicy.canEdit(path: "demo/sketch.sk"))
        XCTAssertTrue(MobileWorkspacePolicy.canEdit(path: "notes/rehearsal.md"))

        XCTAssertFalse(MobileWorkspacePolicy.canEdit(path: "Package.swift"))
        XCTAssertFalse(MobileWorkspacePolicy.canEdit(path: ".github/workflows/release.yml"))
        XCTAssertFalse(MobileWorkspacePolicy.canEdit(path: "../outside.sk"))
    }

    func testAllowsOnlyApprovedCutReadyAssets() {
        XCTAssertTrue(MobileWorkspacePolicy.canReadAsset(path: ".cutready/screenshots/hero.png"))
        XCTAssertTrue(MobileWorkspacePolicy.canReadAsset(path: "docs/examples/demo/.cutready/screenshots/hero.png"))
        XCTAssertTrue(MobileWorkspacePolicy.canReadAsset(path: ".cutready/visuals/frame.json"))
        XCTAssertTrue(MobileWorkspacePolicy.canReadAsset(path: ".cutready/narration/row.m4a"))

        XCTAssertFalse(MobileWorkspacePolicy.canReadAsset(path: ".git/config"))
        XCTAssertFalse(MobileWorkspacePolicy.canReadAsset(path: ".cutready/agent-state.db"))
        XCTAssertFalse(MobileWorkspacePolicy.canReadAsset(path: ".cutready/screenshots/../../secret"))
    }

    func testStandardImagesAreReadableAssets() {
        XCTAssertTrue(MobileWorkspacePolicy.canReadStandardImage(path: ".cutready/screenshots/hero.png"))
        XCTAssertTrue(MobileWorkspacePolicy.canReadStandardImage(path: "docs/examples/demo/.cutready/screenshots/hero.jpeg"))

        XCTAssertFalse(MobileWorkspacePolicy.canReadStandardImage(path: ".cutready/screenshots/readme.txt"))
        XCTAssertFalse(MobileWorkspacePolicy.canReadStandardImage(path: "docs/public/images/app-home.png"))
    }

    func testNarrationAssetsAreReadableOnlyFromNarrationDirectory() {
        XCTAssertTrue(MobileWorkspacePolicy.canReadNarration(path: ".cutready/narration/row-1.webm"))
        XCTAssertTrue(MobileWorkspacePolicy.canReadNarration(path: "loop-demo/.cutready/narration/row-1.webm"))

        XCTAssertFalse(MobileWorkspacePolicy.canReadNarration(path: ".cutready/screenshots/row-1.webm"))
        XCTAssertFalse(MobileWorkspacePolicy.canReadNarration(path: ".cutready/narration/../../secret.webm"))
    }
}
