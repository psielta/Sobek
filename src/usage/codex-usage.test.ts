import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractRateLimitsFromEvent,
  extractTokenUsageFromEvent,
  fetchCodexUsage,
  filterRateLimitsByExpiry,
} from "./codex-usage";

const NOW_SECONDS = 1_800_000_000;

describe("filterRateLimitsByExpiry", () => {
  it("keeps active windows and drops expired ones independently", () => {
    const result = filterRateLimitsByExpiry(
      {
        primary: { used_percent: 91, resets_at: NOW_SECONDS - 10 },
        secondary: { used_percent: 40, resets_at: NOW_SECONDS + 1000 },
      },
      NOW_SECONDS
    );
    expect(result?.primary).toBeNull();
    expect(result?.secondary?.used_percent).toBe(40);
  });

  it("returns null when every window expired", () => {
    expect(
      filterRateLimitsByExpiry(
        {
          primary: { used_percent: 91, resets_at: NOW_SECONDS - 10 },
          secondary: { used_percent: 50, resets_at: NOW_SECONDS - 5 },
        },
        NOW_SECONDS
      )
    ).toBeNull();
  });

  it("treats windows without resets_at as active", () => {
    const result = filterRateLimitsByExpiry({ primary: { used_percent: 12 } }, NOW_SECONDS);
    expect(result?.primary?.used_percent).toBe(12);
  });
});

describe("event extraction", () => {
  const rateLimitEvent = {
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { total_tokens: 5000 },
        last_token_usage: { total_tokens: 120 },
      },
      rate_limits: {
        primary: { used_percent: 33, window_minutes: 300, resets_at: NOW_SECONDS + 600 },
        secondary: { used_percent: 10, window_minutes: 10080, resets_at: NOW_SECONDS + 86400 },
      },
    },
  };

  it("unwraps event_msg token_count payloads", () => {
    const limits = extractRateLimitsFromEvent(rateLimitEvent, NOW_SECONDS);
    expect(limits?.primary?.used_percent).toBe(33);
    expect(extractTokenUsageFromEvent(rateLimitEvent)).toEqual({
      totalTokens: 5000,
      lastTokens: 120,
    });
  });

  it("supports top-level token_count events too", () => {
    const flat = { type: "token_count", rate_limits: { primary: { used_percent: 7 } } };
    expect(extractRateLimitsFromEvent(flat, NOW_SECONDS)?.primary?.used_percent).toBe(7);
  });

  it("reads rate_limits nested under payload.info (Thoth variant)", () => {
    const nested = {
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { rate_limits: { primary: { used_percent: 42 } } },
      },
    };
    expect(extractRateLimitsFromEvent(nested, NOW_SECONDS)?.primary?.used_percent).toBe(42);
  });

  it("ignores unrelated events", () => {
    expect(extractRateLimitsFromEvent({ type: "message" }, NOW_SECONDS)).toBeNull();
    expect(extractTokenUsageFromEvent({ type: "message" })).toBeNull();
  });
});

describe("fetchCodexUsage", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "sobek-codex-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reads the latest active rate_limits snapshot from the session tree", async () => {
    const dayDir = path.join(dir, "2026", "07", "04");
    await fs.mkdir(dayDir, { recursive: true });
    const lines = [
      JSON.stringify({ type: "message", text: "hi" }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: { total_tokens: 900 } },
          rate_limits: {
            primary: { used_percent: 55, resets_at: NOW_SECONDS + 600 },
            secondary: { used_percent: 21, resets_at: NOW_SECONDS + 86400 },
          },
        },
      }),
    ];
    await fs.writeFile(path.join(dayDir, "rollout-abc.jsonl"), lines.join("\n"), "utf8");

    const usage = await fetchCodexUsage({ sessionsDir: dir, now: NOW_SECONDS * 1000 });
    expect(usage.limitsAvailable).toBe(true);
    expect(usage.fiveHour.utilization).toBe(55);
    expect(usage.sevenDay.utilization).toBe(21);
    expect(usage.tokenUsage?.totalTokens).toBe(900);
  });

  it("falls back to token usage when no active limits exist", async () => {
    const dayDir = path.join(dir, "2026", "07", "04");
    await fs.mkdir(dayDir, { recursive: true });
    await fs.writeFile(
      path.join(dayDir, "rollout-x.jsonl"),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: { total_tokens: 1234 } },
          rate_limits: { primary: { used_percent: 91, resets_at: NOW_SECONDS - 10 } },
        },
      }),
      "utf8"
    );

    const usage = await fetchCodexUsage({ sessionsDir: dir, now: NOW_SECONDS * 1000 });
    expect(usage.limitsAvailable).toBe(false);
    expect(usage.tokenUsage?.totalTokens).toBe(1234);
  });

  it("reports no-data when the sessions directory is missing", async () => {
    const usage = await fetchCodexUsage({
      sessionsDir: path.join(dir, "nao-existe"),
      now: NOW_SECONDS * 1000,
    });
    expect(usage.limitsAvailable).toBe(false);
    expect(usage.error).toBe("no-data");
  });
});
