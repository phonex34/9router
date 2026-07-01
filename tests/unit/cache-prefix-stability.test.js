// Locks the prompt-cache-prefix stability fixes: dynamic per-request values must NOT
// leak into the cacheable request prefix (system/tools/body cache-key fields), or the
// provider prompt cache is invalidated every turn (cache_read=0).
import { describe, it, expect } from "vitest";
import { generateProjectId } from "../../open-sse/translator/formats/gemini.js";
import codexImage from "../../open-sse/handlers/imageProviders/codex.js";

describe("generateProjectId", () => {
  it("is deterministic per seed (same account -> same synthetic project)", () => {
    expect(generateProjectId("user@acct.com")).toBe(generateProjectId("user@acct.com"));
  });

  it("different seeds -> different project ids", () => {
    expect(generateProjectId("a@x.com")).not.toBe(generateProjectId("b@x.com"));
  });

  it("no seed -> random fallback (not stable, but only used when projectId unknown)", () => {
    expect(generateProjectId()).not.toBe(generateProjectId());
  });
});

describe("codex image prompt_cache_key", () => {
  const build = (body) => codexImage.buildBody("gpt-image-1-image", body);

  it("is deterministic for identical prompt/model/size/quality", () => {
    const a = build({ prompt: "a cat", size: "1024x1024", quality: "high" });
    const b = build({ prompt: "a cat", size: "1024x1024", quality: "high" });
    expect(a.prompt_cache_key).toBe(b.prompt_cache_key);
  });

  it("differs when the prompt changes", () => {
    const a = build({ prompt: "a cat" });
    const b = build({ prompt: "a dog" });
    expect(a.prompt_cache_key).not.toBe(b.prompt_cache_key);
  });
});
