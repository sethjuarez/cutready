import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

public enum CutReadyTheme {
    public static let accent = adaptiveColor(
        light: RGB(111, 99, 232),
        dark: RGB(164, 154, 250)
    )
    public static let accentDark = Color(red: 170 / 255, green: 160 / 255, blue: 255 / 255)

    public static let storyboard = adaptiveColor(
        light: RGB(15, 118, 110),
        dark: RGB(95, 209, 199)
    )
    public static let sketch = accent
    public static let note = adaptiveColor(
        light: RGB(194, 105, 17),
        dark: RGB(242, 173, 92)
    )

    public static let surface = adaptiveColor(
        light: RGB(251, 250, 248),
        dark: RGB(31, 29, 26)
    )
    public static let surfaceAlt = adaptiveColor(
        light: RGB(243, 240, 236),
        dark: RGB(42, 38, 34)
    )
    public static let surfaceInset = adaptiveColor(
        light: RGB(236, 231, 225),
        dark: RGB(52, 47, 42)
    )
    public static let border = adaptiveColor(
        light: RGB(222, 216, 207),
        dark: RGB(76, 68, 60)
    )
    public static let text = adaptiveColor(
        light: RGB(44, 41, 37),
        dark: RGB(246, 241, 234)
    )
    public static let textSecondary = adaptiveColor(
        light: RGB(112, 106, 98),
        dark: RGB(188, 178, 166)
    )
}

private struct RGB {
    let red: CGFloat
    let green: CGFloat
    let blue: CGFloat

    init(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat) {
        self.red = red / 255
        self.green = green / 255
        self.blue = blue / 255
    }
}

private func adaptiveColor(light: RGB, dark: RGB) -> Color {
    #if canImport(UIKit)
    Color(uiColor: UIColor { traits in
        let color = traits.userInterfaceStyle == .dark ? dark : light
        return UIColor(red: color.red, green: color.green, blue: color.blue, alpha: 1)
    })
    #elseif canImport(AppKit)
    Color(nsColor: NSColor(name: nil) { appearance in
        let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let color = isDark ? dark : light
        return NSColor(red: color.red, green: color.green, blue: color.blue, alpha: 1)
    })
    #else
    Color(red: light.red, green: light.green, blue: light.blue)
    #endif
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
