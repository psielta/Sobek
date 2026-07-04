import { describe, expect, it } from "vitest";
import {
  AGENT_COMMANDS,
  AGENT_TAB_DEFAULTS,
  flattenPromptForCli,
  needsLeadingCharStaging,
} from "./agents";

describe("agent launch commands", () => {
  it("matches Thoth's exact CLI invocations", () => {
    expect(AGENT_COMMANDS.Claude).toBe("claude --dangerously-skip-permissions --effort max");
    expect(AGENT_COMMANDS.ClaudePlan).toBe("claude --dangerously-skip-permissions --effort max");
    expect(AGENT_COMMANDS.Codex).toBe("codex --yolo");
    expect(AGENT_COMMANDS.Grok).toBe("grok --always-approve");
  });

  it("keeps the agent tab defaults", () => {
    expect(AGENT_TAB_DEFAULTS.Claude).toMatchObject({ name: "Claude", color: "#8761b9" });
    expect(AGENT_TAB_DEFAULTS.ClaudePlan).toMatchObject({ name: "Claude Plan", color: "#5b4b8a" });
    expect(AGENT_TAB_DEFAULTS.Codex).toMatchObject({ name: "Codex", color: "#16c60c" });
    expect(AGENT_TAB_DEFAULTS.Grok).toMatchObject({ name: "Grok", color: "#ff8c00" });
  });
});

describe("flattenPromptForCli", () => {
  it("collapses every newline flavour into single spaces and trims", () => {
    expect(flattenPromptForCli("linha 1\r\nlinha 2\nlinha 3\r")).toBe("linha 1 linha 2 linha 3");
    expect(flattenPromptForCli("  espaços  \n")).toBe("espaços");
  });
});

describe("needsLeadingCharStaging", () => {
  it("stages slash commands and memory shortcuts", () => {
    expect(needsLeadingCharStaging("/plan revisar")).toBe(true);
    expect(needsLeadingCharStaging("# lembrar disso")).toBe(true);
    expect(needsLeadingCharStaging("texto normal")).toBe(false);
  });
});
