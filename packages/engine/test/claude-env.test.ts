import { describe, expect, it } from "vitest";
import { envWithApiKey } from "../src/agents/claude.js";

describe("envWithApiKey", () => {
  it("bills the given key and drops settings that would authenticate another way", () => {
    const env = envWithApiKey("sk-ant-api03-mine", {
      PATH: "/usr/bin",
      HOME: "/Users/me",
      ANTHROPIC_API_KEY: "sk-ant-api03-old",
      ANTHROPIC_AUTH_TOKEN: "bearer",
      CLAUDE_CODE_OAUTH_TOKEN: "subscription-token",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      ANTHROPIC_BASE_URL: "https://proxy.example",
    });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-api03-mine");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/Users/me");
    for (const k of ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_BASE_URL"]) {
      expect(env).not.toHaveProperty(k);
    }
  });
});
