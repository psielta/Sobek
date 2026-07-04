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

interface UsageApiResponse {
  five_hour?: UsageApiWindow;
  seven_day?: UsageApiWindow;
  seven_day_opus?: UsageApiWindow;
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
    const error =
      response.status === 401
        ? "auth-expired"
        : response.status === 403
          ? "forbidden"
          : response.status === 429
            ? "rate-limited"
            : `http-${response.status}`;
    return {
      fiveHour: { utilization: 0, resetsAt: null },
      sevenDay: { utilization: 0, resetsAt: null },
      limitsAvailable: false,
      lastUpdated: now,
      error,
    };
  }

  const data = (await response.json()) as UsageApiResponse;
  return {
    fiveHour: {
      utilization: data.five_hour?.utilization ?? 0,
      resetsAt: data.five_hour?.resets_at ?? null,
    },
    sevenDay: {
      utilization: data.seven_day?.utilization ?? 0,
      resetsAt: data.seven_day?.resets_at ?? null,
    },
    sevenDayOpus: data.seven_day_opus
      ? {
          utilization: data.seven_day_opus.utilization ?? 0,
          resetsAt: data.seven_day_opus.resets_at ?? null,
        }
      : undefined,
    limitsAvailable: true,
    lastUpdated: now,
  };
}
