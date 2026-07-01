/**
 * Stop / unsubscribe handler — /stop command + unsubscribe callback button.
 * Registers "Stop daily digest" button on the main menu.
 */
import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { registerMainMenuItem, inlineButton, inlineKeyboard, confirmKeyboard } from "../toolkit/index.js";
import { getDomainStore } from "../storage.js";
import { nowSec } from "../clock.js";

const composer = new Composer<Ctx>();

// Register main menu button
registerMainMenuItem({
  label: "⏹ Stop daily digest",
  data: "unsubscribe",
  order: 50,
});

// ── /stop command ─────────────────────────────────────────────────────────────

composer.command("stop", async (ctx) => {
  const userId = ctx.from!.id;
  const store = getDomainStore();
  const profile = await store.getUser(userId);

  if (!profile || profile.subscription_status !== "active") {
    await ctx.reply(
      "You're not currently subscribed to the daily digest. Tap /start to subscribe.",
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
    );
    return;
  }

  await ctx.reply(
    "Are you sure you want to stop receiving the daily digest? You can resubscribe anytime with /start.",
    { reply_markup: confirmKeyboard("unsub") },
  );
});

// ── Unsubscribe button from menu ──────────────────────────────────────────────

composer.callbackQuery("unsubscribe", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from!.id;
  const store = getDomainStore();
  const profile = await store.getUser(userId);

  if (!profile || profile.subscription_status !== "active") {
    await ctx.editMessageText(
      "You're not currently subscribed. Tap /start to get started.",
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
    );
    return;
  }

  await ctx.editMessageText(
    "Are you sure you want to stop receiving the daily digest? You can resubscribe anytime with /start.",
    { reply_markup: confirmKeyboard("unsub") },
  );
});

// ── Unsubscribe confirmation ──────────────────────────────────────────────────

composer.callbackQuery(/^unsub:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const action = ctx.callbackQuery.data.split(":")[1];

  if (action === "no") {
    await ctx.editMessageText("Glad to keep you onboard! Your daily digest is still active.", {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
    });
    return;
  }

  // yes — unsubscribe
  const userId = ctx.from!.id;
  const store = getDomainStore();
  const profile = await store.getUser(userId);
  if (profile) {
    profile.subscription_status = "unsubscribed";
    await store.setUser(userId, profile);
  }
  // Remove schedule
  await store.deleteSchedule(userId);

  // Log the activity
  await store.addLog({
    id: `unsub-${userId}-${nowSec()}`,
    event_type: "unsubscribe",
    timestamp: nowSec(),
    user_id: userId,
    details: "User unsubscribed via button/command",
  });

  ctx.session.step = "unsubscribed";

  await ctx.editMessageText(
    "✅ You've been unsubscribed from the daily digest.\n\n" +
    "If you'd like to resubscribe later, just tap /start.",
    { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
  );
});

export default composer;