import { describe, expect, it } from "vitest";
import { fuzzyScore, rankPaths } from "./fuzzy";

describe("fuzzyScore", () => {
  it("prefers basename prefix over basename substring over path-only matches", () => {
    const prefix = fuzzyScore("main", "src/main.ts")!;
    const substring = fuzzyScore("ain", "src/main.ts")!;
    const inPath = fuzzyScore("src", "src/other.py")!;
    expect(prefix).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(inPath);
  });

  it("boosts shorter labels on prefix matches (VS Code coverage boost)", () => {
    const short = fuzzyScore("window", "src/window.ts")!;
    const long = fuzzyScore("window", "src/windowActions.ts")!;
    expect(short).toBeGreaterThan(long);
  });

  it("scores exact path identity highest", () => {
    const identity = fuzzyScore("src/main.ts", "src/main.ts")!;
    const prefix = fuzzyScore("main", "src/main.ts")!;
    expect(identity).toBeGreaterThan(prefix);
  });

  it("matches subsequences across the path", () => {
    expect(fuzzyScore("smt", "src/main.ts")).toBeDefined();
    expect(fuzzyScore("uigen", "src/ui/generate-child.ts")).toBeDefined();
  });

  it("supports path-separator queries", () => {
    expect(fuzzyScore("src/ma", "src/main.ts")).toBeDefined();
    expect(fuzzyScore("ui/gen", "src/ui/generate-child.ts")).toBeDefined();
  });

  it("rejects queries with characters missing from the target", () => {
    expect(fuzzyScore("xyz", "src/main.ts")).toBeUndefined();
    expect(fuzzyScore("mainz", "src/main.ts")).toBeUndefined();
  });

  it("is case-insensitive", () => {
    expect(fuzzyScore("MAIN", "src/Main.TS")).toBeDefined();
  });
});

describe("rankPaths", () => {
  const files = [
    "src/ui/tree.ts",
    "src/main.ts",
    "src/core/mentions.ts",
    "README.md",
    "docs/main-plan.md",
  ];

  it("returns shallow paths alphabetically for an empty query", () => {
    expect(rankPaths("", files, 3)).toEqual(["README.md", "docs/main-plan.md", "src/main.ts"]);
  });

  it("ranks the best fuzzy matches first", () => {
    const results = rankPaths("main", files, 5);
    expect(results[0]).toBe("src/main.ts");
    expect(results).toContain("docs/main-plan.md");
    expect(results).not.toContain("src/ui/tree.ts");
  });

  it("respects the limit", () => {
    expect(rankPaths("", files, 2)).toHaveLength(2);
  });
});
