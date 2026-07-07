import Foundation

public enum SketchState: String, Codable, CaseIterable, Sendable {
    case draft
    case recordingEnriched = "recording_enriched"
    case refined
    case final
}

public enum PlanningCellField: String, Codable, CaseIterable, Hashable, Sendable {
    case time
    case narrative
    case demoActions = "demo_actions"
    case screenshot
    case visual
    case designPlan = "design_plan"
}

public struct DocumentMetadata: Codable, Equatable, Sendable {
    public var fields: [String: String]?

    public init(fields: [String: String]? = nil) {
        self.fields = fields
    }
}

public struct PlanningRow: Codable, Equatable, Sendable {
    public var locked: Bool?
    public var locks: [PlanningCellField: Bool]?
    public var time: String
    public var durationSeconds: UInt?
    public var narrative: String
    public var demoActions: String
    public var screenshot: String?
    public var visual: JSONValue?
    public var designPlan: String?

    public init(
        locked: Bool? = nil,
        locks: [PlanningCellField: Bool]? = nil,
        time: String,
        durationSeconds: UInt? = nil,
        narrative: String,
        demoActions: String,
        screenshot: String? = nil,
        visual: JSONValue? = nil,
        designPlan: String? = nil
    ) {
        self.locked = locked
        self.locks = locks
        self.time = time
        self.durationSeconds = durationSeconds
        self.narrative = narrative
        self.demoActions = demoActions
        self.screenshot = screenshot
        self.visual = visual
        self.designPlan = designPlan
    }

    private enum CodingKeys: String, CodingKey {
        case locked
        case locks
        case time
        case durationSeconds = "duration_seconds"
        case narrative
        case demoActions = "demo_actions"
        case screenshot
        case visual
        case designPlan = "design_plan"
    }
}

public struct Sketch: Codable, Equatable, Sendable {
    public var title: String
    public var locked: Bool?
    public var description: JSONValue
    public var rows: [PlanningRow]
    public var metadata: DocumentMetadata?
    public var state: SketchState
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        title: String,
        locked: Bool? = nil,
        description: JSONValue = .null,
        rows: [PlanningRow],
        metadata: DocumentMetadata? = nil,
        state: SketchState = .draft,
        createdAt: Date,
        updatedAt: Date
    ) {
        self.title = title
        self.locked = locked
        self.description = description
        self.rows = rows
        self.metadata = metadata
        self.state = state
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case title
        case locked
        case description
        case rows
        case metadata
        case state
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

public enum StoryboardItem: Codable, Equatable, Sendable {
    case sketchRef(path: String)
    case section(title: String, description: String?, sketches: [String])

    private enum CodingKeys: String, CodingKey {
        case type
        case path
        case title
        case description
        case sketches
    }

    private enum ItemType: String, Codable {
        case sketchRef = "sketch_ref"
        case section
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(ItemType.self, forKey: .type) {
        case .sketchRef:
            self = .sketchRef(path: try container.decode(String.self, forKey: .path))
        case .section:
            self = .section(
                title: try container.decode(String.self, forKey: .title),
                description: try container.decodeIfPresent(String.self, forKey: .description),
                sketches: try container.decode([String].self, forKey: .sketches)
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .sketchRef(let path):
            try container.encode(ItemType.sketchRef, forKey: .type)
            try container.encode(path, forKey: .path)
        case .section(let title, let description, let sketches):
            try container.encode(ItemType.section, forKey: .type)
            try container.encode(title, forKey: .title)
            try container.encodeIfPresent(description, forKey: .description)
            try container.encode(sketches, forKey: .sketches)
        }
    }
}

public struct Storyboard: Codable, Equatable, Sendable {
    public var title: String
    public var description: String
    public var locked: Bool?
    public var metadata: DocumentMetadata?
    public var items: [StoryboardItem]
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        title: String,
        description: String,
        locked: Bool? = nil,
        metadata: DocumentMetadata? = nil,
        items: [StoryboardItem],
        createdAt: Date,
        updatedAt: Date
    ) {
        self.title = title
        self.description = description
        self.locked = locked
        self.metadata = metadata
        self.items = items
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case title
        case description
        case locked
        case metadata
        case items
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

public struct FileSummary: Codable, Equatable, Identifiable, Sendable {
    public var path: String
    public var title: String
    public var contents: String?
    public var updatedAt: Date?

    public var id: String { path }

    public init(path: String, title: String, contents: String? = nil, updatedAt: Date? = nil) {
        self.path = path
        self.title = title
        self.contents = contents
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case path
        case title
        case contents
        case updatedAt = "updated_at"
    }
}
