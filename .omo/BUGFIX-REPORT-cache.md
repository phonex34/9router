# Báo cáo Bug Fix — Prompt Cache & Session (9router)

**Ngày:** 2026-07-01
**Branch:** `feature/opencode-quota`
**Phạm vi:** Sửa lỗi mất prompt cache (`cache_read=0`) và báo cáo usage sai trên các route Claude / OpenAI / Gemini.
**Trạng thái:** Đã fix + verify bằng traffic thật. Chưa commit.

---

## 1. Tóm tắt

Người dùng báo: nhiều session `cache_read = 0`, nghi "9router hash SHA message sai gây mất cache".

Điều tra xác định **4 nhóm bug độc lập**, không phải 1. Bug "hash sai" ban đầu là hiểu nhầm — hàm hash đúng, nhưng có nhiều giá trị **động (random/timestamp/uuid) chèn vào cache prefix** và **map usage sai khi trả về client**.

**Kết quả sau fix (session thật `ses_0e2fed190`, model `sonnet4.6-antigravity-opencodego`):**

| Turn | input | cache_read | trước fix |
|---|---|---|---|
| 1 | 93.746 | 0 (đúng — turn đầu) | 0 |
| 2 | 10.395 | **91.378** | 0 |
| 3 | 12.485 | **91.991** | 0 |
| 4 | 5.543 | **100.050** | 0 |
| 5 | 2.323 | **103.570** | 0 |

→ 4/5 turn cache hit, tiết kiệm ~90-100k token/turn. Trước fix: 0/12 turn (đốt tới 300k token/turn).

---

## 2. Các bug đã fix

### BUG 1 — Billing header động phá prompt cache Anthropic (CRITICAL)

**File:** `open-sse/utils/claudeCloaking.js`

**Triệu chứng:** Mọi turn `cache_read=0` trên route Claude/Anthropic.

**Root cause:** `generateBillingHeader` sinh `buildHash = randomBytes(2)` + `cch = sha256(payload)` — cả 2 đổi mỗi request — chèn vào `system[0]` (đầu prompt). Anthropic cache theo byte-identical prefix; 1 byte đổi ở đầu → invalidate toàn bộ system + tools (162 tool, ~267KB).

**Bằng chứng:** Qua 3 turn log thật, `tools` hash giống hệt, chỉ `system` hash đổi, điểm đổi chính xác là `cc_version=2.1.92.<random>`.

**Fix:** Billing header thành byte-stable: build constant + `cch=00000` (giá trị Anthropic dùng khi `CLAUDE_CODE_ATTRIBUTION_HEADER=0`).

**Verify (web/best-practice):** Anthropic API thật strip block này nội bộ; proxy forward nguyên → phá cache. Community (`claude-code-cache-fix`, `cc-gateway`) fix cùng cách → cache 0%→99.7%.

---

### BUG 2 — Usage `cache_read` không được map về client (reporting)

**File:** `open-sse/translator/response/claude-to-openai.js`, `open-sse/transformer/responsesTransformer.js`, `open-sse/handlers/chatCore/requestDetail.js`

**Triệu chứng:** Cache chạy thật (Anthropic trả `cache_read_input_tokens: 145817`) nhưng dashboard OpenCode hiện `cache_r=0`.

**Root cause (nhiều điểm):**
- `message_start` (nơi Anthropic gửi cache field) bị bỏ qua hoàn toàn.
- `message_delta` đọc cache field từ sai object (message_delta chỉ có `output_tokens`), rồi gọi `toOpenAIUsage(chunk.usage)` ghi đè mất giá trị đã tích lũy.
- `responsesTransformer.js` skip chunk chứa usage (guard `!parsed.choices?.length`) → `response.completed` không có usage.
- `saveUsageStats` strip cache field khi ghi DB.

**Fix:**
- Capture `chunk.message.usage` ở `message_start` → `state.claudeUsage`.
- `message_delta` merge output rồi dùng `toOpenAIUsage(state.claudeUsage)` → có `prompt_tokens_details.cached_tokens`.
- `message_stop` fallback rebuild qua `state.claudeUsage`.
- `responsesTransformer` capture `parsed.usage` trước guard + inject vào `response.completed`.
- `saveUsageStats` giữ `cached_tokens`/`cache_creation_tokens`.

---

### BUG 3 — SessionId dựa content, không ổn định qua compaction

**File:** `open-sse/utils/sessionManager.js` + call sites (`codex.js`, `antigravity.js`, `claude.js`, `openai-to-kiro.js`)

**Triệu chứng:** Session dài bị mất cache vĩnh viễn từ giữa chừng (khi context lớn/compact).

**Root cause:** `assistantTextSessionId` hash 50 ký tự đầu của assistant text — rỗng ở turn 1, đổi khi OpenCode compact history → sessionId đổi → cache anchor mất. Ngoài ra bỏ sót header session của client (OpenCode gửi `x-opencode-session`/`x-session-affinity`).

