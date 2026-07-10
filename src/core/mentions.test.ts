import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseMentions, resolveMentionPath, validateMentions } from "./mentions";

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

  it("supports Next.js route-group parentheses in paths", () => {
    const text = "veja @app/(protected)/movimento/page.tsx";
    expect(parseMentions(text).map((mention) => mention.raw)).toEqual([
      "app/(protected)/movimento/page.tsx",
    ]);
  });

  it("strips the closing paren of a wrapped mention but keeps balanced ones", () => {
    const text = "(veja @docs/plan.md) e (@app/(admin)/x.ts)";
    expect(parseMentions(text).map((mention) => mention.raw)).toEqual([
      "docs/plan.md",
      "app/(admin)/x.ts",
    ]);
  });

  it("reports the exact source range", () => {
    const text = "veja @a.md";
    const [mention] = parseMentions(text);
    expect(text.slice(mention.start, mention.end)).toBe("@a.md");
  });

  it("keeps trailing separators so directories can be mentioned", () => {
    const text = "veja @media/ e @src\\webview\\";
    expect(parseMentions(text).map((mention) => mention.raw)).toEqual([
      "media/",
      "src\\webview\\",
    ]);
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

describe("validateMentions", () => {
  let root: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sobek-mentions-"));
    await fs.mkdir(path.join(root, "media"));
    await fs.writeFile(path.join(root, "media", "icon.png"), "x");
    await fs.writeFile(path.join(root, "a.ts"), "x");
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("accepts existing files and directories, with or without trailing slash", async () => {
    const { issues } = await validateMentions(root, "veja @a.ts, @media e @media/");
    expect(issues).toEqual([]);
  });

  it("flags a trailing slash that points to a file", async () => {
    const { issues } = await validateMentions(root, "veja @a.ts/");
    expect(issues.map((issue) => issue.reason)).toEqual(["not-a-directory"]);
  });

  it("still flags missing paths and workspace escapes", async () => {
    const { issues } = await validateMentions(root, "@nao/existe.md e @../fora.txt");
    expect(issues.map((issue) => issue.reason)).toEqual(["not-found", "outside-workspace"]);
  });
});
