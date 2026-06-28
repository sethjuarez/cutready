import { useAiApplyGateStore } from "../stores/aiApplyGateStore";
import { useSettings } from "../hooks/useSettings";
import { DecisionDialog } from "./DecisionDialog";

export function AiApplyGateDialog() {
  const request = useAiApplyGateStore((state) => state.request);
  const resolve = useAiApplyGateStore((state) => state.resolve);
  const { updateSetting } = useSettings();

  return (
    <DecisionDialog
      open={!!request}
      icon="ai"
      title="Allow AI to apply changes?"
      message={(
        <>
          <span className="font-medium text-[rgb(var(--color-text))]">{request?.label ?? "This AI action"}</span>{" "}
          can write to sketches, notes, storyboards, or visuals. CutReady will keep the changes visible in the Changes panel so you can snapshot or discard them.
        </>
      )}
      actions={[
        { id: "cancel", label: "Cancel", onSelect: () => resolve("cancel") },
        { id: "once", label: "Apply once", variant: "primary", onSelect: () => resolve("once") },
        {
          id: "always",
          label: "Auto-apply from now on",
          onSelect: async () => {
            await updateSetting("aiApplyMode", "auto");
            resolve("always");
          },
        },
      ]}
      onClose={() => resolve("cancel")}
    />
  );
}

