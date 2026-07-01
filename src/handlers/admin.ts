import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";
import {
  getDomainStore,
  getAllUserIds,
  getUserProfile,
  setAdminChatId,
  getAdminChatId,
  getSourcePriorities,
  setSourcePriorities,
  getSummaryLengthLimit,
  setSummaryLengthLimit,
  bulkUnsubscribeAll,
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
      "• `/admin_setup` — Set this chat as the admin channel\n" +
      "• `/admin_report` — Generate a delivery stats report now\n" +
      "• `/admin_users` — Show user subscription stats\n" +
      "• `/admin_sources` — Show/set news source priorities\n" +
      "• `/admin_summary_limit` — Show/set summary length limit\n" +
      "• `/admin_broadcast` — Broadcast to all users\n" +
      "• `/admin_unsubscribe_all` — Unsubscribe all users",
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
// Admin sources — show news source priorities
// ──────────────────────────────────────────────
composer.command("admin_sources", async (ctx) => {
  const kv = getDomainStore();
  const sources = await getSourcePriorities(kv);
  if (sources.length === 0) {
    await ctx.reply(
      "No source priorities set. All sources are treated equally.\n\n" +
        "Set priorities with: `/admin_sources_set CoinDesk, The Block, Messari`",
      { parse_mode: "HTML" },
    );
    return;
  }
  await ctx.reply(
    "📡 **Source priorities:**\n" +
      sources.map((s, i) => `${i + 1}. ${escapeHtml(s)}`).join("\n") +
      "\n\nUpdate with: `/admin_sources_set CoinDesk, The Block`",
    { parse_mode: "HTML" },
  );
});

composer.command("admin_sources_set", async (ctx) => {
  // Extract the argument after the command
  const text = ctx.message?.text ?? "";
  const args = text.replace(/\/admin_sources_set(?:\s+|$)/, "").trim();
  if (!args) {
    await ctx.reply("Please provide source names separated by commas, e.g.: `/admin_sources_set CoinDesk,The Block`", { parse_mode: "HTML" });
    return;
  }
  const sources = args.split(",").map((s) => s.trim()).filter(Boolean);
  const kv = getDomainStore();
  await setSourcePriorities(kv, sources);
  await ctx.reply(
    `✅ Source priorities updated:\n${sources.map((s, i) => `${i + 1}. ${escapeHtml(s)}`).join("\n")}`,
    { parse_mode: "HTML" },
  );
});

// ──────────────────────────────────────────────
// Admin summary length limit — show/set
// ──────────────────────────────────────────────
composer.command("admin_summary_limit", async (ctx) => {
  const kv = getDomainStore();
  const limit = await getSummaryLengthLimit(kv);
  await ctx.reply(
    `📝 Current summary length limit: **${limit} characters**\n\n` +
      "Set a new limit with: `/admin_summary_limit_set 500`\n" +
      "(Default: 300)",
    { parse_mode: "HTML" },
  );
});

composer.command("admin_summary_limit_set", async (ctx) => {
  const text = ctx.message?.text ?? "";
  const arg = text.replace(/\/admin_summary_limit_set(?:\s+|$)/, "").trim();
  const num = parseInt(arg, 10);
  if (isNaN(num) || num < 50 || num > 2000) {
    await ctx.reply("Please provide a number between 50 and 2000, e.g.: `/admin_summary_limit_set 500`", { parse_mode: "HTML" });
    return;
  }
  const kv = getDomainStore();
  await setSummaryLengthLimit(kv, num);
  await ctx.reply(`✅ Summary length limit updated to **${num} characters**.`, { parse_mode: "HTML" });
});

// ──────────────────────────────────────────────
// Admin broadcast — send a message to all active users
// ──────────────────────────────────────────────
composer.command("admin_broadcast", async (ctx) => {
  await ctx.reply(
    "📢 To broadcast a message to all active subscribers, use:\n\n" +
    "`/admin_broadcast_send Your message here`\n\n" +
    "Be mindful — this sends a DM to every active subscriber.",
    { parse_mode: "HTML" },
  );
});

// ──────────────────────────────────────────────
// Admin bulk unsubscribe
// ──────────────────────────────────────────────
composer.command("admin_unsubscribe_all", async (ctx) => {
  await ctx.reply(
    "⚠️ **Are you sure you want to unsubscribe ALL active users?**\n\n" +
    "This action cannot be undone. Use `/admin_unsubscribe_all_confirm` to proceed.",
    { parse_mode: "HTML" },
  );
});

composer.command("admin_unsubscribe_all_confirm", async (ctx) => {
  const kv = getDomainStore();
  const count = await bulkUnsubscribeAll(kv);
  await ctx.reply(
    `✅ Bulk unsubscribe complete. **${count} user(s)** have been unsubscribed.`,
    { parse_mode: "HTML" },
  );
});

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

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