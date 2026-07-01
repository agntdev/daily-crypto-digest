/**
 * Scheduled delivery engine.
 *
 * Runs a per-minute tick that checks every user's preferred delivery time
 * against the current time in their timezone. When matched, fetches crypto
 * news and sends each article as a separate message with inline buttons.
 *
 * Uses injectable `now()` from clock.ts so time-based behavior is testable.
 */

import type { Bot } from "grammy";
import { now } from "./clock.js";
import { fetchNewsArticles } from "./news.js";
import {
  appendActivityLog,
  getDomainStore,
  getUserProfile,
  getAllUserIds,
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
 * Run one delivery tick. Called each minute by the scheduler.
 * Checks if any user's local time matches their delivery_time.
 */
export async function deliveryTick(
  bot: { api: { sendMessage: (chatId: number, text: string, extra?: Record<string, unknown>) => Promise<unknown> } },
  kv?: KVStore,
): Promise<void> {
  const store = kv ?? getDomainStore();
  const tickDate = now();

  const allUserIds = await getAllUserIds(store);
  if (allUserIds.length === 0) return;

  for (const uid of allUserIds) {
    const profile = await getUserProfile(store, uid);
    if (!profile || profile.subscription_status !== "active") continue;

    const userHHMM = profile.delivery_time;
    if (!userHHMM) continue;

    try {
      const userNow = new Intl.DateTimeFormat("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: profile.timezone,
      }).format(tickDate);

      if (userNow === userHHMM) {
        await sendDigestToUser(bot, store, uid);
      }
    } catch {
      continue;
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
): Promise<void> {
  const articles = await fetchNewsArticles();
  const digests = articles.slice(0, 3);

  if (digests.length === 0) {
    await appendActivityLog(kv, {
      event_type: "delivery_error",
      timestamp: new Date().toISOString(),
      user_id: userId,
      details: "No articles available for delivery",
    });
    return;
  }

  let sent = 0;
  for (const article of digests) {
    const msg =
      `<b>${escapeHtml(article.title)}</b>\n\n` +
      `${escapeHtml(article.description)}\n\n` +
      `<i>Source: ${escapeHtml(article.source_name)}</i>`;

    // Use article.source_name as a short identifier for "more like this"
    const relatedCallback = `related:${article.source_name.slice(0, 20)}`;

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
    timestamp: new Date().toISOString(),
    user_id: userId,
    details: `Delivered ${sent}/${digests.length} articles`,
  });

  if (sent < digests.length) {
    await appendActivityLog(kv, {
      event_type: "delivery_error",
      timestamp: new Date().toISOString(),
      user_id: userId,
      details: `Partial delivery: ${sent}/${digests.length} sent to user ${userId}`,
    });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}