import { useAppStore } from "../stores/appStore";
import { DecisionDialog } from "./DecisionDialog";

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function samePath(a: string, b: string): boolean {
  const normalize = (p: string) => p.replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
  return normalize(a) === normalize(b);
}

/** Asks before CutReady starts managing a folder that holds other files, such as a code repository. */
export function AdoptFolderDialog() {
  const prompt = useAppStore((s) => s.adoptionPrompt);
  const resolve = useAppStore((s) => s.resolveAdoptionPrompt);
  if (!prompt) return null;

  const folder = baseName(prompt.folder);
  const suggested = baseName(prompt.suggested);
  const inRepository = prompt.repository !== null;
  const isRepositoryRoot = inRepository && samePath(prompt.repository ?? "", prompt.folder);
  const offerSuggested = !samePath(prompt.suggested, prompt.folder);

  if (prompt.movedTo) {
    return (
      <DecisionDialog
        open
        icon="warning"
        title={`This project moved to ${prompt.movedTo}/`}
        message={
          <div className="space-y-2">
            <p>
              A commit moved this project's sketches, storyboards, and notes from "{folder}" into "{prompt.movedTo}". Its
              history moves with it.
            </p>
            <p>{`Open "${prompt.movedTo}", or keep using "${folder}" as its own project.`}</p>
          </div>
        }
        actions={[
          { id: "cancel", label: "Cancel", variant: "secondary", onSelect: () => resolve("cancel") },
          { id: "adopt", label: `Keep ${folder}`, variant: "secondary", onSelect: () => resolve("adopt") },
          { id: "create", label: `Open ${prompt.movedTo}/`, variant: "primary", onSelect: () => resolve("create") },
        ]}
        onClose={() => void resolve("cancel")}
      />
    );
  }
  return (
    <DecisionDialog
      open
      icon="warning"
      title={`"${folder}" isn't a CutReady project`}
      message={
        <div className="space-y-2">
          <p>
            {isRepositoryRoot
              ? "This folder is a code repository. CutReady works best in its own folder inside the repository, so your code and your demo stay separate."
              : inRepository
                ? "This folder is part of a code repository and has other files in it. CutReady works best in its own folder at the top of the repository."
                : "This folder has other files in it. CutReady would start tracking it as a project."}
          </p>
          <p>
            {!offerSuggested
              ? `Use "${folder}" as it is? CutReady will track the files in it.`
              : prompt.suggestedExists
                ? `Open the existing "${suggested}" folder, or use "${folder}" as it is.`
                : `Create a "${suggested}" folder for the demo, or use "${folder}" as it is.`}
          </p>
        </div>
      }
      actions={[
        {
          id: "cancel",
          label: "Cancel",
          variant: "secondary",
          onSelect: () => resolve("cancel"),
        },
        {
          id: "adopt",
          label: `Use ${folder} as is`,
          variant: offerSuggested ? "secondary" : "primary",
          onSelect: () => resolve("adopt"),
        },
        ...(offerSuggested
          ? [
              {
                id: "create",
                label: prompt.suggestedExists ? `Open ${suggested}/` : `Create ${suggested}/`,
                variant: "primary" as const,
                onSelect: () => resolve("create"),
              },
            ]
          : []),
      ]}
      onClose={() => void resolve("cancel")}
    />
  );
}
