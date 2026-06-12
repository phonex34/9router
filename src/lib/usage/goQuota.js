/**
 * OpenCode Go quota tracker.
 *
 * Primary: scrape the official Go dashboard for real total usage across
 * all clients/devices (matches opencode.ai console exactly).
 * Fallback: estimate from local usageHistory DB (9Router spend only).
 *
 * Dashboard config (workspaceId + authCookie) is read from the connection's
 * providerSpecificData. Without it, we fall back to the local estimate.
 *
 * Limits (from official Go docs):
 *   - 5h rolling:  $12
 *   - Weekly:      $30
 *   - Monthly:     $60
 */

import { getAdapter } from "@/lib/db/driver.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";

// Go plan limits in USD
const GO_LIMITS = {
  rolling5h: { total: 12 },
  weekly: { total: 30 },
  monthly: { total: 60 },
};

const DASHBOARD_URL_PREFIX = "https://opencode.ai/workspace/";
const DASHBOARD_URL_SUFFIX = "/go";
const SCRAPE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0";
const SCRAPE_TIMEOUT_MS = 10000;

// ── Dashboard scraper ─────────────────────────────────────────────────────
// SolidJS SSR hydration output like:
//   rollingUsage:$R[3]={usagePercent:3,resetInSec:17820}
// Field order may vary, so try both orderings.
const NUM = String.raw`(-?\d+(?:\.\d+)?)`;

function makeWindowPatterns(field) {
  return {
    pctFirst: new RegExp(
      String.raw`${field}:\$R\[\d+\]=\{[^}]*usagePercent:${NUM}[^}]*resetInSec:${NUM}[^}]*\}`,
    ),
    resetFirst: new RegExp(
      String.raw`${field}:\$R\[\d+\]=\{[^}]*resetInSec:${NUM}[^}]*usagePercent:${NUM}[^}]*\}`,
    ),
  };
}

const RE_ROLLING = makeWindowPatterns("rollingUsage");
const RE_WEEKLY = makeWindowPatterns("weeklyUsage");
const RE_MONTHLY = makeWindowPatterns("monthlyUsage");

function parseWindow(html, patterns) {
  const pctMatch = patterns.pctFirst.exec(html);
  if (pctMatch) {
    const usagePercent = Number(pctMatch[1]);
    const resetInSec = Number(pctMatch[2]);
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) {
      return { usagePercent, resetInSec };
    }
  }
  const resetMatch = patterns.resetFirst.exec(html);
  if (resetMatch) {
    const resetInSec = Number(resetMatch[1]);
    const usagePercent = Number(resetMatch[2]);
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) {
      return { usagePercent, resetInSec };
    }
  }
  return null;
}

/**
 * Build a quota row from a scraped window (percentage-based).
 * total is the dollar limit; used = total * usagePercent / 100.
 */
function scrapedQuota(window, totalLimit, nowMs) {
  const usagePercent = Math.max(0, Math.min(100, window.usagePercent));
  const resetInSec = Math.max(0, window.resetInSec);
  const used = (totalLimit * usagePercent) / 100;
  return {
    used: Math.round(used * 100) / 100,
    total: totalLimit,
    remaining: Math.max(0, totalLimit - used),
    remainingPercentage: 100 - usagePercent,
    resetAt: new Date(nowMs + resetInSec * 1000).toISOString(),
    unlimited: false,
    unit: "USD",
  };
}

/**
 * Scrape the official Go dashboard. Returns { quotas } or null on failure.
 */
