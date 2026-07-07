import Foundation

public enum AgentiveMobileAction: String, Codable, CaseIterable, Sendable {
    case suggestSketchImprovements = "suggest_sketch_improvements"
    case rewriteRowNarrative = "rewrite_row_narrative"
    case generateRehearsalScript = "generate_rehearsal_script"
    case summarizeStoryboard = "summarize_storyboard"
    case createStoryboardFromNotes = "create_storyboard_from_notes"
    case suggestActionsFromNarrative = "suggest_actions_from_narrative"
    case reviewMobileEdits = "review_mobile_edits"
    case generateRehearsalCueCards = "generate_rehearsal_cue_cards"
}

public struct AgentiveSuggestion: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var rationale: String
    public var sketchEdits: [SketchStructuredEditEnvelope]

    public init(
        id: String = UUID().uuidString,
        title: String,
        rationale: String,
        sketchEdits: [SketchStructuredEditEnvelope] = []
    ) {
        self.id = id
        self.title = title
        self.rationale = rationale
        self.sketchEdits = sketchEdits
    }
}

public struct SketchStructuredEditEnvelope: Codable, Equatable, Sendable {
    public var sketchPath: String
    public var rowIndex: Int?
    public var field: PlanningCellField?
    public var proposedValue: String

    public init(sketchPath: String, rowIndex: Int? = nil, field: PlanningCellField? = nil, proposedValue: String) {
        self.sketchPath = sketchPath
        self.rowIndex = rowIndex
        self.field = field
        self.proposedValue = proposedValue
    }
}

public protocol AgentiveMobileClient: Sendable {
    func run(action: AgentiveMobileAction, context: AgentiveMobileContext) async throws -> AgentiveSuggestion
}

public struct AgentiveMobileContext: Codable, Equatable, Sendable {
    public var storyboardPath: String?
    public var sketchPath: String?
    public var notePath: String?
    public var selectedRowIndex: Int?
    public var userInstruction: String?

    public init(
        storyboardPath: String? = nil,
        sketchPath: String? = nil,
        notePath: String? = nil,
        selectedRowIndex: Int? = nil,
        userInstruction: String? = nil
    ) {
        self.storyboardPath = storyboardPath
        self.sketchPath = sketchPath
        self.notePath = notePath
        self.selectedRowIndex = selectedRowIndex
        self.userInstruction = userInstruction
    }
}
