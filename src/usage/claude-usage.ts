/**
 * Claude Code usage: reads the local OAuth credentials Claude Code keeps on
 * disk (or in the macOS Keychain) and queries Anthropic's OAuth usage API for
 * the 5-hour and 7-day windows. Approach mirrors Thoth's agent-usage reader
 * and Nimbalyst's ClaudeUsageService (MIT).
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { AgentUsage } from "./types";

const execFileAsync = promisify(execFile);

const USAGE_API_URL = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICES = ["Claude Code-credentials", "Claude Code"];

export function defaultClaudeCredentialsPath(): string {
  return path.join(os.homedir(), ".claude", ".credentials.json");
}

interface StoredCredentials {
  claudeAiOauth?: { accessToken?: string };
}

async function readTokenFromFile(credentialsPath: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(credentialsPath, "utf8");
    const credentials = JSON.parse(raw) as StoredCredentials;
    return credentials.claudeAiOauth?.accessToken || undefined;
  } catch {
    return undefined;
  }
}

async function readTokenFromKeychain(): Promise<string | undefined> {
  for (const service of KEYCHAIN_SERVICES) {
    try {
      const { stdout } = await execFileAsync(
        "security",
        ["find-generic-password", "-s", service, "-w"],
        { timeout: 5000 }
      );
      const credentials = JSON.parse(stdout.trim()) as StoredCredentials;
      const token = credentials.claudeAiOauth?.accessToken;
      if (token) {
        return token;
      }
    } catch {
      // Not found in this entry — try the fallback service name.
    }
  }
  return undefined;
}

async function resolveAccessToken(credentialsPath: string): Promise<string | undefined> {
  if (process.platform === "darwin") {
    return (await readTokenFromKeychain()) ?? readTokenFromFile(credentialsPath);
  }
  return readTokenFromFile(credentialsPath);
}

let cachedCliVersion: string | undefined;

/** Best-effort Claude Code CLI version for the User-Agent header. */
async function claudeCliVersion(): Promise<string> {
  if (cachedCliVersion) {
    return cachedCliVersion;
  }
  try {
    const { stdout } = await execFileAsync("claude", ["--version"], {
      timeout: 5000,
      shell: process.platform === "win32",
    });
    cachedCliVersion = stdout.trim().split(/\s+/)[0] || "unknown";
  } catch {
    cachedCliVersion = "unknown";
  }
  return cachedCliVersion;
}

interface UsageApiWindow {
  utilization?: number;
  resets_at?: string | null;
}

interface UsageApiLimit {
  kind?: string;
  group?: string;
  percent?: number;
  severity?: string;
  resets_at?: string | null;
  scope?: { model?: { display_name?: string | null } | null } | null;
}

interface UsageApiResponse {
  five_hour?: UsageApiWindow;
  seven_day?: UsageApiWindow;
  seven_day_opus?: UsageApiWindow;
  limits?: UsageApiLimit[];
}

export interface ClaudeUsageOptions {
  credentialsPath?: string;
  signal?: AbortSignal;
}

export async function fetchClaudeUsage(options: ClaudeUsageOptions = {}): Promise<AgentUsage> {
  const credentialsPath = options.credentialsPath || defaultClaudeCredentialsPath();
  const token = await resolveAccessToken(credentialsPath);
  const now = Date.now();
  if (!token) {
    return {
      fiveHour: { utilization: 0, resetsAt: null },
      sevenDay: { utilization: 0, resetsAt: null },
      limitsAvailable: false,
      lastUpdated: now,
      error: "no-credentials",
    };
  }

  const response = await fetch(USAGE_API_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": `claude-code/${await claudeCliVersion()}`,
    },
    signal: options.signal,
  });

  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 200);
    const error =
      response.status === 401
        ? "auth-expired"
        : response.status === 403
          ? "forbidden"
          : response.status === 429
            ? "rate-limited"
            : `http-${response.status}${body ? `: ${body}` : ""}`;
    return {
      fiveHour: { utilization: 0, resetsAt: null },
      sevenDay: { utilization: 0, resetsAt: null },
      limitsAvailable: false,
      lastUpdated: now,
      error,
    };
  }

  const data = (await response.json()) as UsageApiResponse;
  const clamp = (value: number): number => Math.min(100, Math.max(0, value));

  // Scoped windows (per-model weekly caps like Fable) come from the generic
  // limits array; session and weekly_all duplicate five_hour/seven_day.
  const extraWindows = (Array.isArray(data.limits) ? data.limits : [])
    .filter(
      (limit) =>
        limit.kind !== "session" &&
        limit.kind !== "weekly_all" &&
        typeof limit.percent === "number"
    )
    .map((limit) => ({
      label: limit.scope?.model?.display_name || limit.kind || "limit",
      group: limit.group,
      utilization: clamp(limit.percent ?? 0),
      resetsAt: limit.resets_at ?? null,
      critical: limit.severity === "critical",
    }));

  // Older responses only expose the Opus weekly window as a fixed field.
  if (extraWindows.length === 0 && data.seven_day_opus) {
    extraWindows.push({
      label: "Opus",
      group: "weekly",
      utilization: clamp(data.seven_day_opus.utilization ?? 0),
      resetsAt: data.seven_day_opus.resets_at ?? null,
      critical: false,
    });
  }

  return {
    fiveHour: {
      utilization: clamp(data.five_hour?.utilization ?? 0),
      resetsAt: data.five_hour?.resets_at ?? null,
    },
    sevenDay: {
      utilization: clamp(data.seven_day?.utilization ?? 0),
      resetsAt: data.seven_day?.resets_at ?? null,
    },
    extraWindows: extraWindows.length > 0 ? extraWindows : undefined,
    limitsAvailable: true,
    lastUpdated: now,
  };
}
