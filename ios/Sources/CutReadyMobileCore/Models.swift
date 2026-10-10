import Foundation

/// Dynamic coding key used to capture document fields the mobile models do not
/// model explicitly, so companion edits stay lossless for desktop-authored data
/// (issue #272). Also see `UnknownFieldCodec`.
struct AnyCodingKey: CodingKey {
    let stringValue: String
    var intValue: Int? { nil }
    init(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
}

/// Lossless document adapter: captures any JSON keys not covered by a model's
/// explicit `CodingKeys` on decode and re-emits them on encode. This preserves
/// current desktop-only fields (e.g. `motion_points`, `typing_spots`,
/// `motion_plan`, `narration_plan`) AND unknown future fields through a mobile
/// structured edit, without the mobile models needing to understand them.
///
/// Decision (issue #272): unknown top-level fields on `PlanningRow` and `Sketch`
/// are preserved verbatim. Boundaries of this guarantee, by design:
/// - Preservation is not recursive: unknown keys nested inside a *modeled*
///   object (e.g. `RowNarration`) are not retained. New desktop data that must
///   survive mobile edits should be added as a top-level row/document field, or
///   the containing model must adopt this same passthrough.
/// - Numbers round-trip through `JSONValue.number(Double)`, so integers beyond
///   2^53 are not bit-preserved. All current authoring fields are well within
///   that range.
enum UnknownFieldCodec {
    static func decode(from decoder: Decoder, knownKeys: Set<String>) throws -> [String: JSONValue] {
        let container = try decoder.container(keyedBy: AnyCodingKey.self)
        var extras: [String: JSONValue] = [:]
        for key in container.allKeys where !knownKeys.contains(key.stringValue) {
            extras[key.stringValue] = try container.decode(JSONValue.self, forKey: key)
        }
        return extras
    }

    static func encode(_ fields: [String: JSONValue], to encoder: Encoder, knownKeys: Set<String>) throws {
        guard !fields.isEmpty else { return }
        var container = encoder.container(keyedBy: AnyCodingKey.self)
        for (key, value) in fields where !knownKeys.contains(key) {
            try container.encode(value, forKey: AnyCodingKey(stringValue: key))
        }
    }
}

enum CutReadyDocumentDateCodec {
    /// Formats like the desktop's chrono `DateTime<Utc>` serializer: whole
    /// seconds print without a fraction, otherwise 3 or 6 digits as needed.
    static func string(from date: Date) -> String {
        var seconds = date.timeIntervalSince1970.rounded(.down)
        var micros = Int(((date.timeIntervalSince1970 - seconds) * 1_000_000).rounded())
        if micros >= 1_000_000 {
            seconds += 1
            micros -= 1_000_000
        }
        let base = String(iso8601.string(from: Date(timeIntervalSince1970: seconds)).dropLast())
        return base + fraction(nanos: micros * 1_000) + "Z"
    }

    /// Rewrites an RFC 3339 timestamp the way desktop chrono saves it: UTC with
    /// `Z`, keeping up to nine fraction digits. Returns nil for anything else.
    static func canonical(_ raw: String) -> String? {
        let pattern = #"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let match = regex.firstMatch(in: raw, range: NSRange(raw.startIndex..., in: raw)) else {
            return nil
        }
        func group(_ index: Int) -> String? {
            Range(match.range(at: index), in: raw).map { String(raw[$0]) }
        }
        guard let base = group(1), let zone = group(3),
              let seconds = iso8601.date(from: base + (zone.uppercased() == "Z" ? "Z" : zone)) else {
            return nil
        }
        let digits = group(2) ?? ""
        let nanos = Int(digits.padding(toLength: 9, withPad: "0", startingAt: 0)) ?? 0
        return String(iso8601.string(from: seconds).dropLast()) + fraction(nanos: nanos) + "Z"
    }

    /// Parses an RFC 3339 timestamp, keeping microsecond precision.
    static func date(from raw: String) -> Date? {
        guard let canonical = canonical(raw) else { return nil }
        let wholeSeconds = String(canonical.prefix(19)) + "Z"
        guard let seconds = iso8601.date(from: wholeSeconds) else { return nil }
        let digits = canonical.count > 20 ? String(canonical.dropFirst(20).dropLast()) : ""
        let micros = Double(digits.padding(toLength: 6, withPad: "0", startingAt: 0).prefix(6)) ?? 0
        return seconds.addingTimeInterval(micros / 1_000_000)
    }

