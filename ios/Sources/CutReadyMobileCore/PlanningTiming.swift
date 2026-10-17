import Foundation

/// `PlanningTiming` (contracts/edits.tsp): reads a planning row's `time` label
/// as whole seconds. Same grammar as the desktop's `parseDurationSeconds`; the
/// contract vectors pin both.
public enum PlanningTiming {
    public static func parseDurationSeconds(_ time: String) -> UInt? {
        let lowered = string(trim(Array(time.unicodeScalars))).lowercased()
        var scalars = Array(lowered.unicodeScalars)[...]
        if scalars.first == "~" {
            scalars = scalars.dropFirst()
        }
        let text = trim(Array(scalars))
        guard !text.isEmpty,
              let seconds = clockSeconds(text) ?? unitSeconds(text) ?? decimalSeconds(text)?.rounded(),
              seconds <= Double(UInt32.max)
        else {
            return nil
        }
        return UInt(seconds)
    }

    /// `M:SS` or `H:MM:SS`; parts after the first are `[0-5]?[0-9]`.
    private static func clockSeconds(_ text: [Unicode.Scalar]) -> Double? {
        let parts = text.split(separator: ":", omittingEmptySubsequences: false).map(Array.init)
        guard (2...3).contains(parts.count), isDigits(parts[0]) else {
            return nil
        }
        for part in parts.dropFirst() {
            switch part.count {
            case 1 where isDigit(part[0]):
                continue
            case 2 where (0x30...0x35).contains(part[0].value) && isDigit(part[1]):
                continue
            default:
                return nil
            }
        }
        let values = parts.map { number($0) }
        return parts.count == 2
            ? values[0] * 60 + values[1]
            : values[0] * 3600 + values[1] * 60 + values[2]
    }

    /// Sums every `<number><whitespace?><unit>` pair, scanning like a global regex.
    private static func unitSeconds(_ text: [Unicode.Scalar]) -> Double? {
        var total = 0.0
        var matched = false
        var start = 0
        while start < text.count {
            if let pair = unitPair(text, at: start) {
                total += pair.seconds
                matched = true
                start = pair.end
            } else {
                start += 1
            }
        }
        return matched ? total.rounded() : nil
    }

    private static func unitPair(_ text: [Unicode.Scalar], at start: Int) -> (seconds: Double, end: Int)? {
        var end = digitsEnd(text, from: start)
        guard end > start else {
            return nil
        }
        if end + 1 < text.count, text[end] == ".", isDigit(text[end + 1]) {
            end = digitsEnd(text, from: end + 1)
        }
        let amount = number(text[start..<end])
        var unitStart = end
        while unitStart < text.count, isWhitespace(text[unitStart]) {
            unitStart += 1
        }
        var unitEnd = unitStart
        while unitEnd < text.count, isWordCharacter(text[unitEnd]) {
            unitEnd += 1
        }
        let scale: Double
        switch string(text[unitStart..<unitEnd]) {
        case "h", "hr", "hrs", "hour", "hours":
            scale = 3600
        case "m", "min", "mins", "minute", "minutes":
            scale = 60
        case "s", "sec", "secs", "second", "seconds":
            scale = 1
        default:
            return nil
        }
        return (amount * scale, unitEnd)
    }

    /// `[0-9]+(\.[0-9]+)?`
    private static func decimalSeconds(_ text: [Unicode.Scalar]) -> Double? {
        let parts = text.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false).map(Array.init)
        guard isDigits(parts[0]), parts.count == 1 || isDigits(parts[1]) else {
            return nil
        }
        return number(text[...])
    }

    private static func digitsEnd(_ text: [Unicode.Scalar], from start: Int) -> Int {
        var end = start
        while end < text.count, isDigit(text[end]) {
            end += 1
        }
        return end
    }

    private static func number<C: Collection>(_ digits: C) -> Double where C.Element == Unicode.Scalar {
        Double(string(digits)) ?? .infinity
    }

    private static func string<C: Collection>(_ scalars: C) -> String where C.Element == Unicode.Scalar {
        String(String.UnicodeScalarView(scalars))
    }

    private static func isDigits(_ text: [Unicode.Scalar]) -> Bool {
        !text.isEmpty && text.allSatisfy(isDigit)
    }

    private static func isDigit(_ scalar: Unicode.Scalar) -> Bool {
        (0x30...0x39).contains(scalar.value)
    }

    /// JavaScript's `\w`.
    private static func isWordCharacter(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x30...0x39, 0x41...0x5A, 0x61...0x7A, 0x5F:
            return true
        default:
            return false
        }
    }

    /// JavaScript's `\s`, which `trim()` also strips.
    private static func isWhitespace(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            return true
        default:
            return false
        }
    }

    private static func trim(_ text: [Unicode.Scalar]) -> [Unicode.Scalar] {
        Array(text.drop(while: isWhitespace).reversed().drop(while: isWhitespace).reversed())
    }
}
