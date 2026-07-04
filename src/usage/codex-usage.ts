/**
 * Codex usage: scans the newest `rollout-*.jsonl` session files under
 * ~/.codex/sessions (year/month/day tree) for `token_count` events carrying
 * `rate_limits` snapshots — primary window (5h) and secondary window (7d).
 * Approach mirrors Thoth's Codex reader and Nimbalyst's CodexUsageService
 * (MIT), including the expired-window filter.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentUsage } from "./types";

const MAX_FILES_TO_CHECK = 5;

export function defaultCodexSessionsDir(): string {
  return path.join(os.homedir(), ".codex", "sessions");
}

export interface CodexRateLimitWindow {
  used_percent: number;
  window_minutes?: number;
  resets_at?: number; // Unix seconds
}

export interface CodexRateLimits {
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
}

export interface CodexTokenUsage {
  totalTokens: number;
  lastTokens: number | null;
}

/**
 * Drops expired windows: each window carries its own resets_at and the JSONL
 * files are never rewritten, so a stale used_percent would otherwise stick
 * forever after the window resets. Returns null when nothing is active.
 */
export function filterRateLimitsByExpiry(
  rateLimits: CodexRateLimits,
  nowSeconds: number
): CodexRateLimits | null {
  const primary = rateLimits.primary ?? null;
  const secondary = rateLimits.secondary ?? null;

  const primaryActive =
    primary !== null && (typeof primary.resets_at !== "number" || primary.resets_at > nowSeconds);
  const secondaryActive =
    secondary !== null &&
    (typeof secondary.resets_at !== "number" || secondary.resets_at > nowSeconds);

  if (!primaryActive && !secondaryActive) {
    return null;
  }
  return {
    primary: primaryActive ? primary : null,
    secondary: secondaryActive ? secondary : null,
  };
}

/** Unwraps the token_count payload from either JSONL event encoding. */
export function getTokenCountPayload(
  event: Record<string, unknown>
): Record<string, unknown> | null {
  if (event.type === "event_msg") {
    const payload = event.payload as Record<string, unknown> | undefined;
    return payload?.type === "token_count" ? payload : null;
  }
  if (event.type === "token_count") {
    return event;
  }
  return null;
}

export function extractRateLimitsFromEvent(
  event: Record<string, unknown>,
  nowSeconds: number
): CodexRateLimits | null {
  const payload = getTokenCountPayload(event);
  if (!payload) {
    return null;
  }
  // Thoth reads rate_limits from the payload root OR from payload.info.
  const info = payload.info as Record<string, unknown> | undefined;
  const rateLimits = (payload.rate_limits ?? info?.rate_limits) as CodexRateLimits | undefined;
  if (!rateLimits?.primary) {
    return null;
  }
  return filterRateLimitsByExpiry(rateLimits, nowSeconds);
}

export function extractTokenUsageFromEvent(
  event: Record<string, unknown>
): CodexTokenUsage | null {
  const payload = getTokenCountPayload(event);
  if (!payload) {
    return null;
  }
  const info = payload.info as
    | {
        total_token_usage?: { total_tokens?: number };
        last_token_usage?: { total_tokens?: number };
      }
    | undefined;
  const totalTokens = info?.total_token_usage?.total_tokens;
  if (typeof totalTokens !== "number") {
    return null;
  }
  const lastTokens =
    typeof info?.last_token_usage?.total_tokens === "number"
      ? info.last_token_usage.total_tokens
      : null;
  return { totalTokens, lastTokens };
}