    /// Prefers the decoded text while the date is unchanged so precision beyond
    /// what `Date` parsing keeps survives a mobile save.
    static func string(from date: Date, raw: DocumentTimestamp) -> String {
        if raw.date == date, let text = raw.text, let canonical = canonical(text) {
            return canonical
        }
        return string(from: date)
    }

    private static func fraction(nanos: Int) -> String {
        if nanos == 0 { return "" }
        if nanos % 1_000_000 == 0 { return String(format: ".%03d", nanos / 1_000_000) }
        if nanos % 1_000 == 0 { return String(format: ".%06d", nanos / 1_000) }
        return String(format: ".%09d", nanos)
    }

    static func raw<Key: CodingKey>(from container: KeyedDecodingContainer<Key>, forKey key: Key, date: Date?) -> DocumentTimestamp {
        DocumentTimestamp(text: try? container.decodeIfPresent(String.self, forKey: key), date: date)
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
        if let date = Self.date(from: value) ?? iso8601WithFractions.date(from: value) ?? iso8601.date(from: value) {
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

/// The timestamp text a document was decoded with. Bookkeeping only, so it
/// never affects equality.
struct DocumentTimestamp: Equatable, Sendable {
    var text: String?
    var date: Date?

    static func == (lhs: DocumentTimestamp, rhs: DocumentTimestamp) -> Bool { true }
}

/// Canonicalizes the desktop-typed row fields mobile keeps as passthrough JSON.
/// Every optional and collection inside them is omitted when null or empty on
/// desktop, so the same rule applies here (contracts/README.md).
enum DesktopRowFields {
    static let keys: Set<String> = ["motion_points", "typing_spots", "motion_plan", "narration_plan"]

    static func canonicalize(_ fields: [String: JSONValue]) -> [String: JSONValue] {
        var result = fields
        for key in keys {
            guard let value = fields[key] else { continue }
            result[key] = isEmpty(value) ? nil : prune(value)
        }
        if case .object(var plan)? = result["narration_plan"],
           case .string(let generatedAt)? = plan["generated_at"],
           let canonical = CutReadyDocumentDateCodec.canonical(generatedAt) {
            plan["generated_at"] = .string(canonical)
            result["narration_plan"] = .object(plan)
        }
        return result
    }

    private static func prune(_ value: JSONValue) -> JSONValue {
        switch value {
        case .object(let object):
            return .object(object.compactMapValues { member in
                let pruned = prune(member)
                return isEmpty(pruned) ? nil : pruned
            })
        case .array(let items):
            return .array(items.map(prune))
        default:
            return value
        }
    }

    private static func isEmpty(_ value: JSONValue) -> Bool {
        switch value {
        case .null: return true
        case .array(let items): return items.isEmpty
        case .object(let object): return object.isEmpty
        default: return false
        }
    }
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

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(path, forKey: .path)
        try container.encodeIfPresent(sourceText, forKey: .sourceText)
        try container.encodeIfPresent(sourceTextHash, forKey: .sourceTextHash)
        try container.encodeIfPresent(mimeType, forKey: .mimeType)
        try container.encode(durationMs, forKey: .durationMs)
        try container.encodeIfPresent(leadingSilenceMs, forKey: .leadingSilenceMs)
        try container.encodeIfPresent(trailingSilenceMs, forKey: .trailingSilenceMs)
        try container.encodeIfPresent(silenceThresholdDb, forKey: .silenceThresholdDb)
        try container.encodeIfPresent(byteSize, forKey: .byteSize)
        try container.encodeIfPresent(recordedAt.map { CutReadyDocumentDateCodec.canonical($0) ?? $0 }, forKey: .recordedAt)
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
    /// Desktop-authored fields the mobile model does not model explicitly
    /// (e.g. `motion_points`, `typing_spots`, `motion_plan`, `narration_plan`)
    /// plus any unknown future fields, preserved verbatim across mobile edits.
    public var unknownFields: [String: JSONValue]

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
        narration: RowNarration? = nil,
        unknownFields: [String: JSONValue] = [:]
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
        self.unknownFields = unknownFields
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
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

    private static let knownKeys = Set(CodingKeys.allCases.map(\.rawValue))

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        locked = try container.decodeIfPresent(Bool.self, forKey: .locked)
        locks = try Self.decodeLocks(from: container)
        time = try container.decodeIfPresent(String.self, forKey: .time) ?? ""
        durationSeconds = try container.decodeIfPresent(UInt.self, forKey: .durationSeconds)
        narrative = try container.decodeIfPresent(String.self, forKey: .narrative) ?? ""
        demoActions = try container.decodeIfPresent(String.self, forKey: .demoActions) ?? ""
        screenshot = try container.decodeIfPresent(String.self, forKey: .screenshot)
        visual = try container.decodeIfPresent(JSONValue.self, forKey: .visual).flatMap { $0 == .null ? nil : $0 }
        designPlan = try container.decodeIfPresent(String.self, forKey: .designPlan)
        narration = try container.decodeIfPresent(RowNarration.self, forKey: .narration)
        unknownFields = DesktopRowFields.canonicalize(
            try UnknownFieldCodec.decode(from: decoder, knownKeys: Self.knownKeys)
        )
    }

    /// Whether the whole row is locked.
    public var isLocked: Bool { locked == true }

    /// Whether a cell is locked, ignoring the row lock.
    public func isCellLocked(_ field: PlanningCellField) -> Bool { locks?[field] == true }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(isLocked, forKey: .locked)
        var lockContainer = container.nestedContainer(keyedBy: AnyCodingKey.self, forKey: .locks)
        for field in PlanningCellField.allCases {
            try lockContainer.encode(isCellLocked(field), forKey: AnyCodingKey(stringValue: field.rawValue))
        }
        try container.encode(time, forKey: .time)
        try container.encodeIfPresent(durationSeconds, forKey: .durationSeconds)
        try container.encode(narrative, forKey: .narrative)
        try container.encode(demoActions, forKey: .demoActions)
        try container.encode(screenshot, forKey: .screenshot)
        if let visual, visual != .null {
            try container.encode(visual, forKey: .visual)
        }
        try container.encodeIfPresent(designPlan, forKey: .designPlan)
        try container.encodeIfPresent(narration, forKey: .narration)
        try UnknownFieldCodec.encode(DesktopRowFields.canonicalize(unknownFields), to: encoder, knownKeys: Self.knownKeys)
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
    /// Top-level sketch fields the mobile model does not model explicitly, plus
    /// any unknown future fields, preserved verbatim across mobile edits (#272).
    public var unknownFields: [String: JSONValue]
    var decodedCreatedAt = DocumentTimestamp()
    var decodedUpdatedAt = DocumentTimestamp()

    public init(
        title: String,
        locked: Bool? = nil,
        description: JSONValue = .null,
        rows: [PlanningRow],
        metadata: DocumentMetadata? = nil,
        state: SketchState = .draft,
        createdAt: Date,
        updatedAt: Date,
        unknownFields: [String: JSONValue] = [:]
    ) {
        self.title = title
        self.locked = locked
        self.description = description
        self.rows = rows
        self.metadata = metadata
        self.state = state
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.unknownFields = unknownFields
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case title
        case locked
        case description
        case rows
        case metadata
        case state
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    private static let knownKeys = Set(CodingKeys.allCases.map(\.rawValue))

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
        unknownFields = try UnknownFieldCodec.decode(from: decoder, knownKeys: Self.knownKeys)
        decodedCreatedAt = CutReadyDocumentDateCodec.raw(from: container, forKey: .createdAt, date: createdAt)
        decodedUpdatedAt = CutReadyDocumentDateCodec.raw(from: container, forKey: .updatedAt, date: updatedAt)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(title, forKey: .title)
        try container.encode(locked == true, forKey: .locked)
        try container.encode(description, forKey: .description)
        try container.encode(rows, forKey: .rows)
        if let fields = metadata?.fields, !fields.isEmpty {
            try container.encode(DocumentMetadata(fields: fields), forKey: .metadata)
        }
        try container.encode(state, forKey: .state)
        try container.encode(CutReadyDocumentDateCodec.string(from: createdAt, raw: decodedCreatedAt), forKey: .createdAt)
        try container.encode(CutReadyDocumentDateCodec.string(from: updatedAt, raw: decodedUpdatedAt), forKey: .updatedAt)
        try UnknownFieldCodec.encode(unknownFields, to: encoder, knownKeys: Self.knownKeys)
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

/// Production `.sk` decode/save, shared by the workspace client and the
/// contract conformance tests.
public enum SketchDocumentCodec {
    public static func decode(_ data: Data) throws -> Sketch {
        try JSONDecoder().decode(Sketch.self, from: data)
    }

    /// Parses an RFC 3339 edit time with microsecond precision.
    public static func timestamp(from text: String) -> Date? {
        CutReadyDocumentDateCodec.date(from: text)
    }

    public static func encode(_ sketch: Sketch) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes]
        return try encoder.encode(sketch)
    }
}
