/**
 * Unit tests for open-sse/utils/claudeCloaking.js
 *
 * Tests cover:
 *  - cloakClaudeTools() - tool renaming and forced tool_choice suffixing
 */

import { describe, it, expect } from "vitest";
import { cloakClaudeTools, applyCloaking } from "../../open-sse/utils/claudeCloaking.js";
import { CLAUDE_TOOL_SUFFIX } from "../../open-sse/config/appConstants.js";

describe("cloakClaudeTools", () => {
  const baseBody = {
    tools: [{ name: "todo_write", description: "write todos", input_schema: { type: "object", properties: {} } }],
    messages: [{ role: "user", content: [{ type: "text", text: "add a todo" }] }]
  };

  it("suffixes client tool names and maps them back", () => {
    const { body, toolNameMap } = cloakClaudeTools(baseBody);
    const suffixed = `todo_write${CLAUDE_TOOL_SUFFIX}`;
    expect(body.tools.find(t => t.name === suffixed)).toBeDefined();
    expect(toolNameMap.get(suffixed)).toBe("todo_write");
  });

  it("suffixes a forced tool_choice to match the renamed tool", () => {
    const { body } = cloakClaudeTools({
      ...baseBody,
      tool_choice: { type: "tool", name: "todo_write" }
    });
    // Without this, Claude rejects: "Tool 'todo_write' not found in provided tools".
    expect(body.tool_choice).toEqual({ type: "tool", name: `todo_write${CLAUDE_TOOL_SUFFIX}` });
  });

  it("suffixes only the chosen tool when several are present", () => {
    const { body } = cloakClaudeTools({
      tools: [
        { name: "search", input_schema: { type: "object", properties: {} } },
        { name: "todo_write", input_schema: { type: "object", properties: {} } }
      ],
      tool_choice: { type: "tool", name: "todo_write" }
    });
    expect(body.tool_choice).toEqual({ type: "tool", name: `todo_write${CLAUDE_TOOL_SUFFIX}` });
  });

  it("leaves non-forced tool_choice untouched", () => {
    const auto = cloakClaudeTools({ ...baseBody, tool_choice: { type: "auto" } });
    expect(auto.body.tool_choice).toEqual({ type: "auto" });

    const none = cloakClaudeTools({ ...baseBody });
    expect(none.body.tool_choice).toBeUndefined();
  });

  it("does not suffix a forced choice that targets a non-client (decoy/built-in) tool", () => {
    // "Bash" is an injected decoy sent unsuffixed; forcing it must stay as-is.
    const { body } = cloakClaudeTools({ ...baseBody, tool_choice: { type: "tool", name: "Bash" } });
    expect(body.tool_choice).toEqual({ type: "tool", name: "Bash" });
  });

  it("renames tool_use names in message history", () => {
    const { body } = cloakClaudeTools({
      ...baseBody,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "todo_write", input: {} }] }
      ]
    });
    const block = body.messages[0].content[0];
    expect(block.name).toBe(`todo_write${CLAUDE_TOOL_SUFFIX}`);
  });

  it("returns the body unchanged when there are no tools", () => {
    const input = { messages: [{ role: "user", content: "hi" }], tool_choice: { type: "tool", name: "x" } };
    const { body, toolNameMap } = cloakClaudeTools(input);
    expect(body).toBe(input);
    expect(toolNameMap).toBeNull();
  });
});

// The billing header sits at system[0]; Anthropic prompt cache invalidates the whole
// prefix if any byte changes, so it MUST be identical across turns of a conversation.
describe("applyCloaking billing header is byte-stable (prompt-cache safe)", () => {
  const OAT = "sk-ant-oat01-abc";
  const mk = (userText) => applyCloaking(
    { system: [{ type: "text", text: "static system" }], messages: [{ role: "user", content: userText }] },
    OAT, "sess-1"
  );

  it("system[0] billing block is identical across different payloads", () => {
    const t1 = mk("turn one short");
    const t2 = mk("turn two is a completely different and much longer message body");
    expect(t1.system[0].text).toBe(t2.system[0].text);
    expect(t1.system[0].text).toContain("x-anthropic-billing-header:");
    expect(t1.system[0].text).toContain("cch=00000");
  });

  it("contains no random build hash (cc_version build is constant)", () => {
    const a = mk("a").system[0].text;
    const b = mk("b").system[0].text;
    const ver = (s) => s.match(/cc_version=([\d.]+)/)?.[1];
    expect(ver(a)).toBe(ver(b));
  });

  it("does not cloak when apiKey is not an OAuth token", () => {
    const out = applyCloaking({ system: [{ type: "text", text: "s" }] }, "sk-plain-key", "sess-1");
    expect(out.system[0].text).toBe("s");
  });
});
