/**
 * Daily digest scheduler — checks every few minutes for users whose delivery time
 * has arrived and sends them their curated digest.
 *
 * Uses the injectable now() clock (clock.ts) so time-based behavior is testable.
 * Wraps every DM to tolerate 403 (user never started / blocked the bot) without
 * aborting the loop.
 */

import { Bot } from "grammy";
import type { BotContext } from "./toolkit/index.js";
import { now } from "./clock.js";
import { getStore, type UserProfile } from "./storage.js";
import { fetchCryptoNews } from "./news.js";
import { inlineButton, inlineKeyboard } from "./toolkit/index.js";

// ── Types ──────────────────────────────────────────────────────────────────────

interface ScheduleCheckResult {
  checked: number;
  delivered: number;
  errors: number;
}

// ── Main scheduler ─────────────────────────────────────────────────────────────

/**
 * checkAndDeliver — called periodically (every 5 minutes by default) from a timer.
 * Scans the subscribed users and sends digests to those whose delivery time has
 * arrived (within the current check window).
 */
export async function checkAndDeliver(
  bot: Bot<BotContext<Record<string, unknown>>>,
  checkWindowMinutes = 6,
): Promise<ScheduleCheckResult> {
  const store = getStore();
  const subscribedUserIds = await store.getSubscribedUserIds();

  const result: ScheduleCheckResult = { checked: 0, delivered: 0, errors: 0 };

  for (const userId of subscribedUserIds) {
    result.checked++;
    const profile = await store.getUser(userId);
    if (!profile || profile.subscription_status !== "active") continue;

    const schedule = await store.getSchedule(userId);
    if (!schedule) continue;

    const isDue = isDeliveryDue(schedule.local_send_time, profile.timezone, checkWindowMinutes);
    if (!isDue) continue;

    try {
      await deliverDigest(bot, profile);
      result.delivered++;

      // Update the schedule's next_scheduled_send so we don't redeliver
      schedule.next_scheduled_send = computeNextSend(schedule.local_send_time, profile.timezone);
      await store.saveSchedule(schedule);
      await store.logEvent("delivery_sent", userId, "Daily digest delivered");
    } catch (err) {
      result.errors++;
      const errorMsg = err instanceof Error ? err.message : String(err);
      await store.logEvent("delivery_error", userId, `Delivery failed: ${errorMsg}`);

      // Notify admin if configured
      const adminChatId = await store.getAdminChatId();
      if (adminChatId) {
        try {
          await bot.api.sendMessage(
            adminChatId,
            `⚠️ Delivery error for user ${userId}: ${errorMsg}`,
          );
        } catch {
          // Admin chat may not be reachable — don't fail the loop
        }
      }
    }
  }

  return result;
}

// ── Delivery helper ────────────────────────────────────────────────────────────

async function deliverDigest(
  bot: Bot<BotContext<Record<string, unknown>>>,
  profile: UserProfile,
): Promise<void> {
  let articles: Awaited<ReturnType<typeof fetchCryptoNews>>;

  try {
    const apiKey = process.env.NEWSAPI_KEY;
    articles = await fetchCryptoNews(3, apiKey);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await getStore().logEvent("api_error", profile.telegram_id, `News API error: ${errorMsg}`);
    // Still try to send a fallback message
    try {
      await bot.api.sendMessage(
        profile.telegram_id,
        "⚠️ Couldn't fetch today's news. Please check back later.",
      );
    } catch {
      // User may have blocked — tolerate 403 silently
    }
    return;
  }

  if (articles.length === 0) {
    try {
      await bot.api.sendMessage(
        profile.telegram_id,
        "No crypto news available today. Check back tomorrow!",
      );
    } catch {
      // Tolerate 403
    }
    return;
  }

  // Format digest
  let text = "<b>📰 Daily Crypto Digest</b>\n\n";
  for (const a of articles) {
    text += `<b>${escapeHtml(a.headline)}</b>\n`;
    text += `${escapeHtml(a.summary)}\n`;
    text += `<a href="${a.sourceUrl}">${escapeHtml(a.sourceName)}</a>`;
    if (a.topics.length > 0) {
      text += `  ·  ${a.topics.map((t) => `#${t.replace(/\s+/g, "")}`).join(" ")}`;
    }
    text += "\n\n";
  }
  text = text.trim();

  // Build buttons
  const buttons: ReturnType<typeof inlineButton>[][] = [];
  for (let i = 0; i < articles.length; i++) {
    buttons.push([inlineButton(`🔍 More like #${i + 1}`, `related:${i}`)]);
  }
  buttons.push([
    inlineButton("💬 Feedback", "feedback"),
    inlineButton("✋ Stop digest", "unsubscribe"),
  ]);

  try {
    await bot.api.sendMessage(profile.telegram_id, text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: inlineKeyboard(buttons),
    });
  } catch (err) {
    // Tolerate 403 (user blocked or never started) — log but don't abort
    const apiErr = err as { error_name?: string };
    if (apiErr.error_name === "Forbidden") {
      // User blocked the bot — mark as unsubscribed silently
      profile.subscription_status = "unsubscribed";
      profile.updated_at = now().toISOString();
      await getStore().saveUser(profile);
      await getStore().logEvent("auto_unsubscribed", profile.telegram_id, "User blocked the bot");
      return;
    }
    throw err;
  }
}

