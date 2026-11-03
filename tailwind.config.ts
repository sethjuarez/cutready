import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: "rgb(var(--color-surface) / <alpha-value>)",
          alt: "rgb(var(--color-surface-alt) / <alpha-value>)",
          inset: "rgb(var(--color-surface-inset) / <alpha-value>)",
          toolbar: "rgb(var(--color-surface-toolbar) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "rgb(var(--color-accent) / <alpha-value>)",
          hover: "rgb(var(--color-accent-hover) / <alpha-value>)",
          fg: "rgb(var(--color-accent-fg) / <alpha-value>)",
        },
        border: {
          DEFAULT: "rgb(var(--color-border) / <alpha-value>)",
          subtle: "rgb(var(--color-border-subtle) / <alpha-value>)",
        },
        text: {
          DEFAULT: "rgb(var(--color-text) / <alpha-value>)",
          secondary: "rgb(var(--color-text-secondary) / <alpha-value>)",
        },
        secondary: "rgb(var(--color-secondary) / <alpha-value>)",
        tertiary: "rgb(var(--color-tertiary) / <alpha-value>)",
        success: "rgb(var(--color-success) / <alpha-value>)",
        warning: "rgb(var(--color-warning) / <alpha-value>)",
        error: "rgb(var(--color-error) / <alpha-value>)",
        // Neutral interaction fills, tinted from the text colour so they work on every palette.
        fill: {
          hover: "rgb(var(--color-text) / 0.06)",
          selected: "rgb(var(--color-text) / 0.08)",
          pressed: "rgb(var(--color-text) / 0.04)",
        },
        agent: {
          planner: "rgb(var(--color-agent-planner) / <alpha-value>)",
          writer: "rgb(var(--color-agent-writer) / <alpha-value>)",
          editor: "rgb(var(--color-agent-editor) / <alpha-value>)",
          designer: "rgb(var(--color-agent-designer) / <alpha-value>)",
        },
        diff: {
          "ins-bg": "rgb(var(--color-diff-ins-bg) / <alpha-value>)",
          "ins-fg": "rgb(var(--color-diff-ins-fg) / <alpha-value>)",
          "del-bg": "rgb(var(--color-diff-del-bg) / <alpha-value>)",
          "del-fg": "rgb(var(--color-diff-del-fg) / <alpha-value>)",
        },
      },
      fontSize: {
        "2xs": ["var(--text-2xs)", { lineHeight: "var(--text-2xs-lh)" }],
        xs: ["var(--text-xs)", { lineHeight: "var(--text-xs-lh)" }],
        sm: ["var(--text-sm)", { lineHeight: "var(--text-sm-lh)" }],
      },
      borderRadius: {
        control: "var(--radius-control)",
        card: "var(--radius-card)",
        pill: "var(--radius-pill)",
      },
      boxShadow: {
        layer: "var(--shadow-layer)",
        card: "var(--shadow-card)",
        "card-hover": "var(--shadow-card-hover)",
      },
      transitionDuration: {
        fast: "var(--motion-fast)",
        normal: "var(--motion-normal)",
      },
      transitionTimingFunction: {
        fluent: "var(--motion-ease)",
      },
      height: {
        control: "var(--control-height)",
        "nav-row": "var(--nav-row-height)",
      },
      gap: {
        card: "var(--card-gap)",
      },
      fontFamily: {
        sans: ['"Geist Sans"', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'system-ui', 'sans-serif'],
      },
      zIndex: {
        sticky: "var(--z-sticky)",
        dropdown: "var(--z-dropdown)",
        chrome: "var(--z-chrome)",
        overlay: "var(--z-overlay)",
        modal: "var(--z-modal)",
        toast: "var(--z-toast)",
      },
    },
  },
  plugins: [],
} satisfies Config;
