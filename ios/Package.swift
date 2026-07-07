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
                .product(name: "AuditaurAppleCore", package: "sethjuarez-solid-train")
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
        )
    ]
)