**Fix (theo pattern CLIProxyAPI — content-blind):**
- Mở rộng `SESSION_HEADER_KEYS`: thêm `x-opencode-session`, `x-session-affinity`, `x-parent-session-id`, `x-claude-code-session-id`, `thread-id`, `x-codex-window-id`.
- Thêm `stableApiKeyId` — UUIDv5 (SHA1) tất định per (scope, apiKey), ổn định qua restart.
- Thay assistant-text anchor bằng `firstUserTextSessionId` (first user message — có từ turn 1, sống sót compaction).
- Precedence: client header → first-user prefix → apiKey UUID → workspaceId → per-connection.

---

### BUG 4 — Giá trị động khác chèn vào cache prefix

**File:** `open-sse/handlers/imageProviders/codex.js`, `open-sse/translator/formats/gemini.js`, `open-sse/executors/antigravity.js`, `open-sse/translator/request/openai-to-gemini.js`, `open-sse/translator/request/openai-to-kiro.js`

Quét toàn bộ src tìm cùng class bug:

| Chỗ | Bug | Fix |
|---|---|---|
| codex image `prompt_cache_key: randomUUID()` | tự phá cache mỗi request | hash(model+prompt+size+quality) |
| gemini `generateProjectId` Math.random | envelope.project random → phá cache/routing | deterministic từ email/connectionId |
| antigravity `generateProjectId` Math.random | như trên | deterministic từ seed |
| openai-to-kiro timestamp trong content prefix | (đã xác định, hoãn theo yêu cầu — Kiro không ưu tiên) | — |

---

### BUG 5 — `cache_control` bị strip cho OpenRouter

**File:** `open-sse/providers/registry/openrouter.js`

**Triệu chứng:** Client gửi Claude format có `cache_control`, route qua OpenRouter → marker bị strip → OpenRouter không route được cache tới Anthropic/Kimi/Gemini.

**Root cause:** `filterToOpenAIFormat` strip `cache_control` mặc định, chỉ giữ khi provider bật `preserveCacheControl`. Chỉ alicode/DashScope bật (#2069). OpenRouter thiếu.

**Fix:** Thêm `quirks: { preserveCacheControl: true }` cho openrouter.

**Verify (web, phân loại từng provider):** CHỈ OpenRouter (+ alicode đã có) cần bật. Các provider khác:
- glm, xai/grok, nebius: **400 error** nếu nhận `cache_control` → phải OFF.
- kimi, minimax, deepseek, groq, together, fireworks, cerebras, mistral, siliconflow, perplexity, nvidia: **implicit cache** (tự động) → strip marker vô hại → OFF.

→ Bật bừa gây 400. Fix an toàn = chỉ OpenRouter.

---

## 3. Files thay đổi (16 + 2 test mới)

```
open-sse/utils/claudeCloaking.js                  BUG 1
open-sse/translator/response/claude-to-openai.js  BUG 2
open-sse/transformer/responsesTransformer.js      BUG 2
open-sse/handlers/chatCore/requestDetail.js       BUG 2
open-sse/utils/sessionManager.js                  BUG 3
open-sse/executors/codex.js                        BUG 3
open-sse/executors/antigravity.js                  BUG 3 + BUG 4
open-sse/translator/formats/claude.js              BUG 3
open-sse/translator/request/openai-to-kiro.js      BUG 3
open-sse/handlers/imageProviders/codex.js          BUG 4
open-sse/translator/formats/gemini.js              BUG 4
open-sse/translator/request/openai-to-gemini.js    BUG 4
open-sse/providers/registry/openrouter.js          BUG 5

tests/unit/session-manager.test.js       (mở rộng)
tests/unit/claude-cloaking.test.js       (mở rộng)
tests/unit/alicode-cache-control-2069.test.js (mở rộng)
tests/unit/claude-usage-cache.test.js    (mới)
tests/unit/cache-prefix-stability.test.js (mới)
```

---

## 4. Kiểm thử

- Test mới/mở rộng: session-manager (+8), claude-cloaking (+3), cache-prefix-stability (5), claude-usage-cache (3), alicode-cache-control (+3) — **tất cả pass**.
- Full suite: **996 pass**. 54 fail = pre-existing (verified bằng git stash: code gốc cũng 54 fail y hệt — db-benchmark, embeddings.cloud, live API, security-audit... thiếu creds/env). **Không regression.**
- Verify traffic thật: session `ses_0e2fed190` cache_read 91k-103k từ turn 2, hiển thị đúng trên OpenCode dashboard.

---

## 5. Còn lại (chưa fix — ngoài scope)

- Kiro timestamp/conversationId động (BUG 4) — người dùng chọn không ưu tiên Kiro.
- CommandCode threadId random + date động.
- Có thể mở issue upstream `decolua/9router` cho gap `cache_control` chung (chỉ OpenRouter thực sự bị ảnh hưởng).
