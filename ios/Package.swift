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
        .package(url: "https://github.com/gonzalezreal/swift-markdown-ui", from: "2.4.1")
    ],
    targets: [
        .target(
            name: "CutReadyMobileCore",
            dependencies: [
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
            url: "https://github.com/sethjuarez/draftline/releases/download/v0.2.14/DraftlineMobile.xcframework.zip",
            checksum: "b185eb45b1b065ad536505a87aaa4cffac6b896154f32e75fe14f8af14a47154"
        )
    ]
)
