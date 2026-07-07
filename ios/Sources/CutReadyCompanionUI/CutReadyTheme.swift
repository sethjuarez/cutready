import SwiftUI

public enum CutReadyTheme {
    public static let accent = Color(red: 111 / 255, green: 99 / 255, blue: 232 / 255)
    public static let accentDark = Color(red: 170 / 255, green: 160 / 255, blue: 255 / 255)

    public static let storyboard = Color(red: 15 / 255, green: 118 / 255, blue: 110 / 255)
    public static let sketch = accent
    public static let note = Color(red: 194 / 255, green: 105 / 255, blue: 17 / 255)

    public static let surface = Color(red: 251 / 255, green: 250 / 255, blue: 248 / 255)
    public static let surfaceAlt = Color(red: 243 / 255, green: 240 / 255, blue: 236 / 255)
    public static let surfaceInset = Color(red: 236 / 255, green: 231 / 255, blue: 225 / 255)
    public static let border = Color(red: 222 / 255, green: 216 / 255, blue: 207 / 255)
    public static let text = Color(red: 44 / 255, green: 41 / 255, blue: 37 / 255)
    public static let textSecondary = Color(red: 112 / 255, green: 106 / 255, blue: 98 / 255)
}

public enum CutReadyIconAsset {
    public static let storyboard = "lucide-clapperboard"
    public static let sketch = "lucide-square-pen"
    public static let note = "lucide-notebook-pen"
    public static let visual = "sparkles"
    public static let history = "point.3.connected.trianglepath.dotted"
    public static let agent = "sparkles"
}

public struct CutReadyDocumentIcon: View {
    private let name: String
    private let tint: Color
    private let size: CGFloat

    public init(_ name: String, tint: Color, size: CGFloat = 24) {
        self.name = name
        self.tint = tint
        self.size = size
    }

    public var body: some View {
        Image(name, bundle: .module)
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .foregroundStyle(tint)
            .frame(width: size, height: size)
    }
}

public struct CompanionCard<Content: View>: View {
    private let content: Content

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View {
        content
            .padding(13)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(CutReadyTheme.border.opacity(0.55), lineWidth: 1)
            )
    }
}

public struct SyncBadge: View {
    private let label: String
    private let tint: Color

    public init(label: String, tint: Color = CutReadyTheme.accent) {
        self.label = label
        self.tint = tint
    }

    public var body: some View {
        Text(label)
            .font(.caption.weight(.medium))
            .foregroundStyle(tint)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(tint.opacity(0.12), in: Capsule())
    }
}
