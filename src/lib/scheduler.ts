/**
 * Scheduled delivery engine.
 *
 * Runs a per-minute tick that checks every user's preferred delivery time
 * against the current time in their timezone. When matched, fetches crypto
 * news and sends each article as a separate message with inline buttons.
 *
 * DEDUPLICATION: tracks last_delivered_date per user so the same user does not
 * receive duplicate digests within the same calendar day (their local timezone).
 *
 * Uses injectable `now()` from clock.ts so time-based behavior is testable.
 */

import type { Bot } from "grammy";
import { now, formatHHMM, formatYYYYMMDD } from "./clock.js";
import { fetchNewsArticles, type NewsArticle } from "./news.js";
import {
  appendActivityLog,
  getDomainStore,
  getUserProfile,
  getScheduledUserIds,
  getAdminChatId,
  getSummaryLengthLimit,
  getSourcePriorities,
  setLastDeliveredDate,
  getLastDeliveredDate,
  saveDigestItem,
  computeNextScheduledSend,
  setNextScheduledSend,
  type KVStore,
} from "./storage.js";
import { urlButton, inlineKeyboard } from "../toolkit/index.js";

/**
 * Safe-send helper: attempts to send a message to a user, but tolerates 403
 * (user never started / blocked the bot) without aborting the delivery loop.
 */
async function safeSend(
  bot: { api: { sendMessage: (chatId: number, text: string, extra?: Record<string, unknown>) => Promise<unknown> } },
  chatId: number,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  try {
    await bot.api.sendMessage(chatId, text, extra);
    return true;
  } catch (err: unknown) {
    const e = err as { error_code?: number; description?: string };
    if (e.error_code === 403) {
      return false;
    }
    console.error(`[delivery] failed to send to ${chatId}:`, e.description ?? e);
    return false;
  }
}

/**
 * Send an error alert to the configured admin chat (best-effort).
 */
async function sendAdminAlert(
  bot: { api: { sendMessage: (chatId: number, text: string, extra?: Record<string, unknown>) => Promise<unknown> } },
  kv: KVStore,
  message: string,
): Promise<void> {
  const adminChatId = await getAdminChatId(kv);
  if (!adminChatId) return;
  try {
    await bot.api.sendMessage(adminChatId, `⚠️ ${message}`, { parse_mode: "HTML" });
  } catch {
    // Non-fatal
  }
}

/**
 * Truncate description to the configured summary length limit.
 */
async function truncateDescription(kv: KVStore, text: string): Promise<string> {
  const limit = await getSummaryLengthLimit(kv);
  if (text.length <= limit) return text;
  return text.slice(0, limit).replace(/\s+\S*$/, "") + "…";
}

/**
 * Apply source priorities to articles: sort so that articles from higher-priority
 * sources appear first.
 */
async function prioritizeArticles(
  kv: KVStore,
  articles: NewsArticle[],
): Promise<NewsArticle[]> {
  const priorities = await getSourcePriorities(kv);
  if (priorities.length === 0) return articles;

  const scored = articles.map((a) => {
    const idx = priorities.findIndex(
      (p) => a.source_name.toLowerCase().includes(p.toLowerCase()) || p.toLowerCase().includes(a.source_name.toLowerCase()),
    );
    return { article: a, score: idx >= 0 ? idx : priorities.length };
  });
  scored.sort((a, b) => a.score - b.score);
  return scored.map((s) => s.article);
}

/**
 * Run one delivery tick. Called every 30s by the scheduler.
 * Uses the scheduledUsers index by HH:MM so it only loads profiles for
 * the current time slot — NOT all users.
 */
