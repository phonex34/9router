/**
 * Session Manager for Antigravity Cloud Code
 *
 * Handles session ID generation and caching for prompt caching continuity.
 * Mimics the Antigravity binary behavior: generates a session ID at startup
 * and keeps it for the process lifetime, scoped per account/connection.
 *
 * Reference: antigravity-claude-proxy/src/cloudcode/session-manager.js
 */

import crypto from "crypto";
import { MEMORY_CONFIG } from "../config/runtimeConfig.js";

// Runtime storage: Key = connectionId, Value = { sessionId, lastUsed }
const runtimeSessionStore = new Map();

// Periodically evict entries that haven't been used within TTL
const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of runtimeSessionStore) {
        if (now - entry.lastUsed > MEMORY_CONFIG.sessionTtlMs) {
            runtimeSessionStore.delete(key);
        }
    }
}, MEMORY_CONFIG.sessionCleanupIntervalMs);

// Allow Node.js to exit even if interval is still active
if (cleanupInterval.unref) cleanupInterval.unref();

/**
 * Get or create a session ID for the given connection.
 *
 * The binary generates a session ID once at startup: `rs() + Date.now()`.
 * Since 9router is long-running, we simulate this "per-launch" behavior by
 * storing a generated ID in memory for each connection.
 *
 * - If 9router restarts, the ID changes (matching binary restart behavior).
 * - Within a running instance, the ID is stable for that connection.
 * - This enables prompt caching while using the EXACT random logic of the binary.
 *
 * @param {string} connectionId - The connection identifier (email or unique ID)
 * @returns {string} A stable session ID string matching binary format
 */
export function deriveSessionId(connectionId) {
    if (!connectionId) {
        return generateBinaryStyleId();
    }

    const existing = runtimeSessionStore.get(connectionId);
    if (existing) {
        existing.lastUsed = Date.now();
        return existing.sessionId;
    }

    // Evict oldest entry if store exceeds max size (safety cap between cleanup cycles)
    const MAX_SESSIONS = 1000;
    if (runtimeSessionStore.size >= MAX_SESSIONS) {
      const oldest = runtimeSessionStore.keys().next().value;
      runtimeSessionStore.delete(oldest);
    }

    const sessionId = generateBinaryStyleId();
    runtimeSessionStore.set(connectionId, { sessionId, lastUsed: Date.now() });
    return sessionId;
}

/**
 * Generate a Session ID using the binary's exact logic.
 * Format: `rs() + Date.now()` where `rs()` is randomUUID
 *
 * @returns {string} A session ID in binary format
 */
export function generateBinaryStyleId() {
    return crypto.randomUUID() + Date.now().toString();
}

/**
 * Clears all session IDs (e.g. useful for testing or explicit reset)
 */
export function clearSessionStore() {
    runtimeSessionStore.clear();
    assistantSessionStore.clear();
}

// Conversation-stable session store: Key = hash(scope+first user text), Value = { sessionId, lastUsed }
const assistantSessionStore = new Map();
const MAX_ASSISTANT_SESSIONS = 5000;

// Per-conversation session-id headers per client (verbatim header names from each
// client's source). OpenCode: x-session-affinity/x-session-id/x-opencode-session.
// Claude Code: x-claude-code-session-id. Codex CLI: session-id/thread-id/x-codex-window-id.
const SESSION_HEADER_KEYS = [
    "x-session-id", "session-id", "session_id",
    "x-opencode-session", "x-session-affinity", "x-parent-session-id",
    "x-claude-code-session-id",
    "thread-id", "x-codex-window-id",
    "x-amp-thread-id", "x-client-request-id",
];
const CLAUDE_CODE_SESSION_RE = /_session_([a-f0-9-]+)$/;

