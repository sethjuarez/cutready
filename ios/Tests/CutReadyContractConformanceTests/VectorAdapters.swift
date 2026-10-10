// Binds the SketchDocument @vector operations (contracts/edits.tsp) to
// CutReadyMobileCore's production decode, edit, and save code. The generated
// VectorConformanceTests.swift and VectorRunner.swift beside this file are
// emitted by `npm run generate` in contracts/; do not edit them by hand.
import CutReadyMobileCore
import Foundation

enum VectorAdapters {
  static func adapters() -> [String: VectorAdapter] {
    return [
      "SketchDocument.roundTrip": VectorAdapter(sync: { input, _ in
        try save(try sketch(from: input))
      }),
      "SketchDocument.updateRowText": VectorAdapter(sync: { input, _ in
        var document = try sketch(from: input)
        let update = try object(field(input, "update"), "update")
        guard let index = update["row_index"] as? Int, index >= 0 else {
          throw VectorError("update.row_index must be a row index")
        }
        let edit = SketchStructuredEdit.updateRowText(
          index: index,
          RowTextUpdate(
            time: update["time"] as? String,
            narrative: update["narrative"] as? String,
            demoActions: update["demo_actions"] as? String
          )
        )
        try apply(edit, to: &document, input)
        return try save(document)
      }),
      "SketchDocument.reorderRows": VectorAdapter(sync: { input, _ in
        var document = try sketch(from: input)
        guard let order = field(input, "order") as? [Int], order.allSatisfy({ $0 >= 0 }) else {
          throw VectorError("order must list row indices")
        }
        try apply(.reorderRows(order), to: &document, input)
        return try save(document)
      }),
    ]
  }

  static func waivers() -> [String: String] {
    return [:]
  }

  static func doubles() -> Any? { return nil }

  private static func field(_ input: Any?, _ name: String) -> Any? {
    (input as? [String: Any])?[name]
  }

  private static func object(_ value: Any?, _ name: String) throws -> [String: Any] {
    guard let object = value as? [String: Any] else {
      throw VectorError("\(name) must be an object")
    }
    return object
  }

  private static func sketch(from input: Any?) throws -> Sketch {
    let json = try object(field(input, "sketch"), "sketch")
    return try SketchDocumentCodec.decode(try JSONSerialization.data(withJSONObject: json))
  }

  private static func save(_ sketch: Sketch) throws -> Any {
    try JSONSerialization.jsonObject(with: try SketchDocumentCodec.encode(sketch))
  }

  private static func apply(_ edit: SketchStructuredEdit, to sketch: inout Sketch, _ input: Any?) throws {
    guard let text = field(input, "now") as? String,
          let now = SketchDocumentCodec.timestamp(from: text) else {
      throw VectorError("now must be an ISO 8601 timestamp")
    }
    do {
      try MobileEdits.apply(edit, to: &sketch, now: now)
    } catch let error as MobileEditError {
      throw VectorError(error.localizedDescription, payload: payload(for: error))
    }
  }

  private static func payload(for error: MobileEditError) -> [String: Any] {
    switch error {
    case .lockedDocument:
      return ["code": "locked_document"]
    case .lockedRow(let index):
      return ["code": "locked_row", "row_index": index]
    case .lockedCell(let index, let field):
      return ["code": "locked_cell", "row_index": index, "field": field.rawValue]
    case .rowNotFound(let index):
      return ["code": "row_not_found", "row_index": index]
    case .invalidReorder:
      return ["code": "invalid_reorder"]
    case .invalidStoryboardReorder:
      return ["code": "invalid_storyboard_reorder"]
    }
  }
}
