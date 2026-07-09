import Foundation

public enum PlayerTimelineKind: String, Equatable, Sendable {
    case sketch
    case storyboard
}

public struct PlayerTimeline: Equatable, Sendable {
    public var title: String
    public var kind: PlayerTimelineKind
    public var beats: [PlayerTimelineBeat]

    public var totalDuration: TimeInterval {
        beats.reduce(0) { $0 + $1.duration }
    }

    public var usesNarrationTiming: Bool {
        beats.contains { $0.timingSource == .narration }
    }

    public init(title: String, kind: PlayerTimelineKind, beats: [PlayerTimelineBeat]) {
        self.title = title
        self.kind = kind
        self.beats = beats
    }

    public static func sketch(path: String, sketch: Sketch) -> PlayerTimeline {
        let descriptionText = sketch.description.playerPlainText
        return PlayerTimeline(
            title: sketch.title,
            kind: .sketch,
            beats: sketch.rows.enumerated().compactMap { index, row in
                PlayerTimelineBeat(
                    sequence: index,
                    sketchPath: path,
                    sketchTitle: sketch.title,
                    sectionTitle: nil,
                    sketchDescription: index == 0 ? descriptionText : "",
                    rowIndex: index,
                    row: row
                )
            }
        )
    }

    public static func storyboard(
        title: String,
        storyboard: Storyboard,
        sketchesByPath: [String: Sketch]
    ) -> PlayerTimeline {
        var beats: [PlayerTimelineBeat] = []

        func appendSketch(path: String, sectionTitle: String?) {
            guard let sketch = sketchesByPath[path] else {
                return
            }
            let descriptionText = sketch.description.playerPlainText

            for (rowIndex, row) in sketch.rows.enumerated() {
                guard let beat = PlayerTimelineBeat(
                    sequence: beats.count,
                    sketchPath: path,
                    sketchTitle: sketch.title,
                    sectionTitle: sectionTitle,
                    sketchDescription: rowIndex == 0 ? descriptionText : "",
                    rowIndex: rowIndex,
                    row: row
                ) else {
                    continue
                }
                beats.append(beat)
            }
        }

        for item in storyboard.items {
            switch item {
            case .sketchRef(let path):
                appendSketch(path: path, sectionTitle: nil)
            case .section(let title, _, let sketches):
                for path in sketches {
                    appendSketch(path: path, sectionTitle: title)
                }
            }
        }

        return PlayerTimeline(title: title, kind: .storyboard, beats: beats)
    }
}

public struct PlayerTimelineBeat: Identifiable, Equatable, Sendable {
    public enum TimingSource: String, Equatable, Sendable {
        case narration
        case rowDuration
        case estimated
    }

    public var id: String
    public var sequence: Int
    public var sketchPath: String
    public var sketchTitle: String
    public var sectionTitle: String?
    public var sketchDescription: String
    public var rowIndex: Int
    public var narrationText: String
    public var stageDirectionText: String
    public var actionsText: String
    public var screenshotPath: String?
    public var duration: TimeInterval
    public var timingSource: TimingSource

    public init?(
        sequence: Int,
        sketchPath: String,
        sketchTitle: String,
        sectionTitle: String?,
        sketchDescription: String,
        rowIndex: Int,
        row: PlanningRow
    ) {
        let narrationText = Self.preferredNarrationText(for: row)
        let actionsText = row.demoActions.trimmingCharacters(in: .whitespacesAndNewlines)
        let stageDirectionText = Self.stageDirectionText(for: row, narrationText: narrationText, actionsText: actionsText)
        let sketchDescription = sketchDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        let screenshotPath = row.screenshot?.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !narrationText.isEmpty || !sketchDescription.isEmpty || !stageDirectionText.isEmpty || !actionsText.isEmpty || !(screenshotPath?.isEmpty ?? true) else {
            return nil
        }

        self.id = "\(sequence)-\(sketchPath)#\(rowIndex)"
        self.sequence = sequence
        self.sketchPath = sketchPath
        self.sketchTitle = sketchTitle
        self.sectionTitle = sectionTitle
        self.sketchDescription = sketchDescription
        self.rowIndex = rowIndex
        self.narrationText = narrationText.isEmpty ? actionsText : narrationText
        self.stageDirectionText = stageDirectionText
        self.actionsText = actionsText
        self.screenshotPath = screenshotPath?.isEmpty == false ? screenshotPath : nil

        let timing = Self.durationAndSource(for: row, narrationText: self.narrationText)
        self.duration = timing.duration
        self.timingSource = timing.source
    }

    private static func preferredNarrationText(for row: PlanningRow) -> String {
        let narrative = row.narrative.trimmingCharacters(in: .whitespacesAndNewlines)
        if
            narrative.isEmpty,
            let sourceText = row.narration?.sourceText?.trimmingCharacters(in: .whitespacesAndNewlines),
            !sourceText.isEmpty
        {
            return sourceText
        }
        return narrative
    }

    private static func stageDirectionText(for row: PlanningRow, narrationText: String, actionsText: String) -> String {
        var directions: [String] = []

        let narrative = row.narrative.trimmingCharacters(in: .whitespacesAndNewlines)
        if !narrative.isEmpty && normalize(narrative) != normalize(narrationText) {
            directions.append(narrative)
        }

        if !actionsText.isEmpty && normalize(actionsText) != normalize(narrationText) {
            directions.append(actionsText)
        }

        return directions.joined(separator: "\n\n")
    }

    private static func durationAndSource(for row: PlanningRow, narrationText: String) -> (duration: TimeInterval, source: TimingSource) {
        if
            let durationMs = row.narration?.durationMs,
            durationMs > 0,
            narrationTimingIsFresh(row: row, narrationText: narrationText)
        {
            return (max(1.0, Double(durationMs) / 1000.0), .narration)
        }

        if let durationSeconds = row.durationSeconds, durationSeconds > 0 {
            return (Double(durationSeconds), .rowDuration)
        }

        let wordCount = narrationText.split { $0.isWhitespace || $0.isNewline }.count
        return (max(4.0, Double(wordCount) / 2.35), .estimated)
    }

    private static func narrationTimingIsFresh(row: PlanningRow, narrationText: String) -> Bool {
        guard let sourceText = row.narration?.sourceText?.trimmingCharacters(in: .whitespacesAndNewlines), !sourceText.isEmpty else {
            return true
        }
        let narrative = row.narrative.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !narrative.isEmpty else {
            return normalize(sourceText) == normalize(narrationText)
        }
        return normalize(sourceText) == normalize(narrative)
    }

    private static func normalize(_ value: String) -> String {
        value
            .split { $0.isWhitespace || $0.isNewline }
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

private extension JSONValue {
    var playerPlainText: String {
        switch self {
        case .string(let value):
            return value.trimmingCharacters(in: .whitespacesAndNewlines)
        case .object(let object):
            return object
                .compactMap { key, value -> String? in
                    let text = value.playerPlainText
                    return text.isEmpty ? nil : "\(key): \(text)"
                }
                .sorted()
                .joined(separator: "\n")
        case .array(let values):
            return values
                .map(\.playerPlainText)
                .filter { !$0.isEmpty }
                .joined(separator: "\n")
        case .number(let value):
            return String(value)
        case .bool(let value):
            return value ? "true" : "false"
        case .null:
            return ""
        }
    }
}
