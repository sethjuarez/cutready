/** Inline "new document" form under a tree sub-header. */
export function TreeCreateForm({
  id,
  label,
  value,
  onChange,
  onCreate,
  onCancel,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onCreate: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="cr-tform space-y-2">
      <label className="block text-2xs font-medium text-text-secondary" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onCreate();
          if (event.key === "Escape") onCancel();
        }}
        placeholder={`${label}...`}
        autoFocus
        className="w-full rounded-control border border-border bg-surface px-2 py-1.5 text-xs text-text placeholder:text-text-secondary/50 focus:outline-none focus:ring-1 focus:ring-accent/40"
      />
      <div className="flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-control px-2 py-1 text-2xs text-text-secondary transition-colors hover:text-text"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onCreate}
          disabled={!value.trim()}
          className="rounded-control bg-accent px-2 py-1 text-2xs font-medium text-accent-fg transition-opacity disabled:pointer-events-none disabled:opacity-50"
        >
          Create
        </button>
      </div>
    </div>
  );
}
