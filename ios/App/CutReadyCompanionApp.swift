import CutReadyCompanionUI
import CutReadyMobileCore
import SwiftUI

@main
struct CutReadyCompanionApp: App {
    private let diagnosticsSessionId = ProcessInfo.processInfo.globallyUniqueString

    var body: some Scene {
        WindowGroup {
            CompanionRootView()
                .task {
                    await recordLaunch()
                }
        }
    }

    private func recordLaunch() async {
        do {
            let directory = try diagnosticsDirectory()
            let diagnostics = CutReadyMobileDiagnostics(
                sessionId: diagnosticsSessionId,
                diagnosticsDirectory: directory
            )
            try await diagnostics.record(
                .appLaunch,
                attributes: [
                    "platform": "ios",
                    "surface": "companion",
                    "diagnostics.directory": .string(directory.path)
                ]
            )
        } catch {
            assertionFailure("Failed to record launch diagnostics: \(error.localizedDescription)")
        }
    }

    private func diagnosticsDirectory() throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let directory = base.appendingPathComponent("AuditaurAppleBatches", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }
}
