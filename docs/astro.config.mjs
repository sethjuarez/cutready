// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://sethjuarez.github.io",
  base: "/cutready",
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
          label: "Workflow",
          autogenerate: { directory: "workflow" },
        },
        {
          label: "Architecture",
          autogenerate: { directory: "architecture" },
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
