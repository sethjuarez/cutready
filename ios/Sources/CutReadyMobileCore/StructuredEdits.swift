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

/// Structured edits and their lock policy. Mirrors the desktop's
/// `engine::sketch_edits`; both are pinned by the `SketchDocument` contract
/// vectors in contracts/.
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
            var rows = sketch.rows
            if let time = update.time {
                rows[index].time = time
            }
            if let narrative = update.narrative {
                rows[index].narrative = narrative
            }
            if let demoActions = update.demoActions {
                rows[index].demoActions = demoActions
            }
            try checkRowsUpdate(existing: sketch.rows, updated: rows)
            sketch.rows = rows
        case .reorderRows(let order):
            guard order.count == sketch.rows.count, Set(order) == Set(sketch.rows.indices) else {
                throw MobileEditError.invalidReorder(indices: order)
            }
            var rows = order.map { sketch.rows[$0] }
            try checkRowsUpdate(existing: sketch.rows, updated: rows)
            applyLockedRowMetadata(existing: sketch.rows, updated: &rows)
            sketch.rows = rows
        }

        sketch.updatedAt = now
    }

    /// Checks proposed rows against the locks on the current rows, position by
    /// position. Unchanged values on locked content are allowed; the first
    /// change to a locked row, then to a locked cell in column order, is reported.
    public static func checkRowsUpdate(existing: [PlanningRow], updated: [PlanningRow]) throws {
        for (index, (old, new)) in zip(existing, updated).enumerated() {
            if old.isLocked && content(of: old) != content(of: new) {
                throw MobileEditError.lockedRow(index: index)
            }
            for field in PlanningCellField.allCases where old.isCellLocked(field) && !matches(old, new, field) {
                throw MobileEditError.lockedCell(index: index, field: field)
            }
        }
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

    /// Lock state belongs to the position, not to the row content moving through it.
    private static func applyLockedRowMetadata(existing: [PlanningRow], updated: inout [PlanningRow]) {
        for index in updated.indices where existing.indices.contains(index) {
            updated[index].locked = existing[index].locked
            updated[index].locks = existing[index].locks
        }
    }

    /// Everything a locked row protects: the row minus its lock state.
    private static func content(of row: PlanningRow) -> PlanningRow {
        var copy = row
        copy.locked = nil
        copy.locks = nil
        return copy
    }

    /// Screenshot and visual locks each guard both cells.
    private static func matches(_ old: PlanningRow, _ new: PlanningRow, _ field: PlanningCellField) -> Bool {
        switch field {
        case .time:
            return old.time == new.time
        case .narrative:
            return old.narrative == new.narrative
        case .demoActions:
            return old.demoActions == new.demoActions
        case .screenshot, .visual:
            return old.screenshot == new.screenshot && old.visual == new.visual
        case .designPlan:
            return old.designPlan == new.designPlan
        }
    }
}
