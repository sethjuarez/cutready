import Foundation

enum CutReadyDocumentDateCodec {
    static func string(from date: Date) -> String {
        iso8601WithFractions.string(from: date)
    }

    static func decode<Key: CodingKey>(
        from container: KeyedDecodingContainer<Key>,
        forKey key: Key
    ) throws -> Date? {
        if let value = try? container.decodeIfPresent(String.self, forKey: key) {
            return try date(from: value, key: key, container: container)
        }

        if let value = try? container.decodeIfPresent(Double.self, forKey: key) {
            return date(fromLegacyNumericValue: value)
        }

        if (try? container.decodeNil(forKey: key)) == true {
            return nil
        }

        guard container.contains(key) else {
            return nil
        }

        _ = try container.decode(String.self, forKey: key)
        return nil
    }

    private static func date<Key: CodingKey>(
        from value: String,
        key: Key,
        container: KeyedDecodingContainer<Key>
    ) throws -> Date {
        if let date = iso8601WithFractions.date(from: value) ?? iso8601.date(from: value) {
            return date
        }

        throw DecodingError.dataCorruptedError(
            forKey: key,
            in: container,
            debugDescription: "Invalid ISO 8601 date: \(value)"
        )
    }

    private static func date(fromLegacyNumericValue value: Double) -> Date {
        // Swift JSONEncoder's default Date format is seconds since 2001; Unix timestamps are much larger for current documents.
        value > 1_000_000_000
            ? Date(timeIntervalSince1970: value)
            : Date(timeIntervalSinceReferenceDate: value)
    }

    private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static let iso8601WithFractions: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

public enum SketchState: String, Codable, CaseIterable, Sendable {
    case draft
    case recordingEnriched = "recording_enriched"
    case refined
    case final

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let rawValue = try container.decode(String.self)
        self = rawValue == "sketch" ? .draft : SketchState(rawValue: rawValue) ?? .draft
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

public enum PlanningCellField: String, Codable, CaseIterable, Hashable, Sendable {
    case time
    case narrative
    case demoActions = "demo_actions"
    case screenshot
    case visual
    case designPlan = "design_plan"
    case narration
}

public struct RowNarration: Codable, Equatable, Sendable {
    public var path: String
    public var sourceText: String?
    public var sourceTextHash: String?
    public var mimeType: String?
    public var durationMs: UInt?
    public var leadingSilenceMs: UInt?
    public var trailingSilenceMs: UInt?
    public var silenceThresholdDb: Double?
    public var byteSize: UInt?
    public var recordedAt: String?

    public init(
        path: String,
        sourceText: String? = nil,
        sourceTextHash: String? = nil,
        mimeType: String? = nil,
        durationMs: UInt? = nil,
        leadingSilenceMs: UInt? = nil,
        trailingSilenceMs: UInt? = nil,
        silenceThresholdDb: Double? = nil,
        byteSize: UInt? = nil,
        recordedAt: String? = nil
    ) {
        self.path = path
        self.sourceText = sourceText
        self.sourceTextHash = sourceTextHash
        self.mimeType = mimeType
        self.durationMs = durationMs
        self.leadingSilenceMs = leadingSilenceMs
        self.trailingSilenceMs = trailingSilenceMs
        self.silenceThresholdDb = silenceThresholdDb
        self.byteSize = byteSize
        self.recordedAt = recordedAt
    }

    private enum CodingKeys: String, CodingKey {
        case path
        case sourceText = "source_text"
        case sourceTextHash = "source_text_hash"
        case mimeType = "mime_type"
        case durationMs = "duration_ms"
        case leadingSilenceMs = "leading_silence_ms"
        case trailingSilenceMs = "trailing_silence_ms"
        case silenceThresholdDb = "silence_threshold_db"
        case byteSize = "byte_size"
        case recordedAt = "recorded_at"
    }
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
    public var narration: RowNarration?

