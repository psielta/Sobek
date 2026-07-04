/**
 * `@file` mentions: prompts reference workspace files as `@relative/path`.
 * Every mention must resolve to an existing file inside the workspace root,
 * mirroring Thoth's backend validation of prompt file references.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface Mention {
  /** Raw relative path as written after the `@`. */
  raw: string;
  /** Offset of the `@` character in the source text. */
  start: number;
  /** Offset just past the last path character. */
  end: number;
}

/**
 * Matches `@path` tokens: an `@` preceded by start-of-text or whitespace and
 * followed by a path-like run. Trailing punctuation is not part of the path.
 */
const MENTION_PATTERN = /(^|[\s([{])@([\w./\\-]+)/g;

export function parseMentions(text: string): Mention[] {
  const mentions: Mention[] = [];
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const prefix = match[1] ?? "";
    let raw = match[2] ?? "";
    // Strip trailing dots so sentence punctuation is not treated as path.
    raw = raw.replace(/\.+$/, "");
    if (raw.length === 0) {
      continue;
    }
    const start = (match.index ?? 0) + prefix.length;
    mentions.push({ raw, start, end: start + raw.length + 1 });
  }
  return mentions;
}

export type MentionIssueReason = "outside-workspace" | "not-found" | "not-a-file";

export interface MentionIssue {
  mention: Mention;
  reason: MentionIssueReason;
}

/** Resolves a mention against the workspace root; undefined if it escapes it. */
export function resolveMentionPath(workspaceRoot: string, raw: string): string | undefined {
  const resolved = path.resolve(workspaceRoot, raw);
  const relative = path.relative(path.resolve(workspaceRoot), resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return resolved;
}

export async function validateMentions(
  workspaceRoot: string,
  text: string
): Promise<{ mentions: Mention[]; issues: MentionIssue[] }> {
  const mentions = parseMentions(text);
  const issues: MentionIssue[] = [];
  for (const mention of mentions) {
    const resolved = resolveMentionPath(workspaceRoot, mention.raw);
    if (!resolved) {
      issues.push({ mention, reason: "outside-workspace" });
      continue;
    }
    try {
      const stats = await fs.stat(resolved);
      if (!stats.isFile()) {
        issues.push({ mention, reason: "not-a-file" });
      }
    } catch {
      issues.push({ mention, reason: "not-found" });
    }
  }
  return { mentions, issues };
}
