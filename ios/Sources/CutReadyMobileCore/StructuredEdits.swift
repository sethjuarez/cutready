import Foundation

public enum MobileEditError: Error, Equatable, LocalizedError, Sendable {
    case lockedDocument
    case lockedRow(index: Int)
    case lockedCell(index: Int, field: PlanningCellField)
    case rowNotFound(index: Int)
    case invalidReorder(indices: [Int])
    case invalidStoryboardReorder(paths: [String])

    public var errorDescription: String? {
        switch self {
        case .lockedDocument:
            return "This document is locked."
        case .lockedRow(let index):
            return "Row \(index + 1) is locked."
        case .lockedCell(let index, let field):
            return "The \(field.rawValue) cell in row \(index + 1) is locked."
        case .rowNotFound(let index):
            return "Row \(index + 1) was not found."
        case .invalidReorder:
            return "The row order does not match the sketch rows."
        case .invalidStoryboardReorder:
            return "The storyboard order does not match the storyboard sketches."
        }
    }
}

public struct RowTextUpdate: Equatable, Sendable {
    public var time: String?
    public var narrative: String?
    public var demoActions: String?

    public init(time: String? = nil, narrative: String? = nil, demoActions: String? = nil) {
        self.time = time
        self.narrative = narrative
        self.demoActions = demoActions
    }
}

public enum SketchStructuredEdit: Equatable, Sendable {
    case updateTitle(String)
    case updateDescription(JSONValue)
    case updateRowText(index: Int, RowTextUpdate)
    case reorderRows([Int])
}

public enum StoryboardStructuredEdit: Equatable, Sendable {
    case updateTitle(String)
    case updateDescription(String)
    case reorderSketchReferences([String])
}

public enum MobileEdits {
    public static func apply(_ edit: SketchStructuredEdit, to sketch: inout Sketch, now: Date = Date()) throws {
        try ensureEditable(sketch)

        switch edit {
        case .updateTitle(let title):
            sketch.title = title
        case .updateDescription(let description):
            sketch.description = description
        case .updateRowText(let index, let update):
            guard sketch.rows.indices.contains(index) else {
                throw MobileEditError.rowNotFound(index: index)
            }
            try ensureEditable(sketch.rows[index], index: index)
            if let time = update.time {
                try ensureCellEditable(sketch.rows[index], index: index, field: .time)
                sketch.rows[index].time = time
            }
            if let narrative = update.narrative {
                try ensureCellEditable(sketch.rows[index], index: index, field: .narrative)
                sketch.rows[index].narrative = narrative
            }
            if let demoActions = update.demoActions {
                try ensureCellEditable(sketch.rows[index], index: index, field: .demoActions)
                sketch.rows[index].demoActions = demoActions
            }
        case .reorderRows(let indices):
            sketch.rows = try reorderedRows(sketch.rows, by: indices)
        }

        sketch.updatedAt = now
    }

    public static func apply(_ edit: StoryboardStructuredEdit, to storyboard: inout Storyboard, now: Date = Date()) throws {
        if storyboard.locked == true {
            throw MobileEditError.lockedDocument
        }

        switch edit {
        case .updateTitle(let title):
            storyboard.title = title
        case .updateDescription(let description):
            storyboard.description = description
        case .reorderSketchReferences(let paths):
            let sketchRefs = storyboard.items.compactMap { item -> String? in
                if case .sketchRef(let path) = item {
                    return path
                }
                return nil
            }
            guard Set(sketchRefs) == Set(paths), sketchRefs.count == paths.count else {
                throw MobileEditError.invalidStoryboardReorder(paths: paths)
            }
            storyboard.items = paths.map { .sketchRef(path: $0) }
        }

        storyboard.updatedAt = now
    }

    private static func ensureEditable(_ sketch: Sketch) throws {
        if sketch.locked == true {
            throw MobileEditError.lockedDocument
        }
    }

    private static func ensureEditable(_ row: PlanningRow, index: Int) throws {
        if row.locked == true {
            throw MobileEditError.lockedRow(index: index)
        }
    }

    private static func ensureCellEditable(_ row: PlanningRow, index: Int, field: PlanningCellField) throws {
        if row.locks?[field] == true {
            throw MobileEditError.lockedCell(index: index, field: field)
        }
    }

    private static func reorderedRows(_ rows: [PlanningRow], by indices: [Int]) throws -> [PlanningRow] {
        guard indices.count == rows.count, Set(indices) == Set(rows.indices) else {
            throw MobileEditError.invalidReorder(indices: indices)
        }

        return indices.map { rows[$0] }
    }
}