async function sortedSubdirs(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Newest rollout-*.jsonl files from the year/month/day session tree. */
async function recentSessionFiles(sessionsDir: string): Promise<string[]> {
  const files: Array<{ path: string; mtime: number }> = [];
  const years = (await sortedSubdirs(sessionsDir)).reverse().slice(0, 2);
  for (const year of years) {
    const months = (await sortedSubdirs(path.join(sessionsDir, year))).reverse().slice(0, 2);
    for (const month of months) {
      const days = (await sortedSubdirs(path.join(sessionsDir, year, month)))
        .reverse()
        .slice(0, 3);
      for (const day of days) {
        const dayPath = path.join(sessionsDir, year, month, day);
        let entries: string[] = [];
        try {
          entries = await fs.readdir(dayPath);
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.startsWith("rollout-") || !entry.endsWith(".jsonl")) {
            continue;
          }
          const filePath = path.join(dayPath, entry);
          try {
            const stats = await fs.stat(filePath);
            files.push({ path: filePath, mtime: stats.mtimeMs });
          } catch {
            // Skip unreadable files.
          }
        }
      }
      if (files.length >= MAX_FILES_TO_CHECK) {
        break;
      }
    }
    if (files.length >= MAX_FILES_TO_CHECK) {
      break;
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime).map((file) => file.path);
}

interface Snapshot {
  rateLimits: CodexRateLimits | null;
  tokenUsage: CodexTokenUsage | null;
}

/** Scans a JSONL file backwards for the latest active rate_limits snapshot. */
async function snapshotFromFile(filePath: string, nowSeconds: number): Promise<Snapshot> {
  let tokenUsage: CodexTokenUsage | null = null;
  let rateLimits: CodexRateLimits | null = null;
  try {
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split("\n");
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index].trim();
      if (!line) {
        continue;
      }
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (!tokenUsage) {
          tokenUsage = extractTokenUsageFromEvent(event);
        }
        if (!rateLimits) {
          rateLimits = extractRateLimitsFromEvent(event, nowSeconds);
          if (rateLimits) {
            break;
          }
        }
      } catch {
        // Skip unparseable lines.
      }
    }
  } catch {
    // Unreadable file — treated as empty.
  }
  return { rateLimits, tokenUsage };
}

export interface CodexUsageOptions {
  sessionsDir?: string;
  now?: number;
}

export async function fetchCodexUsage(options: CodexUsageOptions = {}): Promise<AgentUsage> {
  const sessionsDir = options.sessionsDir || defaultCodexSessionsDir();
  const now = options.now ?? Date.now();
  const nowSeconds = now / 1000;

  const files = await recentSessionFiles(sessionsDir);
  let fallbackTokens: CodexTokenUsage | null = null;
  let rateLimits: CodexRateLimits | null = null;
  let tokenUsage: CodexTokenUsage | null = null;

  for (const filePath of files.slice(0, MAX_FILES_TO_CHECK)) {
    const snapshot = await snapshotFromFile(filePath, nowSeconds);
    if (snapshot.tokenUsage && !fallbackTokens) {
      fallbackTokens = snapshot.tokenUsage;
    }
    if (snapshot.rateLimits) {
      rateLimits = snapshot.rateLimits;
      tokenUsage = snapshot.tokenUsage ?? fallbackTokens;
      break;
    }
  }

  if (!rateLimits) {
    return {
      fiveHour: { utilization: 0, resetsAt: null },
      sevenDay: { utilization: 0, resetsAt: null },
      tokenUsage: fallbackTokens ?? undefined,
      limitsAvailable: false,
      lastUpdated: now,
      error: fallbackTokens ? undefined : "no-data",
    };
  }

  const toIso = (resetsAt: number | undefined): string | null =>
    typeof resetsAt === "number" ? new Date(resetsAt * 1000).toISOString() : null;

  return {
    fiveHour: {
      utilization: rateLimits.primary?.used_percent ?? 0,
      resetsAt: toIso(rateLimits.primary?.resets_at),
    },
    sevenDay: {
      utilization: rateLimits.secondary?.used_percent ?? 0,
      resetsAt: toIso(rateLimits.secondary?.resets_at),
    },
    tokenUsage: tokenUsage ?? undefined,
    limitsAvailable: true,
    lastUpdated: now,
  };
}