    public init(
        locked: Bool? = nil,
        locks: [PlanningCellField: Bool]? = nil,
        time: String,
        durationSeconds: UInt? = nil,
        narrative: String,
        demoActions: String,
        screenshot: String? = nil,
        visual: JSONValue? = nil,
        designPlan: String? = nil,
        narration: RowNarration? = nil
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
        self.narration = narration
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
        case narration
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        locked = try container.decodeIfPresent(Bool.self, forKey: .locked)
        locks = try Self.decodeLocks(from: container)
        time = try container.decodeIfPresent(String.self, forKey: .time) ?? ""
        durationSeconds = try container.decodeIfPresent(UInt.self, forKey: .durationSeconds)
        narrative = try container.decodeIfPresent(String.self, forKey: .narrative) ?? ""
        demoActions = try container.decodeIfPresent(String.self, forKey: .demoActions) ?? ""
        screenshot = try container.decodeIfPresent(String.self, forKey: .screenshot)
        visual = try container.decodeIfPresent(JSONValue.self, forKey: .visual)
        designPlan = try container.decodeIfPresent(String.self, forKey: .designPlan)
        narration = try container.decodeIfPresent(RowNarration.self, forKey: .narration)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(locked, forKey: .locked)
        if let locks {
            let encodedLocks = Dictionary(uniqueKeysWithValues: locks.map { ($0.key.rawValue, $0.value) })
            try container.encode(encodedLocks, forKey: .locks)
        }
        try container.encode(time, forKey: .time)
        try container.encodeIfPresent(durationSeconds, forKey: .durationSeconds)
        try container.encode(narrative, forKey: .narrative)
        try container.encode(demoActions, forKey: .demoActions)
        try container.encodeIfPresent(screenshot, forKey: .screenshot)
        try container.encodeIfPresent(visual, forKey: .visual)
        try container.encodeIfPresent(designPlan, forKey: .designPlan)
        try container.encodeIfPresent(narration, forKey: .narration)
    }

