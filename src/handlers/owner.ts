import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";
import {
  getUserProfile,
  countActiveSubscribers,
  countTotalUsers,
  getActiveSubscriberIds,
  upsertUserProfile,
  type UserProfile,
} from "../lib/data.js";
import { now } from "../lib/clock.js";

/**
 * Owner/admin controls — reachable only by the admin whose Telegram ID
 * matches ADMIN_CHAT_ID. Provides:
 * - News source priority configuration
 * - Summary length limits
 * - Bulk subscription management
 */

// Default settings stored as simple env-based config
interface OwnerSettings {
  summaryMaxLen: number;
  sourcePriority: string[]; // ordered list of source names to prioritize
}

function getSettings(): OwnerSettings {
  return {
    summaryMaxLen: Number(process.env.SUMMARY_MAX_LEN || "200"),
    sourcePriority: (process.env.SOURCE_PRIORITIES || "CryptoPanic,CoinDesk,CoinTelegraph,The Block,Decrypt")
      .split(",")
      .map((s) => s.trim()),
  };
}

const composer = new Composer<Ctx>();

// Admin check middleware — only the configured admin can use these controls
function isAdmin(ctx: Ctx): boolean {
  const adminChatId = process.env.ADMIN_CHAT_ID;
  if (!adminChatId) return false;
  return String(ctx.from?.id) === adminChatId;
}

// /owner command — open the owner control panel
composer.command("owner", async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.reply("Sorry, this is for the bot owner only.");
    return;
  }
  await showPanel(ctx);
});

composer.callbackQuery("owner:panel", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isAdmin(ctx)) return;
  await showPanel(ctx);
});

async function showPanel(ctx: Ctx) {
  const settings = getSettings();
  const active = await countActiveSubscribers();
  const total = await countTotalUsers();

  const text =
    `⚙️ Owner Panel\n\n` +
    `Subscribers: ${active} active / ${total} total\n` +
    `Summary max length: ${settings.summaryMaxLen} chars\n` +
    `Source priority: ${settings.sourcePriority.slice(0, 3).join(", ")}\n\n` +
    `Select an option:`;

  const keyboard = inlineKeyboard([
    [inlineButton("📏 Set summary length", "owner:summary_len")],
    [inlineButton("📡 Source priorities", "owner:sources")],
    [inlineButton("👥 Manage subscriptions", "owner:subs")],
    [inlineButton("⬅️ Close", "menu:main")],
  ]);

  if (ctx.callbackQuery?.message) {
    await ctx.editMessageText(text, { reply_markup: keyboard });
  } else {
    await ctx.reply(text, { reply_markup: keyboard });
  }
}

// Set summary length — enter a new value
composer.callbackQuery("owner:summary_len", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isAdmin(ctx)) return;

  const settings = getSettings();
  await ctx.editMessageText(
    `Current summary max length: ${settings.summaryMaxLen} characters.\n\n` +
      `Reply with a number (50–500) to set the new limit.`,
    {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to panel", "owner:panel")]]),
    },
  );

  // Use session step to capture the next message
  ctx.session.step = "awaiting_summary_len" as any;
});

// Source priorities view — shows current order
composer.callbackQuery("owner:sources", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isAdmin(ctx)) return;

  const settings = getSettings();
  const text =
    `📡 Source priority order (first = highest):\n\n` +
    settings.sourcePriority
      .map((s, i) => `${i + 1}. ${s}`) +
    `\n\nTo update, set the SOURCE_PRIORITIES env variable (comma-separated).`;

  await ctx.editMessageText(text, {
    reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to panel", "owner:panel")]]),
  });
});

// Bulk subscription management — list users with pagination
composer.callbackQuery("owner:subs", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isAdmin(ctx)) return;

  const ids = await getActiveSubscriberIds();
  if (ids.length === 0) {
    await ctx.editMessageText(
      "No active subscribers yet. When users subscribe via /start, they'll appear here.",
      {
        reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to panel", "owner:panel")]]),
      },
    );
    return;
  }

  // Show up to 10 subscribers at a time
  const profiles: (UserProfile | undefined)[] = [];
  for (const id of ids.slice(0, 10)) {
    profiles.push(await getUserProfile(id));
  }

  const lines = profiles.map((p) => {
    if (!p) return "— (unknown)";
    const status = p.subscriptionStatus === "active" ? "✅" : "⏸️";
    return `${status} ${p.displayName} — ${p.deliveryTime} (${p.timezone})`;
  });

  const text =
    `👥 Active subscribers (${ids.length} total, showing first ${profiles.length}):\n\n` +
    lines.join("\n");

  const buttons = [inlineButton("⬅️ Back to panel", "owner:panel")];

  await ctx.editMessageText(text, {
    reply_markup: inlineKeyboard([buttons]),
  });
});

// Handle the summary length input
composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "awaiting_summary_len") return next();

  const text = ctx.message?.text?.trim() ?? "";
  const num = Number(text);

  if (!Number.isFinite(num) || num < 50 || num > 500 || !Number.isInteger(num)) {
    await ctx.reply(
      "Please enter a whole number between 50 and 500. Try again:",
    );
    return;
  }

  // Save the setting (in real prod, this would persist to a durable store;
  // for now we note that the env var approach means a restart is needed.)
  // We store it via a key-value so it's durable.
  const { getStore } = await import("../lib/store.js");
  await getStore().kvSet("owner:summary_max_len", num);

  ctx.session.step = undefined;

  await ctx.reply(
    `Summary max length set to ${num} characters. Note: a restart may be needed for some delivery components to pick up the change.`,
    {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to panel", "owner:panel")]]),
    },
  );
});

export default composer;