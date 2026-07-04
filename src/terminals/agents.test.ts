import { describe, expect, it } from "vitest";
import {
  AGENT_TAB_DEFAULTS,
  buildAgentCommand,
  buildAgentRunCommand,
  flattenPromptForCli,
  needsLeadingCharStaging,
  quoteForShell,
} from "./agents";

describe("agent launch commands", () => {
  it("matches Thoth's invocation when effort max is chosen", () => {
    expect(buildAgentCommand("Claude", "max")).toBe(
      "claude --dangerously-skip-permissions --effort max"
    );
    expect(buildAgentCommand("ClaudePlan", "max")).toBe(
      "claude --dangerously-skip-permissions --effort max"
    );
  });

  it("omits --effort when the user keeps the CLI default", () => {
    expect(buildAgentCommand("Claude")).toBe("claude --dangerously-skip-permissions");
    expect(buildAgentCommand("Claude", "low")).toBe(
      "claude --dangerously-skip-permissions --effort low"
    );
    expect(buildAgentCommand("Claude", "xhigh")).toBe(
      "claude --dangerously-skip-permissions --effort xhigh"
    );
  });

  it("supports --effort on Grok too", () => {
    expect(buildAgentCommand("Grok")).toBe("grok --always-approve");
    expect(buildAgentCommand("Grok", "xhigh")).toBe("grok --always-approve --effort xhigh");
  });

  it("keeps the Codex invocation fixed", () => {
    expect(buildAgentCommand("Codex")).toBe("codex --yolo");
    expect(buildAgentCommand("Codex", "max")).toBe("codex --yolo");
  });

  it("keeps the agent tab defaults", () => {
    expect(AGENT_TAB_DEFAULTS.Claude).toMatchObject({ name: "Claude", color: "#8761b9" });
    expect(AGENT_TAB_DEFAULTS.ClaudePlan).toMatchObject({ name: "Claude Plan", color: "#5b4b8a" });
    expect(AGENT_TAB_DEFAULTS.Codex).toMatchObject({ name: "Codex", color: "#16c60c" });
    expect(AGENT_TAB_DEFAULTS.Grok).toMatchObject({ name: "Grok", color: "#ff8c00" });
  });
});

describe("quoteForShell", () => {
  it("escapes single quotes per shell flavor", () => {
    expect(quoteForShell("it's fine", "powershell")).toBe("'it''s fine'");
    expect(quoteForShell("it's fine", "posix")).toBe("'it'\\''s fine'");
    expect(quoteForShell('com "aspas" e $var', "powershell")).toBe("'com \"aspas\" e $var'");
  });
});

describe("buildAgentRunCommand", () => {
  it("passes the flattened prompt as a quoted CLI argument", () => {
    expect(buildAgentRunCommand("Claude", "linha 1\nlinha 2", "powershell", "max")).toBe(
      "claude --dangerously-skip-permissions --effort max 'linha 1 linha 2'"
    );
    expect(buildAgentRunCommand("Codex", "faça x", "powershell")).toBe("codex --yolo 'faça x'");
    expect(buildAgentRunCommand("Grok", "faça x", "posix", "high")).toBe(
      "grok --always-approve --effort high 'faça x'"
    );
  });

  it("uses --permission-mode plan without skip-permissions for plan mode", () => {
    expect(buildAgentRunCommand("ClaudePlan", "planeje isso", "powershell", "xhigh")).toBe(
      "claude --effort xhigh --permission-mode plan 'planeje isso'"
    );
    expect(buildAgentRunCommand("ClaudePlan", "planeje isso", "powershell")).toBe(
      "claude --permission-mode plan 'planeje isso'"
    );
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
