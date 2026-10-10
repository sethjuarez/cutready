// Binds the SketchDocument @vector operations (contracts/edits.tsp) to
// CutReadyMobileCore's production decode, edit, and save code. The generated
// VectorConformanceTests.swift and VectorRunner.swift beside this file are
// emitted by `npm run generate` in contracts/; do not edit them by hand.
import Foundation

enum VectorAdapters {
  static func adapters() -> [String: VectorAdapter] {
    return [:]
  }

  static func waivers() -> [String: String] {
    return [
      "SketchDocument.roundTrip": "iOS adapter lands after the desktop adapter",
      "SketchDocument.updateRowText": "iOS adapter lands after the desktop adapter",
      "SketchDocument.reorderRows": "iOS adapter lands after the desktop adapter",
    ]
  }

  static func doubles() -> Any? { return nil }
}
