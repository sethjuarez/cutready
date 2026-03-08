// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://cutready.io",
  integrations: [
    starlight({
      title: "CutReady",
      customCss: ["./src/styles/custom.css"],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/sethjuarez/cutready",
        },
      ],
      sidebar: [
        {
          label: "Welcome",
          link: "/welcome/",
        },
        {
          label: "Getting Started",
          autogenerate: { directory: "getting-started" },
        },
        {
          label: "Features",
          autogenerate: { directory: "features" },
        },
        {
          label: "Collaboration",
          autogenerate: { directory: "collaboration" },
          badge: { text: "New", variant: "success" },
        },
        {
          label: "Workflow",
          autogenerate: { directory: "workflow" },
        },
        {
          label: "Architecture",
          autogenerate: { directory: "architecture" },
        },
        {
          label: "Settings",
          autogenerate: { directory: "settings" },
        },
        {
          label: "Roadmap",
          autogenerate: { directory: "roadmap" },
          badge: { text: "Preview", variant: "caution" },
        },
      ],
    }),
  ],
});
