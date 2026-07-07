// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "CutReadyCompanion",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "CutReadyMobileCore",
            targets: ["CutReadyMobileCore"]
        ),
        .library(
            name: "CutReadyCompanionUI",
            targets: ["CutReadyCompanionUI"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/gonzalezreal/swift-markdown-ui", from: "2.4.1"),
        .package(path: "/Users/sethjuarez/projects/copilot-worktrees/auditaur/sethjuarez-solid-train")
    ],
    targets: [
        .target(
            name: "CutReadyMobileCore",
            dependencies: [
                .product(name: "AuditaurAppleCore", package: "sethjuarez-solid-train"),
                .target(name: "DraftlineMobileC", condition: .when(platforms: [.iOS])),
                .target(name: "DraftlineMobile", condition: .when(platforms: [.iOS]))
            ]
        ),
        .target(
            name: "CutReadyCompanionUI",
            dependencies: [
                "CutReadyMobileCore",
                .product(name: "MarkdownUI", package: "swift-markdown-ui")
            ],
            resources: [
                .process("Resources")
            ]
        ),
        .testTarget(
            name: "CutReadyMobileCoreTests",
            dependencies: ["CutReadyMobileCore"]
        ),
        .target(
            name: "DraftlineMobileC",
            publicHeadersPath: "include"
        ),
        .binaryTarget(
            name: "DraftlineMobile",
            url: "https://github.com/sethjuarez/draftline/releases/download/draftline-mobile-ios-v0.2.12-1/DraftlineMobile.xcframework.zip",
            checksum: "ba47b5f5a765e4302b9576efcb185d02c0510fbeed525a6dcceacefd1c95a7f3"
        )
    ]
)
