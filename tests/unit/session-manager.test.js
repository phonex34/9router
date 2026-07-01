// Locks resolveSessionId precedence + cache-stability guarantees:
//   client session header/body -> first-user prefix anchor -> deterministic apiKey uuid
//   -> workspaceId -> per-connection id. The key property is STABILITY across turns and
//   history compaction (the bug that produced permanent cache_read=0).
import { describe, it, expect, beforeEach } from "vitest";
import { resolveSessionId, deriveSessionId, clearSessionStore } from "../../open-sse/utils/sessionManager.js";

const firstUser = "hello from the first user message anchor that is long enough";
const bodyTurn1 = { messages: [{ role: "user", content: firstUser }] };
// Same conversation after several turns + a large tool_result (simulates OpenCode compaction):
// first user message unchanged, everything after it rewritten/grown.
const bodyTurnN = {
  messages: [
    { role: "user", content: firstUser },
    { role: "assistant", content: "z".repeat(5000) },
    { role: "user", content: "x".repeat(120000) },
  ],
};

beforeEach(() => clearSessionStore());

describe("resolveSessionId precedence", () => {
  it("stickiness: same body+connectionId+scope -> same id", () => {
    const opts = { body: bodyTurn1, connectionId: "conn1", scope: "codex" };
    expect(resolveSessionId(opts)).toBe(resolveSessionId(opts));
  });

  it("different connectionId -> different id", () => {
    const a = resolveSessionId({ body: bodyTurn1, connectionId: "connA", scope: "codex" });
    const b = resolveSessionId({ body: bodyTurn1, connectionId: "connB", scope: "codex" });
    expect(a).not.toBe(b);
  });

  it("different scope -> different id", () => {
    const a = resolveSessionId({ body: bodyTurn1, connectionId: "conn1", scope: "codex" });
    const b = resolveSessionId({ body: bodyTurn1, connectionId: "conn1", scope: "kiro" });
    expect(a).not.toBe(b);
  });

  it("client override: x-session-id header wins, skips later steps", () => {
    const got = resolveSessionId({
      headers: { "x-session-id": "client-sess-123" },
      body: bodyTurn1, connectionId: "conn1", workspaceId: "ws1", apiKey: "sk-abc", scope: "codex",
    });
    expect(got).toBe("client-sess-123");
  });

  it("workspaceId path used only when no client/prefix/apiKey source", () => {
    const got = resolveSessionId({ body: {}, connectionId: "conn1", workspaceId: "ws-abc" });
    expect(got).toBe("ws-abc");
  });

  it("fallback: empty body+no header+no apiKey+no workspaceId -> deriveSessionId(connectionId)", () => {
    const got = resolveSessionId({ body: {}, connectionId: "connFallback" });
    expect(got).toBe(deriveSessionId("connFallback"));
  });
});

describe("client session headers (generic across CLI tools)", () => {
  const clients = [
    ["x-opencode-session", "ses_opencode_1"],
    ["x-session-affinity", "ses_affinity_1"],
    ["x-claude-code-session-id", "claude-uuid-1"],
    ["thread-id", "codex-thread-1"],
    ["x-codex-window-id", "codex-window-1"],
  ];
  for (const [header, value] of clients) {
    it(`${header} header is honored and stable across history compaction`, () => {
      const t1 = resolveSessionId({ headers: { [header]: value }, body: bodyTurn1, connectionId: "c", scope: "antigravity" });
      const tN = resolveSessionId({ headers: { [header]: value }, body: bodyTurnN, connectionId: "c", scope: "antigravity" });
      expect(t1).toBe(value);
      expect(tN).toBe(value);
    });
  }
});

describe("first-user prefix anchor (survives compaction)", () => {
  it("same first-user message -> same id even after history grows/compacts", () => {
    const t1 = resolveSessionId({ body: bodyTurn1, connectionId: "conn1", scope: "codex" });
    const tN = resolveSessionId({ body: bodyTurnN, connectionId: "conn1", scope: "codex" });
    expect(t1).toBe(tN);
  });

  it("different first-user message -> different id", () => {
    const a = resolveSessionId({ body: bodyTurn1, connectionId: "conn1", scope: "codex" });
    const b = resolveSessionId({ body: { messages: [{ role: "user", content: "a totally different opening question here" }] }, connectionId: "conn1", scope: "codex" });
    expect(a).not.toBe(b);
  });
});

describe("deterministic apiKey uuid fallback (CLIProxyAPI pattern)", () => {
  it("no header + no user text -> stable uuid per (scope, apiKey), survives restart", () => {
    const opts = { body: {}, connectionId: null, apiKey: "sk-live-xyz", scope: "codex" };
    const a = resolveSessionId(opts);
    clearSessionStore();
    const b = resolveSessionId(opts);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("different apiKey -> different uuid", () => {
    const a = resolveSessionId({ body: {}, apiKey: "sk-1", scope: "codex" });
    const b = resolveSessionId({ body: {}, apiKey: "sk-2", scope: "codex" });
    expect(a).not.toBe(b);
  });

  it("different scope -> different uuid for same apiKey", () => {
    const a = resolveSessionId({ body: {}, apiKey: "sk-1", scope: "codex" });
    const b = resolveSessionId({ body: {}, apiKey: "sk-1", scope: "claude" });
    expect(a).not.toBe(b);
  });
});