    private static func decodeLocks(from container: KeyedDecodingContainer<CodingKeys>) throws -> [PlanningCellField: Bool]? {
        guard container.contains(.locks) else {
            return nil
        }

        let rawLocks = try container.decode([String: Bool].self, forKey: .locks)
        let mappedLocks = rawLocks.compactMap { key, value -> (PlanningCellField, Bool)? in
            guard let field = PlanningCellField(rawValue: key) else {
                return nil
            }
            return (field, value)
        }
        return Dictionary(uniqueKeysWithValues: mappedLocks)
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

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        title = try container.decodeIfPresent(String.self, forKey: .title) ?? "Untitled Sketch"
        locked = try container.decodeIfPresent(Bool.self, forKey: .locked)
        description = try container.decodeIfPresent(JSONValue.self, forKey: .description) ?? .null
        rows = try container.decodeIfPresent([PlanningRow].self, forKey: .rows) ?? []
        metadata = try container.decodeIfPresent(DocumentMetadata.self, forKey: .metadata)
        state = try container.decodeIfPresent(SketchState.self, forKey: .state) ?? .draft
        createdAt = try CutReadyDocumentDateCodec.decode(from: container, forKey: .createdAt) ?? Date(timeIntervalSince1970: 0)
        updatedAt = try CutReadyDocumentDateCodec.decode(from: container, forKey: .updatedAt) ?? createdAt
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(title, forKey: .title)
        try container.encodeIfPresent(locked, forKey: .locked)
        try container.encode(description, forKey: .description)
        try container.encode(rows, forKey: .rows)
        try container.encodeIfPresent(metadata, forKey: .metadata)
        try container.encode(state, forKey: .state)
        try container.encode(CutReadyDocumentDateCodec.string(from: createdAt), forKey: .createdAt)
        try container.encode(CutReadyDocumentDateCodec.string(from: updatedAt), forKey: .updatedAt)
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
        case sketch
        case sketchRef = "sketch_ref"
        case section
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(ItemType.self, forKey: .type) {
        case .sketch:
            self = .sketchRef(path: try container.decode(String.self, forKey: .path))
        case .sketchRef:
            self = .sketchRef(path: try container.decode(String.self, forKey: .path))
        case .section:
            self = .section(
                title: try container.decodeIfPresent(String.self, forKey: .title) ?? "Section",
                description: try container.decodeIfPresent(String.self, forKey: .description),
                sketches: try container.decodeIfPresent([String].self, forKey: .sketches) ?? []
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
        case sketches
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        title = try container.decodeIfPresent(String.self, forKey: .title) ?? "Untitled Storyboard"
        description = try container.decodeIfPresent(String.self, forKey: .description) ?? ""
        locked = try container.decodeIfPresent(Bool.self, forKey: .locked)
        metadata = try container.decodeIfPresent(DocumentMetadata.self, forKey: .metadata)
        if let decodedItems = try container.decodeIfPresent([StoryboardItem].self, forKey: .items) {
            items = decodedItems
        } else {
            let sketchPaths = try container.decodeIfPresent([String].self, forKey: .sketches) ?? []
            items = sketchPaths.map { .sketchRef(path: $0) }
        }
        createdAt = try CutReadyDocumentDateCodec.decode(from: container, forKey: .createdAt) ?? Date(timeIntervalSince1970: 0)
        updatedAt = try CutReadyDocumentDateCodec.decode(from: container, forKey: .updatedAt) ?? createdAt
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(title, forKey: .title)
        try container.encode(description, forKey: .description)
        try container.encodeIfPresent(locked, forKey: .locked)
        try container.encodeIfPresent(metadata, forKey: .metadata)
        try container.encode(items, forKey: .items)
        try container.encode(CutReadyDocumentDateCodec.string(from: createdAt), forKey: .createdAt)
        try container.encode(CutReadyDocumentDateCodec.string(from: updatedAt), forKey: .updatedAt)
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

public struct NoteDocumentMetadata: Codable, Equatable, Sendable {
    public var fields: [String: String]

    public init(fields: [String: String] = [:]) {
        self.fields = fields
    }
}

public struct ParsedNoteDocument: Equatable, Sendable {
    public var metadata: NoteDocumentMetadata
    public var body: String

    public init(metadata: NoteDocumentMetadata = NoteDocumentMetadata(), body: String) {
        self.metadata = metadata
        self.body = body
    }
}

public func parseNoteDocument(_ content: String) -> ParsedNoteDocument {
    guard content.hasPrefix("---\n") || content.hasPrefix("---\r\n") else {
        return ParsedNoteDocument(body: content)
    }

    let marker = content.hasPrefix("---\r\n") ? "\r\n---" : "\n---"
    guard let end = content.range(of: marker, range: content.index(content.startIndex, offsetBy: 4)..<content.endIndex) else {
        return ParsedNoteDocument(body: content)
    }

    let frontmatterStart = content.index(content.startIndex, offsetBy: content.hasPrefix("---\r\n") ? 5 : 4)
    let frontmatter = String(content[frontmatterStart..<end.lowerBound])
    var bodyStart = end.upperBound
    if content[bodyStart...].hasPrefix("\r\n") {
        bodyStart = content.index(bodyStart, offsetBy: 2)
    } else if content[bodyStart...].hasPrefix("\n") {
        bodyStart = content.index(after: bodyStart)
    }

    var fields: [String: String] = [:]
    for line in frontmatter.components(separatedBy: .newlines) {
        guard let separator = line.firstIndex(of: ":") else { continue }
        let key = line[..<separator].trimmingCharacters(in: .whitespaces)
        let value = unquoteFrontmatterValue(line[line.index(after: separator)...].trimmingCharacters(in: .whitespaces))
        if !key.isEmpty && !value.isEmpty {
            fields[key] = value
        }
    }

    return ParsedNoteDocument(metadata: NoteDocumentMetadata(fields: fields), body: String(content[bodyStart...]))
}

private func unquoteFrontmatterValue(_ value: String) -> String {
    guard value.hasPrefix("\""), let data = value.data(using: .utf8) else {
        return value
    }
    return (try? JSONDecoder().decode(String.self, from: data)) ?? value
}
