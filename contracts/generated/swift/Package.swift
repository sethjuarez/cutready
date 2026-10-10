// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "CutReadyContracts",
  platforms: [.macOS(.v12), .iOS(.v15)],
  products: [.library(name: "CutReadyContracts", targets: ["CutReadyContracts"])],
  dependencies: [
    .package(url: "https://github.com/jpsim/Yams.git", from: "5.1.3")
  ],
  targets: [
    .target(name: "CutReadyContracts", dependencies: [.product(name: "Yams", package: "Yams")], path: "Sources/CutReadyContracts"),
    .testTarget(name: "CutReadyContractsTests", dependencies: ["CutReadyContracts"], path: "Tests/CutReadyContractsTests")
  ]
)
