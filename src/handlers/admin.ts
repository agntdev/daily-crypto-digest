import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { getStore } from "../storage.js";
import { now } from "../clock.js";

const composer = new Composer<Ctx>();

// /admin — owner-only admin panel (chat-scoped: only works from the configured admin chat)
composer.command("admin", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const store = getStore();
  const adminChatId = await store.getAdminChatId();

  // If no admin chat configured, the first user to /admin becomes admin
  if (!adminChatId) {
    await store.setAdminChatId(ctx.chat.id);
    await store.logEvent("admin_configured", userId, `Admin chat set to ${ctx.chat.id}`);
    await ctx.reply(
      "🔐 You're now set as the admin. This chat will receive daily reports and error alerts.",
      { reply_markup: adminKeyboard() },
    );
    return;
  }

  // Only the configured admin chat can access admin commands
  if (!ctx.chat || ctx.chat.id !== adminChatId) {
    // Silently ignore — don't confirm the existence of an admin chat
    return;
  }

  await ctx.reply(
    "🔐 Admin Panel\n\n" +
    "Manage your Daily Crypto Digest bot settings below.",
    { reply_markup: adminKeyboard() },
  );
});

function adminKeyboard() {
  return inlineKeyboard([
    [inlineButton("📊 Daily report", "admin:report")],
    [inlineButton("📰 Source priorities", "admin:sources")],
    [inlineButton("✏️ Summary length", "admin:summary_length")],
    [inlineButton("👥 User stats", "admin:users")],
    [inlineButton("⬅️ Back to menu", "menu:main")],
  ]);
}

// Admin: daily report
composer.callbackQuery("admin:report", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("Generating report…");
  const report = await generateDailyReport();
  await ctx.editMessageText(report, {
    parse_mode: "HTML",
    reply_markup: adminBackKeyboard(),
  });
});

// Admin: source priorities
composer.callbackQuery("admin:sources", async (ctx) => {
  await ctx.answerCallbackQuery();
  const store = getStore();
  const sources = await store.getNewsSourcePriorities();
  const text =
    "<b>📰 News Source Priorities</b>\n\n" +
    sources.map((s, i) => `${i + 1}. ${s}`).join("\n") +
    "\n\nTo reorder, reply with the new order as a comma-separated list (e.g. \"CoinTelegraph, CoinDesk, Decrypt\").";

  ctx.session.step = "admin_sources";
  await ctx.editMessageText(text, {
    parse_mode: "HTML",
    reply_markup: adminBackKeyboard(),
  });
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "admin_sources") return next();
  const store = getStore();
  const adminChatId = await store.getAdminChatId();
  if (!adminChatId || ctx.chat?.id !== adminChatId) return next();

  const names = ctx.message.text.split(",").map((s) => s.trim()).filter(Boolean);
  if (names.length < 1) {
    await ctx.reply("Please provide at least one source name.");
    return;
  }

  await store.setNewsSourcePriorities(names);
  ctx.session.step = "idle";
  await ctx.reply("✅ Source priorities updated.", { reply_markup: adminKeyboard() });
});

// Admin: summary length
composer.callbackQuery("admin:summary_length", async (ctx) => {
  await ctx.answerCallbackQuery();
  const store = getStore();
  const current = await store.getSummaryLengthLimit();
  ctx.session.step = "admin_summary_length";
  await ctx.editMessageText(
    `Current summary length limit: ${current} characters.\n\n` +
    "Type a new limit (100–500 characters).",
    { reply_markup: adminBackKeyboard() },
  );
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "admin_summary_length") return next();
  const store = getStore();
  const adminChatId = await store.getAdminChatId();
  if (!adminChatId || !ctx.chat || ctx.chat.id !== adminChatId) return next();

  const num = parseInt(ctx.message.text.trim(), 10);
  if (isNaN(num) || num < 100 || num > 500) {
    await ctx.reply("Please enter a number between 100 and 500.");
    return;
  }

  await store.setSummaryLengthLimit(num);
  ctx.session.step = "idle";
  await ctx.reply(`✅ Summary length limit set to ${num} characters.`, { reply_markup: adminKeyboard() });
});

// Admin: user stats
composer.callbackQuery("admin:users", async (ctx) => {
  await ctx.answerCallbackQuery();
  const store = getStore();
  const allIds = await store.getAllUserIds();
  const subIds = await store.getSubscribedUserIds();
  const text =
    "<b>👥 User Statistics</b>\n\n" +
    `Total users: ${allIds.length}\n` +
    `Active subscribers: ${subIds.length}\n` +
    `Unsubscribed: ${allIds.length - subIds.length}`;

  await ctx.editMessageText(text, {
    parse_mode: "HTML",
    reply_markup: adminBackKeyboard(),
  });
});

function adminBackKeyboard() {
  return inlineKeyboard([
    [inlineButton("⬅️ Back to admin", "admin:panel")],
    [inlineButton("⬅️ Back to menu", "menu:main")],
  ]);
}

// Admin panel "back" button handler
composer.callbackQuery("admin:panel", async (ctx) => {
  await ctx.answerCallbackQuery();
  const store = getStore();
  const adminChatId = await store.getAdminChatId();
  if (!adminChatId || ctx.chat?.id !== adminChatId) return;
  await ctx.editMessageText(
    "🔐 Admin Panel\n\nManage your Daily Crypto Digest bot settings below.",
    { reply_markup: adminKeyboard() },
  );
});

export default composer;

// ---- Daily report generator (exported for use by scheduler) ----

export async function generateDailyReport(): Promise<string> {
  const store = getStore();
  const allIds = await store.getAllUserIds();
  const subIds = await store.getSubscribedUserIds();
  const logs = await store.getRecentLogs(30);

  const todayDeliveries = logs.filter((l) => {
    if (l.event_type !== "delivery_sent") return false;
    const logDate = new Date(l.timestamp);
    const curr = now();
    return (
      logDate.getUTCFullYear() === curr.getUTCFullYear() &&
      logDate.getUTCMonth() === curr.getUTCMonth() &&
      logDate.getUTCDate() === curr.getUTCDate()
    );
  });

  const errors = logs.filter((l) => l.event_type === "delivery_error" || l.event_type === "api_error");

  return (
    "<b>📊 Daily Admin Report</b>\n\n" +
    `Active subscribers: ${subIds.length}\n` +
    `Total users: ${allIds.length}\n` +
    `Deliveries sent today: ${todayDeliveries.length}\n` +
    `Recent errors: ${errors.length}\n\n` +
    `<b>Recent Activity:</b>\n` +
    logs
      .slice(-10)
      .reverse()
      .map((l) => `• ${new Date(l.timestamp).toLocaleString()} — ${l.event_type}: ${l.details.length > 50 ? l.details.slice(0, 50) + "…" : l.details}`)
      .join("\n")
  );
}