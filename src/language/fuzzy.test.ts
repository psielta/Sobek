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

  it("label-matches directories despite the trailing slash", () => {
    const dirPrefix = fuzzyScore("media", "media/")!;
    const inPath = fuzzyScore("med", "media-kit/other.py")!;
    expect(dirPrefix).toBeGreaterThan(inPath);
    const nested = fuzzyScore("webview", "src/webview/")!;
    const nestedPathOnly = fuzzyScore("webview", "src/webview/main.tsx")!;
    expect(nested).toBeGreaterThan(0);
    expect(nestedPathOnly).toBeGreaterThan(0);
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

  it("sorts a root directory at root depth, not one level deeper", () => {
    const mixed = ["b.ts", "a/", "a/x.ts"];
    expect(rankPaths("", mixed, 3)).toEqual(["a/", "b.ts", "a/x.ts"]);
  });

  it("ranks directories among files for a basename query", () => {
    const mixed = ["src/media-player.ts", "media/", "media/icon.png"];
    const results = rankPaths("media", mixed, 3);
    expect(results[0]).toBe("media/");
  });

  it("ranks 20k paths well under a keystroke budget", () => {
    const big: string[] = [];
    for (let index = 0; index < 20_000; index++) {
      big.push(`src/module-${index % 50}/feature-${index % 200}/file-${index}.ts`);
    }
    // Warm up the JIT, then take the best of three runs: cold shared CI
    // runners jitter a single wall-clock sample well past any tight budget.
    rankPaths("feature-12", big, 100);
    let best = Number.POSITIVE_INFINITY;
    let results: string[] = [];
    for (let run = 0; run < 3; run++) {
      const start = performance.now();
      results = rankPaths("feature-12", big, 100);
      best = Math.min(best, performance.now() - start);
    }
    expect(results.length).toBe(100);
    // Locally this sits in single-digit milliseconds.
    expect(best).toBeLessThan(250);
  });
});