function sha16(text) {
    return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// Normalize a session id candidate (trim, length cap)
function normalizeSessionId(value) {
    if (typeof value !== "string") return null;
    const v = value.trim();
    if (!v || v.length > 256) return null;
    return v;
}

// Extract Claude Code session id from metadata.user_id (_session_{uuid} | JSON {session_id})
function extractClaudeCodeSession(userId) {
    if (typeof userId !== "string" || !userId) return null;
    const m = userId.match(CLAUDE_CODE_SESSION_RE);
    if (m) return m[1];
    if (userId[0] === "{") {
        try { return normalizeSessionId(JSON.parse(userId)?.session_id); } catch { /* noop */ }
    }
    return null;
}

// Lowercase-key lookup for raw client headers
function headerValue(headers, key) {
    if (!headers || typeof headers !== "object") return null;
    return normalizeSessionId(headers[key] ?? headers[key.toLowerCase()]);
}

// Read client-provided session id from headers/body (no generation)
// Antigravity envelope carries session in request.sessionId; requestId embeds conversation uuid
const ANTIGRAVITY_CONV_RE = /^[a-z]+\/([0-9a-f-]{36})\//i;
function extractAntigravitySession(body) {
    const sid = body?.request?.sessionId;
    if (sid != null && sid !== "") return normalizeSessionId(String(sid));
    const m = typeof body?.requestId === "string" ? body.requestId.match(ANTIGRAVITY_CONV_RE) : null;
    return m ? normalizeSessionId(m[1]) : null;
}

function extractClientSessionId(headers, body) {
    const claude = extractClaudeCodeSession(body?.metadata?.user_id);
    if (claude) return `claude:${claude}`;
    const antigravity = extractAntigravitySession(body);
    if (antigravity) return `antigravity:${antigravity}`;
    for (const key of SESSION_HEADER_KEYS) {
        const v = headerValue(headers, key);
        if (v) return v;
    }
    const fromBody =
        normalizeSessionId(body?.prompt_cache_key) ||
        normalizeSessionId(body?.session_id) ||
        normalizeSessionId(body?.conversation_id) ||
        normalizeSessionId(body?.metadata?.user_id);
    return fromBody || null;
}

// First user turn text — stable anchor that survives history growth/compaction
// (unlike assistant text, empty on turn 1). Reads only the FIRST user message.
function accumulateFirstUserText(body) {
    const items = Array.isArray(body?.input) ? body.input
        : Array.isArray(body?.messages) ? body.messages : null;
    if (!items) return "";
    for (const item of items) {
        if (item?.role !== "user") continue;
        if (typeof item.content === "string") return item.content;
        if (Array.isArray(item.content)) {
            let text = "";
            for (const c of item.content) text += c?.text || c?.output || "";
            return text;
        }
    }
    return "";
}

const FIRST_USER_MIN_LEN = 16;

// Stable session id anchored on the first user message (survives compaction).
function firstUserTextSessionId(scope, body) {
    const text = accumulateFirstUserText(body);
    if (text.length < FIRST_USER_MIN_LEN) return null;
    const hash = sha16(`${scope}:${text}`);
    const existing = assistantSessionStore.get(hash);
    if (existing) {
        existing.lastUsed = Date.now();
        return existing.sessionId;
    }
    if (assistantSessionStore.size >= MAX_ASSISTANT_SESSIONS) {
        assistantSessionStore.delete(assistantSessionStore.keys().next().value);
    }
    const sessionId = generateBinaryStyleId();
    assistantSessionStore.set(hash, { sessionId, lastUsed: Date.now() });
    return sessionId;
}

// Deterministic UUIDv5 per (scope, apiKey) — content-blind, stable across restarts.
// Mirrors CLIProxyAPI's uuid.NewSHA1(NameSpaceOID, ...): SHA1 of namespace bytes + name,
// with RFC-4122 version(5)/variant bits set. Cache anchor when no session header is sent.
const UUID_NAMESPACE_OID = "6ba7b812-9dad-11d1-80b4-00c04fd430c8";
function stableApiKeyId(scope, apiKey) {
    const key = normalizeSessionId(apiKey);
    if (!key) return null;
    const ns = Buffer.from(UUID_NAMESPACE_OID.replace(/-/g, ""), "hex");
    const h = crypto.createHash("sha1").update(ns).update(`${scope}:${key}`).digest();
    h[6] = (h[6] & 0x0f) | 0x50;
    h[8] = (h[8] & 0x3f) | 0x80;
    const hex = h.subarray(0, 16).toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Resolve a conversation-stable session id (generalizes Codex resolveCacheSessionId).
 * Priority: client session → accumulated-assistant-text hash → workspaceId → per-connection.
 *
 * Precedence (most stable first): client session header/body → first-user prefix anchor
 * → deterministic per-(scope,apiKey) UUID → workspaceId → per-connection id. Every source
 * is either client-provided or content-blind except the first-user anchor, which is chosen
 * over assistant text because it exists on turn 1 and survives history compaction.
 *
 * @param {object} opts
 * @param {object} [opts.headers] - Raw client request headers (lowercase keys)
 * @param {object} [opts.body] - Parsed request body
 * @param {string} [opts.connectionId] - Connection identifier (fallback scope)
 * @param {string} [opts.workspaceId] - Provider workspace id (account-wide fallback)
 * @param {string} [opts.scope] - Provider scope to isolate cache keys across providers
 * @param {string} [opts.apiKey] - Client API key for deterministic content-blind fallback
 * @returns {string} A stable session id
 */
export function resolveSessionId({ headers, body, connectionId, workspaceId, scope = "", apiKey = null } = {}) {
    const client = extractClientSessionId(headers, body);
    if (client) return client;
    const fromFirstUser = firstUserTextSessionId(`${scope}:${connectionId || ""}`, body);
    if (fromFirstUser) return fromFirstUser;
    const fromApiKey = stableApiKeyId(scope, apiKey);
    if (fromApiKey) return fromApiKey;
    const ws = normalizeSessionId(workspaceId);
    if (ws) return ws;
    return deriveSessionId(connectionId);
}

// Capture session id from request body + credentials (envelope still intact here)
export function captureSessionId(body, credentials, connectionId, scope = "") {
    return resolveSessionId({ headers: credentials?.rawHeaders, body, connectionId, scope, apiKey: credentials?.apiKey });
}

// Convert any session id to Antigravity numeric format "-<int64>" (matches real AG / CLIProxyAPI).
// Already-numeric ids (native AG sessionId) pass through unchanged.
export function toNumericSessionId(sessionId) {
    const v = normalizeSessionId(sessionId);
    if (!v) return null;
    if (/^-?\d+$/.test(v)) return v;
    const h = crypto.createHash("sha256").update(v).digest();
    const n = h.readBigUInt64BE(0) & 0x7fffffffffffffffn;
    return `-${n.toString()}`;
}

// Cleanup expired assistant-session entries
const assistantCleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of assistantSessionStore) {
        if (now - entry.lastUsed > MEMORY_CONFIG.sessionTtlMs) assistantSessionStore.delete(key);
    }
}, MEMORY_CONFIG.sessionCleanupIntervalMs);
if (assistantCleanup.unref) assistantCleanup.unref();
