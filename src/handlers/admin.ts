import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";
import {
  getDomainStore,
  getAllUserIds,
  getUserProfile,
  setAdminChatId,
  getAdminChatId,
  type KVStore,
} from "../lib/storage.js";

// Admin reporting and owner controls.
//
// The admin chat is configured via the BOT_ADMIN_CHAT_ID env var, or an
// authenticated /admin setup command. Once configured, the daily report
// is sent to that chat.

const composer = new Composer<Ctx>();

// ──────────────────────────────────────────────
// Admin setup — /admin command
// Creates a setup flow for the bot owner.
// ──────────────────────────────────────────────
composer.command("admin", async (ctx) => {
  const kv = getDomainStore();
  const existing = await getAdminChatId(kv);

  await ctx.reply(
    "🔐 **Bot Admin Panel**\n\n" +
      `Current admin chat: ${existing ? `\`${existing}\`` : "Not configured"}\n\n` +
      "Available actions:\n" +
      "• `/admin setup` — Set this chat as the admin channel\n" +
      "• `/admin report` — Generate a delivery stats report now\n" +
      "• `/admin users` — Show user subscription stats",
    { parse_mode: "HTML" },
  );
});

// ──────────────────────────────────────────────
// Admin setup — configure this chat as admin channel
// ──────────────────────────────────────────────
composer.command("admin_setup", async (ctx) => {
  const kv = getDomainStore();
  await setAdminChatId(kv, ctx.chat!.id);
  await ctx.reply(
    "✅ This chat is now set as the admin channel. Daily reports will be sent here.",
  );
});

// ──────────────────────────────────────────────
// Admin report — generate delivery stats now
// ──────────────────────────────────────────────
composer.command("admin_report", async (ctx) => {
  await ctx.reply("📊 Generating delivery stats report...");
  const report = await generateAdminReport(getDomainStore());
  await ctx.reply(report, { parse_mode: "HTML" });
});

// ──────────────────────────────────────────────
// Admin users — show subscription stats
// ──────────────────────────────────────────────
composer.command("admin_users", async (ctx) => {
  const kv = getDomainStore();
  const allIds = await getAllUserIds(kv);
  let active = 0;
  let unsubscribed = 0;

  for (const id of allIds) {
    const profile = await getUserProfile(kv, id);
    if (profile) {
      if (profile.subscription_status === "active") active++;
      else unsubscribed++;
    }
  }

  await ctx.reply(
    `👥 **User Statistics**\n\n` +
      `Total registered: ${allIds.length}\n` +
      `Active subscribers: ${active}\n` +
      `Unsubscribed: ${unsubscribed}\n`,
    { parse_mode: "HTML" },
  );
});

// ──────────────────────────────────────────────
// Generate admin report (exported for scheduler use)
// ──────────────────────────────────────────────
export async function generateAdminReport(kv: KVStore): Promise<string> {
  const allIds = await getAllUserIds(kv);
  let active = 0;
  const timeSlots: Record<string, number> = {};

  for (const id of allIds) {
    const profile = await getUserProfile(kv, id);
    if (profile && profile.subscription_status === "active") {
      active++;
      const t = profile.delivery_time || "unknown";
      timeSlots[t] = (timeSlots[t] || 0) + 1;
    }
  }

  const timeBreakdown = Object.entries(timeSlots)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([time, count]) => `  ${time}: ${count} subscriber(s)`)
    .join("\n");

  return (
    `📊 **Daily Admin Report**\n\n` +
    `👥 Total registered users: ${allIds.length}\n` +
    `✅ Active subscribers: ${active}\n` +
    `⏰ **Delivery time breakdown:**\n${timeBreakdown || "  None"}\n\n` +
    `_Report generated automatically._`
  );
}

/**
 * Send the daily admin report to the configured admin chat.
 * Returns true if sent, false if no admin chat is configured.
 */
export async function sendAdminReport(
  bot: { api: { sendMessage: (chatId: number, text: string, extra?: Record<string, unknown>) => Promise<unknown> } },
  kv: KVStore,
): Promise<boolean> {
  const adminChatId = await getAdminChatId(kv);
  if (!adminChatId) return false;

  try {
    const report = await generateAdminReport(kv);
    await bot.api.sendMessage(adminChatId, report, { parse_mode: "HTML" });
    return true;
  } catch (err: unknown) {
    const e = err as { error_code?: number; description?: string };
    console.error("[admin] failed to send report:", e.description ?? e);
    return false;
  }
}

export default composer;