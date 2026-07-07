import CutReadyMobileCore
import Foundation

public struct CompanionProject: Identifiable, Equatable, Sendable {
    public var id: String
    public var workspaceName: String
    public var source: MobileWorkspaceSource
    public var syncStatus: MobileSyncStatus
    public var projects: [MobileProjectEntry]
    public var activeProjectPath: String
    public var allStoryboards: [FileSummary]
    public var allSketches: [FileSummary]
    public var allNotes: [FileSummary]

    public var name: String {
        activeProject?.name ?? workspaceName
    }

    public var activeProject: MobileProjectEntry? {
        projects.first { $0.path == activeProjectPath }
    }

    public var storyboards: [FileSummary] {
        documents(in: allStoryboards)
    }

    public var sketches: [FileSummary] {
        documents(in: allSketches)
    }

    public var notes: [FileSummary] {
        documents(in: allNotes)
    }

    public init(
        id: String,
        workspaceName: String,
        source: MobileWorkspaceSource,
        syncStatus: MobileSyncStatus,
        projects: [MobileProjectEntry],
        activeProjectPath: String,
        storyboards: [FileSummary],
        sketches: [FileSummary],
        notes: [FileSummary]
    ) {
        self.id = id
        self.workspaceName = workspaceName
        self.source = source
        self.syncStatus = syncStatus
        self.projects = projects
        self.activeProjectPath = activeProjectPath
        self.allStoryboards = storyboards
        self.allSketches = sketches
        self.allNotes = notes
    }

    public init(snapshot: MobileWorkspaceSnapshot) {
        self.init(
            id: snapshot.descriptor.id,
            workspaceName: snapshot.descriptor.name,
            source: snapshot.descriptor.source,
            syncStatus: MobileSyncStatus(state: .clean, message: "Synced workspace"),
            projects: snapshot.projects,
            activeProjectPath: snapshot.activeProjectPath,
            storyboards: snapshot.storyboards,
            sketches: snapshot.sketches,
            notes: snapshot.notes
        )
    }

    public func switchingProject(to projectPath: String) -> CompanionProject {
        var copy = self
        copy.activeProjectPath = projectPath
        return copy
    }

    private func documents(in summaries: [FileSummary]) -> [FileSummary] {
        let projectPath = activeProjectPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard projectPath != "." && !projectPath.isEmpty else {
            return summaries
        }

        return summaries.filter { summary in
            summary.path == projectPath || summary.path.hasPrefix("\(projectPath)/")
        }
    }
}

public enum CompanionSelection: Hashable, Sendable {
    case project(String)
    case storyboard(String)
    case sketch(String)
    case note(String)
    case rehearse(String)
}

public enum CompanionSamples {
    public static let project = CompanionProject(
        id: "sample",
        workspaceName: "cutready-demo",
        source: .github(GitHubRepositoryRef(owner: "sethjuarez", name: "cutready-demo", defaultBranch: "main")),
        syncStatus: MobileSyncStatus(state: .dirty, ahead: 1, message: "One mobile snapshot ready to push"),
        projects: [
            MobileProjectEntry(path: ".", name: "Launch Demo")
        ],
        activeProjectPath: ".",
        storyboards: [
            FileSummary(path: "launch-storyboard.sb", title: "Launch Storyboard")
        ],
        sketches: [
            FileSummary(path: "intro.sk", title: "Intro", contents: """
            {
              "title": "Intro",
              "description": "Set context for the demo.",
              "rows": [
                {
                  "time": "0:20",
                  "narrative": "Welcome the audience and name the customer pain.",
                  "demo_actions": "Open the product and show the landing state.",
                  "screenshot": "screenshots/intro.png",
                  "visual": { "kind": "callout", "title": "Opening frame" }
                }
              ],
              "state": "draft",
              "created_at": "2026-01-01T00:00:00Z",
              "updated_at": "2026-01-01T00:00:00Z"
            }
            """),
            FileSummary(path: "settings.sk", title: "Settings walkthrough"),
            FileSummary(path: "export.sk", title: "Export handoff")
        ],
        notes: [
            FileSummary(path: "planning-notes.md", title: "Planning Notes")
        ]
    )
}
