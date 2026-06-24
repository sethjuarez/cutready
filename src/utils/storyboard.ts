import type { Storyboard, StoryboardItem } from "../types/sketch";

export function getStoryboardSketchPaths(storyboard: Storyboard): string[] {
  return storyboard.items.flatMap((item) =>
    item.type === "sketch_ref" ? [item.path] : item.sketches,
  );
}

export function getUniqueStoryboardSketchPaths(storyboard: Storyboard): string[] {
  return [...new Set(getStoryboardSketchPaths(storyboard))];
}

export function getStoryboardSketchCount(storyboard: Storyboard): number {
  return getStoryboardSketchPaths(storyboard).length;
}

export function getStoryboardItemKey(item: StoryboardItem): string {
  return item.type === "sketch_ref"
    ? `sketch:${item.path}`
    : `section:${item.title}`;
}

export function getStoryboardItemRenderKey(item: StoryboardItem, index: number): string {
  if (item.type === "sketch_ref") return `sketch:${item.path}:${index}`;
  return `section:${item.title}:${index}`;
}

export function makeSketchRef(path: string): StoryboardItem {
  return { type: "sketch_ref", path };
}

export function makeSection(title: string, description = ""): StoryboardItem {
  return { type: "section", title, description, sketches: [] };
}

export function updateStoryboardSection(
  items: StoryboardItem[],
  sectionIndex: number,
  update: { title?: string; description?: string },
): StoryboardItem[] {
  return items.map((item, index) => {
    if (index !== sectionIndex || item.type !== "section") return item;
    return {
      ...item,
      title: update.title ?? item.title,
      description: update.description ?? item.description,
    };
  });
}

export function appendSketchToSection(
  items: StoryboardItem[],
  sectionIndex: number,
  sketchPath: string,
): StoryboardItem[] {
  return items.map((item, index) => {
    if (index !== sectionIndex || item.type !== "section") return item;
    return { ...item, sketches: [...item.sketches, sketchPath] };
  });
}

export function removeSketchFromSection(
  items: StoryboardItem[],
  sectionIndex: number,
  sketchIndex: number,
): StoryboardItem[] {
  return items.map((item, index) => {
    if (index !== sectionIndex || item.type !== "section") return item;
    return {
      ...item,
      sketches: item.sketches.filter((_, index) => index !== sketchIndex),
    };
  });
}

export function removeStoryboardItem(items: StoryboardItem[], itemIndex: number): StoryboardItem[] {
  return items.filter((_, index) => index !== itemIndex);
}
