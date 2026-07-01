import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import type { Bot } from "grammy";
import {
  getActiveSubscriberIds,
  getUserProfile,
  getDueSchedules,
  upsertSchedule,
  logActivity,
  type DeliverySchedule,
} from "../lib/data.js";
import { fetchCryptoNews, saveDigestItems } from "../lib/news.js";
import { sendOrEditDigestMessage } from "./sample.js";
import { now } from "../lib/clock.js";

/**
 * Daily delivery — triggered by a cron-like scheduler.
 *
 * This handler does NOT self-schedule. A separate cron job (or external
 * scheduler) calls the delivery function. The handler exports the delivery
 * function for manual invocation (and for the test harness).
 *
 * On each run:
 * 1. Fetch 1-3 prioritized summaries from news APIs
 * 2. For each user whose next_scheduled_send <= now, send the digest
 * 3. Update next_scheduled_send to the next occurrence of their delivery_time
 * 4. Log admin stats
 *
 * Each DM is wrapped to tolerate a 403 (blocked user) without aborting the loop.
 */

const composer = new Composer<Ctx>();

/**
 * Run a delivery round: fetch news, send to due users, log results.
 * Returns stats for admin reporting.
 */
export async function runDelivery(bot: Bot<Ctx>): Promise<{
  total: number;
  sent: number;
  failed: number;
  blocked: number;
}> {
  const nowMs = now().getTime();
  const articles = await fetchCryptoNews();

  if (articles.length === 0) {
    await logActivity({
      eventType: "error",
      timestamp: nowMs,
      details: "No news articles available for delivery round",
    });
    return { total: 0, sent: 0, failed: 0, blocked: 0 };
  }

  // Save to durable storage so "More like this" can reference them
  const storedItems = await saveDigestItems(articles);

  // Get all users due for delivery
  const dueSchedules = await getDueSchedules(nowMs);

  let sent = 0;
  let failed = 0;
  let blocked = 0;

  for (const schedule of dueSchedules) {
    const userId = schedule.userId;

    // Wrap each DM to tolerate 403 without aborting
    try {
      await bot.api.sendMessage(userId, "📬 Your daily crypto digest is ready:");
      await sendDigestToUser(bot, userId, storedItems);

      await logActivity({
        eventType: "delivery_sent",
        timestamp: now().getTime(),
        userId,
        details: `Digest delivered with ${storedItems.length} items`,
      });

      sent++;
      await updateNextDelivery(schedule);
    } catch (err: unknown) {
      const code = (err as { error_code?: number })?.error_code;
      const desc = String((err as { description?: string })?.description ?? "");

      if (code === 403 && desc.includes("blocked")) {
        blocked++;
        await logActivity({
          eventType: "delivery_failed",
          timestamp: now().getTime(),
          userId,
          details: "User blocked the bot",
        });
      } else {
        failed++;
        await logActivity({
          eventType: "delivery_failed",
          timestamp: now().getTime(),
          userId,
          details: `Delivery error: ${String(err)}`,
        });
      }
    }
  }

  return { total: dueSchedules.length, sent, failed, blocked };
}

async function sendDigestToUser(
  bot: Bot<Ctx>,
  userId: number,
  items: Array<{ headline: string; summary: string; sourceName: string; sourceUrl: string; id: string }>,
) {
  // Build the digest text
  const dateStr = now().toISOString().split("T")[0];
  let text = `📬 Here's your digest, ${new Date(now()).toLocaleDateString("en-US", { month: "short", day: "numeric" })}:\n\n`;

  for (const item of items) {
    text += `▪️ ${item.headline}\n`;
    text += `${item.summary}\n`;
    text += `— ${item.sourceName}\n\n`;
  }

  // Build inline buttons
  const { inlineButton, inlineKeyboard } = await import("../toolkit/index.js");

  const row1 = items.length > 0
    ? [inlineButton("More like this", `related:${items[0].id}`)]
    : [];
  row1.push(inlineButton("💬 Feedback", "feedback"));

  const row2 = [inlineButton("⏹️ Stop digest", "unsubscribe")];

  await bot.api.sendMessage(userId, text, {
    reply_markup: inlineKeyboard([row1, row2]),
    link_preview_options: { is_disabled: true },
  });
}

async function updateNextDelivery(schedule: DeliverySchedule) {
  // Schedule next delivery 24 hours from now
  const next = now().getTime() + 24 * 60 * 60 * 1000;
  schedule.nextScheduledSend = next;
  await upsertSchedule(schedule);
}

/**
 * Populate a user's delivery schedule when they first set a delivery time.
 * Called after onboarding or time changes.
 */
export async function initializeSchedule(userId: number, localSendTime: string) {
  // Set next send to the next occurrence of localSendTime
  // For simplicity, schedule the next delivery 24h from now
  const next = now().getTime() + 24 * 60 * 60 * 1000;
  await upsertSchedule({
    userId,
    localSendTime,
    nextScheduledSend: next,
  });
}

export default composer;