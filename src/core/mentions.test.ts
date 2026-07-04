import { describe, expect, it } from "vitest";
import { parseMentions, resolveMentionPath } from "./mentions";

describe("parseMentions", () => {
  it("finds mentions at start, after whitespace and inside brackets", () => {
    const text = "@src/main.ts depois veja (@docs/plan.md) e\n@backend\\Api\\Program.cs";
    expect(parseMentions(text).map((mention) => mention.raw)).toEqual([
      "src/main.ts",
      "docs/plan.md",
      "backend\\Api\\Program.cs",
    ]);
  });

  it("ignores e-mails and trailing punctuation", () => {
    const text = "contato user@example.com e veja @src/app.ts.";
    const mentions = parseMentions(text);
    expect(mentions.map((mention) => mention.raw)).toEqual(["src/app.ts"]);
  });

  it("reports the exact source range", () => {
    const text = "veja @a.md";
    const [mention] = parseMentions(text);
    expect(text.slice(mention.start, mention.end)).toBe("@a.md");
  });
});

describe("resolveMentionPath", () => {
  it("resolves inside the workspace", () => {
    expect(resolveMentionPath("D:\\repo", "src/a.ts")).toMatch(/src[\\/]a\.ts$/);
  });

  it("rejects traversal outside the workspace", () => {
    expect(resolveMentionPath("D:\\repo", "../secrets.txt")).toBeUndefined();
    expect(resolveMentionPath("D:\\repo", "..\\..\\x")).toBeUndefined();
  });
});
