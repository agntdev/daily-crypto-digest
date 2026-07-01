import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import type { Bot } from "grammy";
import {
  countActiveSubscribers,
  countTotalUsers,
  countDeliveriesSince,
  countFailuresSince,
  logActivity,
} from "../lib/data.js";
import { now, nowMs } from "../lib/clock.js";

/**
 * Admin reporting — generates delivery stats reports and sends them
 * to the configured admin Telegram channel.
 *
 * The admin channel is configured via ADMIN_CHAT_ID env var.
 */

const composer = new Composer<Ctx>();

/**
 * Generate and send the admin daily report.
 * Returns the report text for testing.
 */
export async function sendAdminReport(bot: Bot<Ctx>): Promise<string | null> {
  const adminChatId = process.env.ADMIN_CHAT_ID;
  if (!adminChatId) return null;

  const nowMs_ = nowMs();
  const oneDayMs = 24 * 60 * 60 * 1000;

  const totalUsers = await countTotalUsers();
  const activeUsers = await countActiveSubscribers();
  const deliveriesToday = await countDeliveriesSince(nowMs_ - oneDayMs);
  const failuresToday = await countFailuresSince(nowMs_ - oneDayMs);

  const dateStr = now().toISOString().split("T")[0];

  const report =
    `📊 Daily Digest Report — ${dateStr}\n\n` +
    `Subscribers: ${activeUsers} active / ${totalUsers} total\n` +
    `Deliveries today: ${deliveriesToday}\n` +
    `Failed deliveries: ${failuresToday}\n` +
    `Success rate: ${deliveriesToday > 0 ? Math.round(((deliveriesToday - failuresToday) / deliveriesToday) * 100) : 0}%`;

  try {
    await bot.api.sendMessage(Number(adminChatId), report);
    await logActivity({
      eventType: "delivery_sent",
      timestamp: nowMs_,
      details: `Admin report sent: ${activeUsers} active, ${deliveriesToday} deliveries`,
    });
    return report;
  } catch (err) {
    await logActivity({
      eventType: "error",
      timestamp: nowMs_,
      details: `Failed to send admin report: ${String(err)}`,
    });
    return null;
  }
}

/**
 * Send an admin error alert for failed deliveries or other issues.
 */
export async function sendAdminAlert(
  bot: Bot<Ctx>,
  message: string,
): Promise<void> {
  const adminChatId = process.env.ADMIN_CHAT_ID;
  if (!adminChatId) return;

  try {
    await bot.api.sendMessage(Number(adminChatId), `⚠️ Alert: ${message}`);
  } catch {
    // Best-effort — don't compound errors
  }
}

export default composer;