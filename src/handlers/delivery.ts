/**
 * Daily delivery scheduler + admin reporting.
 *
 * This handler does NOT register main menu buttons — it's a background
 * service that checks for pending deliveries and sends them.
 *
 * Uses an injectable clock via `clock()` for time decisions.
 */
import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { getDomainStore } from "../storage.js";
import { fetchTopStories } from "../news-api.js";
import { clock, nowSec } from "../clock.js";

const composer = new Composer<Ctx>();

export default composer;

// ── Background delivery check ────────────────────────────────────────────────

const CHECK_INTERVAL_MS = 60_000;

let deliveryInterval: ReturnType<typeof setInterval> | null = null;

let started = false;

/** Minimal sendMessage interface to avoid deep nesting. */
interface BotMessenger {
  sendMessage: (chatId: number, text: string, extra?: Record<string, unknown>) => Promise<unknown>;
}

function startScheduler(messenger: BotMessenger) {
  if (started) return;
  started = true;

  void checkDeliveries(messenger);

  deliveryInterval = setInterval(() => {
    void checkDeliveries(messenger);
  }, CHECK_INTERVAL_MS);
  deliveryInterval.unref?.();
}

/**
 * Check all schedules for pending deliveries. Uses an injectable clock.
 */
async function checkDeliveries(messenger: BotMessenger): Promise<void> {
  const store = getDomainStore();
  const now = nowSec();

  try {
    const userIds = await store.allScheduleUserIds();
    const processed: number[] = [];

    for (const userId of userIds) {
      const schedule = await store.getSchedule(userId);
      if (!schedule) continue;

      if (schedule.next_scheduled_send <= now) {
        try {
          await sendDigestToUser(messenger, userId);
        } catch {
          await store.addLog({
            id: `deliv-err-${userId}-${nowSec()}`,
            event_type: "delivery_error",
            timestamp: nowSec(),
            user_id: userId,
            details: "Failed to deliver digest to user",
          });
        }

        processed.push(userId);
      }
    }

    // Update schedules for processed users
    for (const userId of processed) {
      const schedule = await store.getSchedule(userId);
      if (!schedule) continue;

      const [h, m] = schedule.local_send_time.split(":").map(Number);
      const tzMatch = /^UTC([+-]\d+)/.exec(schedule.timezone || "UTC+0");
      const tzOffsetH = tzMatch ? parseInt(tzMatch[1], 10) : 0;

      const next = new Date(clock().now().getTime() + 24 * 60 * 60 * 1000);
      next.setUTCHours(h - tzOffsetH, m, 0, 0);
      schedule.next_scheduled_send = Math.floor(next.getTime() / 1000);
      await store.setSchedule(userId, schedule);
    }

    if (processed.length > 0) {
      await store.addLog({
        id: `deliv-batch-${nowSec()}`,
        event_type: "delivery_batch",
        timestamp: nowSec(),
        user_id: 0,
        details: `Delivered to ${processed.length} users`,
      });
    }
  } catch (err) {
    await store.addLog({
      id: `deliv-global-err-${nowSec()}`,
      event_type: "delivery_global_error",
      timestamp: nowSec(),
      user_id: 0,
      details: `Delivery check failed: ${err instanceof Error ? err.message : String(err)}`,
    }).catch(() => {});

    try {
      const admin = await store.getAdminConfig();
      if (admin?.admin_chat_id) {
        await messenger.sendMessage(admin.admin_chat_id, `⚠️ Delivery check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } catch {
      // Non-fatal
    }
  }
}

/**
 * Send a digest to a specific user. Wraps sendMessage to tolerate 403 (blocked).
 */
async function sendDigestToUser(
  messenger: BotMessenger,
  userId: number,
): Promise<void> {
  const store = getDomainStore();
  const profile = await store.getUser(userId);

  if (!profile || profile.subscription_status !== "active") return;

  try {
    const items = await fetchTopStories(3);

    const lines: string[] = ["📰 <b>Your Daily Crypto Digest</b>\n"];

    for (const item of items) {
      const headline = item.headline.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const sourceName = item.source_name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      lines.push(`🔹 <b>${headline}</b>`);
      lines.push(`   📎 ${sourceName}`);
      if (item.topic_tags.length > 0) {
        const tags = item.topic_tags.slice(0, 3).map((t) => `#${t}`).join(" ");
        lines.push(`   ${tags}`);
      }
      lines.push(`   🔗 <a href="${item.source_url}">Read full article</a>\n`);
    }

    const relatedData = items.length > 0 ? `related:${items[0].id}` : "menu:main";
    const row1 = items.length > 0
      ? [inlineButton("📌 More like this", relatedData)]
      : [];
    const row2 = [inlineButton("✉️ Feedback", "feedback")];
    const kb = inlineKeyboard([row1, row2]);

    await messenger.sendMessage(userId, lines.join("\n"), {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: kb,
    });

    await store.addLog({
      id: `deliv-ok-${userId}-${nowSec()}`,
      event_type: "delivery_success",
      timestamp: nowSec(),
      user_id: userId,
      details: `Delivered ${items.length} articles`,
    });
  } catch (err) {
    const msg = String(err);
    if (msg.includes("403") || msg.includes("Forbidden") || msg.includes("bot was blocked") || msg.includes("bot kicked")) {
      profile.subscription_status = "paused";
      await store.setUser(userId, profile);
      await store.deleteSchedule(userId);
      await store.addLog({
        id: `deliv-block-${userId}-${nowSec()}`,
        event_type: "user_blocked",
        timestamp: nowSec(),
        user_id: userId,
        details: "Bot blocked or user unavailable — subscription paused",
      });
      return;
    }
    throw err;
  }
}

/**
 * Generate and send an admin daily report. Call this on the daily cron trigger.
 */
export async function sendAdminReport(messenger: BotMessenger): Promise<void> {
  const store = getDomainStore();
  const admin = await store.getAdminConfig();
  if (!admin?.admin_chat_id) return;

  const userIds = await store.allUserIds();
  const activeUsers: number[] = [];
  for (const id of userIds) {
    const u = await store.getUser(id);
    if (u && u.subscription_status === "active") activeUsers.push(id);
  }

  const todayLogs = await store.getLogs(100);
  const deliveriesOk = todayLogs.filter((l) => l.event_type === "delivery_success");
  const deliveriesErr = todayLogs.filter((l) => l.event_type === "delivery_error" || l.event_type === "delivery_global_error");
  const feedbackCount = todayLogs.filter((l) => l.event_type === "feedback");

  const report = [
    "📊 <b>Daily Admin Report</b>\n",
    `👥 Total users: ${userIds.length}`,
    `✅ Active subscribers: ${activeUsers.length}`,
    `📬 Deliveries today: ${deliveriesOk.length} success, ${deliveriesErr.length} failed`,
    `✉️ New feedback: ${feedbackCount.length}`,
  ].join("\n");

  try {
    await messenger.sendMessage(admin.admin_chat_id, report, { parse_mode: "HTML" });
  } catch {
    // Non-fatal
  }
}

/**
 * Start the delivery scheduler. Call this from the main entry point.
 * The test harness does NOT call this (no real timers).
 */
export function startDeliveryScheduler(messenger: BotMessenger): void {
  startScheduler(messenger);
}