async function scrapeGoDashboard(workspaceId, authCookie, proxyOptions) {
  const url = `${DASHBOARD_URL_PREFIX}${encodeURIComponent(workspaceId)}${DASHBOARD_URL_SUFFIX}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS);
  let response;
  try {
    response = await proxyAwareFetch(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent": SCRAPE_USER_AGENT,
          Accept: "text/html",
          Cookie: `auth=${authCookie}`,
        },
        signal: controller.signal,
      },
      proxyOptions,
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    return { error: `dashboard error ${response.status}` };
  }

  const html = await response.text();
  const rolling = parseWindow(html, RE_ROLLING);
  const weekly = parseWindow(html, RE_WEEKLY);
  const monthly = parseWindow(html, RE_MONTHLY);

  if (!rolling && !weekly && !monthly) {
    return { error: "could not parse dashboard usage windows" };
  }

  const now = Date.now();
  const quotas = {};
  if (rolling) quotas["5h rolling"] = scrapedQuota(rolling, GO_LIMITS.rolling5h.total, now);
  if (weekly) quotas["Weekly"] = scrapedQuota(weekly, GO_LIMITS.weekly.total, now);
  if (monthly) quotas["Monthly"] = scrapedQuota(monthly, GO_LIMITS.monthly.total, now);

  return { quotas };
}

// ── Local DB fallback ──────────────────────────────────────────────────────
function getWeekStartMs() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon
  const diff = day === 0 ? 6 : day - 1;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - diff);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.getTime();
}

function getMonthStartMs(providerSpecificData) {
  const anchor = providerSpecificData?.goMonthlyAnchor;
  if (anchor) {
    const anchorMs = new Date(anchor).getTime();
    if (Number.isFinite(anchorMs) && anchorMs < Date.now()) return anchorMs;
  }
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).getTime();
}

async function sumCostsInWindow(windowStartMs) {
  const db = await getAdapter();
  const cutoff = new Date(windowStartMs).toISOString();
  const row = db.get(
    `SELECT COALESCE(SUM(cost), 0) AS totalCost
     FROM usageHistory
     WHERE provider = 'opencode-go'
       AND timestamp >= ?`,
    [cutoff],
  );
  return row?.totalCost ?? 0;
}

function getResetTimes() {
  const now = Date.now();
  const rolling5hReset = new Date(now + 5 * 60 * 60 * 1000).toISOString();
  const weekEnd = getWeekStartMs() + 7 * 24 * 60 * 60 * 1000;
  const weeklyReset = new Date(weekEnd).toISOString();
  const nowDate = new Date();
  const monthlyReset = new Date(
    Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() + 1, 1),
  ).toISOString();
  return { rolling5hReset, weeklyReset, monthlyReset };
}

function localQuota(usedCost, totalLimit, resetAt) {
  return {
    used: Math.round(usedCost * 100) / 100,
    total: totalLimit,
    remaining: Math.max(0, totalLimit - usedCost),
    remainingPercentage: Math.max(0, 100 - (usedCost / totalLimit) * 100),
    resetAt,
    unlimited: false,
    unit: "USD",
  };
}

async function localGoUsage(providerSpecificData) {
  const now = Date.now();
  const [rollingCost, weeklyCost, monthlyCost] = await Promise.all([
    sumCostsInWindow(now - 5 * 60 * 60 * 1000),
    sumCostsInWindow(getWeekStartMs()),
    sumCostsInWindow(getMonthStartMs(providerSpecificData)),
  ]);
  const resets = getResetTimes();
  return {
    "5h rolling": localQuota(rollingCost, GO_LIMITS.rolling5h.total, resets.rolling5hReset),
    Weekly: localQuota(weeklyCost, GO_LIMITS.weekly.total, resets.weeklyReset),
    Monthly: localQuota(monthlyCost, GO_LIMITS.monthly.total, resets.monthlyReset),
  };
}

// ── Public API ──────────────────────────────────────────────────────────────
/**
 * Fetch OpenCode Go quota. Tries the official dashboard scrape first
 * (accurate, all clients), then falls back to local DB estimate.
 */
export async function getOpenCodeGoUsage(providerSpecificData, proxyOptions = null) {
  const workspaceId = providerSpecificData?.workspaceId;
  const authCookie = providerSpecificData?.authCookie;

  // Primary: scrape official dashboard when configured
  if (workspaceId && authCookie) {
    try {
      const scraped = await scrapeGoDashboard(workspaceId, authCookie, proxyOptions);
      if (scraped?.quotas && Object.keys(scraped.quotas).length > 0) {
        return { plan: "OpenCode Go", source: "dashboard", quotas: scraped.quotas };
      }
      // scrape returned an error → fall through to local fallback below
      console.warn(
        `[Go usage] dashboard scrape failed (${scraped?.error || "unknown"}), using local estimate`,
      );
    } catch (error) {
      console.warn(`[Go usage] dashboard scrape error: ${error.message}, using local estimate`);
    }
  }

  // Fallback: local DB estimate (9Router spend only)
  try {
    const quotas = await localGoUsage(providerSpecificData);
    return {
      plan: "OpenCode Go",
      source: "local",
      message: (workspaceId && authCookie)
        ? "Dashboard unavailable — showing local 9Router usage estimate."
        : "Local 9Router usage estimate. Add workspace ID + auth cookie for exact dashboard totals.",
      quotas,
    };
  } catch (error) {
    return { message: `OpenCode Go usage error: ${error.message}` };
  }
}

/**
 * Ensure a monthly anchor is set in providerSpecificData if not present.
 * Returns the field to merge, or null if no update needed.
 */
export async function ensureMonthlyAnchor(providerSpecificData) {
  if (providerSpecificData?.goMonthlyAnchor) return null;
  const db = await getAdapter();
  const row = db.get(
    `SELECT MIN(timestamp) AS firstUsage
     FROM usageHistory
     WHERE provider = 'opencode-go'
       AND cost > 0`,
  );
  return { goMonthlyAnchor: row?.firstUsage || new Date().toISOString() };
}