export async function deliveryTick(
  bot: { api: { sendMessage: (chatId: number, text: string, extra?: Record<string, unknown>) => Promise<unknown> } },
  kv?: KVStore,
): Promise<void> {
  const store = kv ?? getDomainStore();
  const tickDate = now();

  // Determine current HH:MM in every possible timezone is impossible upfront.
  // Instead we iterate through all delivery-time slots and check which ones match
  // the current time in UTC (the reference). Since delivery_time is stored as HH:MM
  // in the user's timezone, we need to check each timezone individually.
  // For efficiency, we first get all time slots that have users scheduled.
  // Then we check each slot if any user's local time matches.
  // This is still O(slots * users_per_slot) worst-case but avoids loading
  // ALL users. With small numbers of time slots, this is efficient.

  // We'll iterate through the known time slots. Since we can't list all slots
  // (no keyspace scan), we check all possible delivery times against the index.
  // The known times are the ones we support in onboarding.
  const SUPPORTED_TIMES = ["08:00", "09:00", "12:00", "18:00", "20:00"];

  for (const hhmm of SUPPORTED_TIMES) {
    const userIds = await getScheduledUserIds(store, hhmm);
    if (userIds.length === 0) continue;

    for (const uid of userIds) {
      const profile = await getUserProfile(store, uid);
      if (!profile || profile.subscription_status !== "active") continue;

      // Check the user's local time matches their delivery time
      const userNowHHMM = formatHHMM(tickDate, profile.timezone);
      if (userNowHHMM !== profile.delivery_time) continue;

      // DEDUP: skip if already delivered today in the user's timezone
      const todayDate = formatYYYYMMDD(tickDate, profile.timezone);
      const lastDelivered = await getLastDeliveredDate(store, uid);
      if (lastDelivered === todayDate) continue;

      try {
        await sendDigestToUser(bot, store, uid, profile.timezone);
        // Mark as delivered today
        await setLastDeliveredDate(store, uid, todayDate);
        // Update next scheduled send
        const nextSend = computeNextScheduledSend(profile.timezone, profile.delivery_time);
        await setNextScheduledSend(store, uid, nextSend);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await appendActivityLog(store, {
          event_type: "delivery_error",
          timestamp: tickDate.toISOString(),
          user_id: uid,
          details: `Deliver tick failed: ${msg}`,
        });
        // Real-time admin alert
        await sendAdminAlert(bot, store, `Delivery failed for user ${uid}: ${msg}`);
      }
    }
  }
}

/**
 * Send a digest to a single user.
 */
async function sendDigestToUser(
  bot: { api: { sendMessage: (chatId: number, text: string, extra?: Record<string, unknown>) => Promise<unknown> } },
  kv: KVStore,
  userId: number,
  tz: string,
): Promise<void> {
  const articles = await fetchNewsArticles();
  const prioritized = await prioritizeArticles(kv, articles);
  const digests = prioritized.slice(0, 3);

  if (digests.length === 0) {
    await appendActivityLog(kv, {
      event_type: "delivery_error",
      timestamp: now().toISOString(),
      user_id: userId,
      details: "No articles available for delivery",
    });
    await sendAdminAlert(bot, kv, `No articles available for delivery to user ${userId}`);
    return;
  }

  // Persist each digest item
  let sent = 0;
  for (const article of digests) {
    const itemId = `${now().getTime()}-${userId}-${article.source_name.slice(0, 10)}`;
    await saveDigestItem(kv, {
      id: itemId,
      headline: article.title,
      summary_text: article.description,
      source_name: article.source_name,
      source_url: article.source_url,
      published_at: article.published_at,
      topic_tags: article.categories ?? ["crypto"],
    });

    const desc = await truncateDescription(kv, article.description);
    const msg =
      `<b>${escapeHtml(article.title)}</b>\n\n` +
      `${escapeHtml(desc)}\n\n` +
      `<i>Source: ${escapeHtml(article.source_name)}</i>`;

    const relatedCallback = `related:${itemId}`;

    const wasSent = await safeSend(bot, userId, msg, {
      parse_mode: "HTML",
      reply_markup: inlineKeyboard([
        [urlButton("🔗 Open article", article.source_url)],
        [{ text: "📎 More like this", callback_data: relatedCallback }],
      ]),
    });
    if (wasSent) sent++;
  }

  await appendActivityLog(kv, {
    event_type: "delivery",
    timestamp: now().toISOString(),
    user_id: userId,
    details: `Delivered ${sent}/${digests.length} articles`,
  });

  if (sent === 0) {
    await appendActivityLog(kv, {
      event_type: "delivery_error",
      timestamp: now().toISOString(),
      user_id: userId,
      details: `Failed to send any articles to user ${userId}`,
    });
    await sendAdminAlert(bot, kv, `Failed to send any articles to user ${userId}`);
    return;
  }

  // Daily delivery confirmation message (Blueprint: Notifications)
  const confirmMsg = `✅ Your daily crypto digest has arrived — ${sent} articles for today. Tap any link to read the full story.`;
  await safeSend(bot, userId, confirmMsg);

  if (sent < digests.length) {
    await appendActivityLog(kv, {
      event_type: "delivery_error",
      timestamp: now().toISOString(),
      user_id: userId,
      details: `Partial delivery: ${sent}/${digests.length} sent to user ${userId}`,
    });
    await sendAdminAlert(bot, kv, `Partial delivery for user ${userId}: ${sent}/${digests.length} articles`);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}