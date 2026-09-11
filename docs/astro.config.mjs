// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://cutready.io",
  integrations: [
    starlight({
      title: "CutReady",
      disable404Route: true,
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
          items: [{ autogenerate: { directory: "getting-started" } }],
        },
        {
          label: "Features",
          items: [{ autogenerate: { directory: "features" } }],
        },
        {
          label: "Collaboration",
          items: [{ autogenerate: { directory: "collaboration" } }],
        },
        {
          label: "Workflow",
          items: [{ autogenerate: { directory: "workflow" } }],
        },
        {
          label: "Architecture",
          items: [{ autogenerate: { directory: "architecture" } }],
        },
        {
          label: "Settings",
          items: [{ autogenerate: { directory: "settings" } }],
        },
        {
          label: "Roadmap",
          items: [{ autogenerate: { directory: "roadmap" } }],
        },
      ],
    }),
  ],
});
