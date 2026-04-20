import { describe, expect, it } from "vitest";
import { parseDeepLink } from "../hooks/useDeepLink";

describe("parseDeepLink", () => {
  it("parses host-based GitHub links", () => {
    expect(parseDeepLink("cutready://gh/sethjuarez/cutready")).toEqual({
      owner: "sethjuarez",
      repo: "cutready",
    });
  });

  it("parses path-based GitHub links", () => {
    expect(parseDeepLink("cutready:///gh/sethjuarez/cutready/")).toEqual({
      owner: "sethjuarez",
      repo: "cutready",
    });
  });

  it("normalizes git suffixes and rejects invalid links", () => {
    expect(parseDeepLink("cutready://gh/sethjuarez/cutready.git?source=browser")).toEqual({
      owner: "sethjuarez",
      repo: "cutready",
    });
    expect(parseDeepLink("https://github.com/sethjuarez/cutready")).toBeNull();
    expect(parseDeepLink("cutready://gh/sethjuarez")).toBeNull();
  });
});