// ── Time helpers ───────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * isDeliveryDue checks whether the given local delivery time falls within the
 * current check window (i.e., has arrived since the last check).
 */
function isDeliveryDue(
  localTime: string,
  timezone: string,
  checkWindowMinutes: number,
): boolean {
  const [h, m] = localTime.split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return false;

  const current = now();
  const currentMs = current.getTime();
  const currentLocal = toLocalTime(current, timezone);

  // The delivery time in the user's local time for today
  const deliveryToday = new Date(
    currentLocal.getFullYear(),
    currentLocal.getMonth(),
    currentLocal.getDate(),
    h,
    m,
    0,
    0,
  );
  // Convert back to UTC for comparison
  const deliveryUtcMs = deliveryToday.getTime() - getTimezoneOffset(deliveryToday, timezone);
  // Actually, since both dates are in UTC, let me be more careful:
  // currentMs is UTC milliseconds since epoch.
  // deliveryToday was constructed from local components but without offset info
  // We need to use a proper approach:

  // Actually, the cleaner approach: construct delivery UTC using the timezone offset
  const offsetMs = getTimezoneOffset(current, timezone) * 60 * 1000;
  const deliveryUtc = deliveryToday.getTime() + offsetMs;

  // Delivery is due if it's within the last checkWindowMinutes
  const diffMs = currentMs - deliveryUtc;
  return diffMs >= 0 && diffMs < checkWindowMinutes * 60 * 1000;
}

/**
 * toLocalTime converts a UTC Date to a local-timezone Date by returning a
 * representation with the local date components.
 */
function toLocalTime(date: Date, timezone: string): Date {
  // Use Intl to get the local date/time components
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  // en-CA format: YYYY-MM-DD HH:MM:SS
  const parts = formatter.formatToParts(date);
  const getPart = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);

  return new Date(
    getPart("year"),
    getPart("month") - 1,
    getPart("day"),
    getPart("hour"),
    getPart("minute"),
    getPart("second"),
  );
}

/**
 * getTimezoneOffset returns the UTC offset in minutes for the given date at the
 * given IANA timezone. E.g. for America/New_York in July this returns -240 (UTC-4).
 */
function getTimezoneOffset(date: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    timeZoneName: "short",
  });
  const parts = formatter.formatToParts(date);
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value ?? "";

  // Common short timezone offsets (best-effort from the abbreviated name)
  const offsetMap: Record<string, number> = {
    UTC: 0,
    GMT: 0,
    EST: -300,
    EDT: -240,
    CST: -360,
    CDT: -300,
    MST: -420,
    MDT: -360,
    PST: -480,
    PDT: -420,
    CET: 60,
    CEST: 120,
    EET: 120,
    EEST: 180,
    IST: 330,
    JST: 540,
    KST: 540,
    CST_ASIA: 480, // China Standard Time
    HKT: 480,
    SGT: 480,
    AEST: 600,
    AEDT: 660,
    GST: 240, // Gulf Standard Time
    MSK: 180,
    BRT: -180, // Brasilia
    ART: -180, // Argentina
    NZST: 720,
    NZDT: 780,
  };

  // The formatter's timeZoneName is GMT+5:30 or UTC or a short name
  const gmtMatch = tzName.match(/^GMT([+-])(\d+)(?::(\d+))?/);
  if (gmtMatch) {
    const sign = gmtMatch[1] === "+" ? 1 : -1;
    const h = parseInt(gmtMatch[2], 10);
    const min = parseInt(gmtMatch[3] ?? "0", 10);
    return sign * (h * 60 + min);
  }

  return offsetMap[tzName] ?? 0;
}

/**
 * computeNextSend calculates the next UTC timestamp for the given local time
 * and timezone.
 */
function computeNextSend(localTime: string, timezone: string): string {
  const [h, m] = localTime.split(":").map(Number);
  const current = now();
  const local = toLocalTime(current, timezone);

  // Compute next occurrence
  let nextLocal = new Date(local.getFullYear(), local.getMonth(), local.getDate(), h, m, 0, 0);
  if (nextLocal <= local) {
    // Already passed today — schedule for tomorrow
    nextLocal.setDate(nextLocal.getDate() + 1);
  }

  // Convert to UTC ISO string
  const offsetMs = getTimezoneOffset(current, timezone) * 60 * 1000;
  const nextUtc = new Date(nextLocal.getTime() + offsetMs);
  return nextUtc.toISOString();
}