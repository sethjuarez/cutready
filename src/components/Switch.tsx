import type { ButtonHTMLAttributes } from "react";

interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "role" | "type"> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  size?: "sm" | "md";
}

/**
 * On/off switch. Styling lives in styles/a11y.css (`.cr-switch`) so the
 * increase-contrast and differentiate-without-color preferences can opt in.
 */
export function Switch({ checked, onChange, size = "md", className, ...rest }: SwitchProps) {
  return (
    <button
      {...rest}
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`cr-switch${size === "sm" ? " cr-switch-sm" : ""}${className ? ` ${className}` : ""}`}
    >
      <span className="cr-switch-glyph cr-switch-glyph-on" aria-hidden="true">
        I
      </span>
      <span className="cr-switch-glyph cr-switch-glyph-off" aria-hidden="true">
        O
      </span>
      <span className="cr-switch-thumb" aria-hidden="true" />
    </button>
  );
}
