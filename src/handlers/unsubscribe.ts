import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { getStore } from "../storage.js";
import { now } from "../clock.js";

const composer = new Composer<Ctx>();

// /stop — unsubscribe from daily digest
composer.command("stop", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const store = getStore();
  const profile = await store.getUser(userId);

  if (!profile || profile.subscription_status !== "active") {
    await ctx.reply(
      "You're not currently subscribed.",
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
    );
    return;
  }

  ctx.session.step = "confirm_unsubscribe";
  await ctx.reply(
    "Are you sure you want to stop receiving daily digests? You can resubscribe anytime with /start.",
    {
      reply_markup: inlineKeyboard([
        [inlineButton("✅ Yes, unsubscribe", "unsubscribe:confirm")],
        [inlineButton("❌ No, keep it", "unsubscribe:cancel")],
      ]),
    },
  );
});

// Unsubscribe from main menu button
composer.callbackQuery("unsubscribe", async (ctx) => {
  await ctx.answerCallbackQuery();

  const userId = ctx.from?.id;
  if (!userId) return;

  const store = getStore();
  const profile = await store.getUser(userId);

  if (!profile || profile.subscription_status !== "active") {
    await ctx.editMessageText(
      "You're not currently subscribed.",
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
    );
    return;
  }

  ctx.session.step = "confirm_unsubscribe";
  await ctx.editMessageText(
    "Are you sure you want to stop receiving daily digests? You can resubscribe anytime with /start.",
    {
      reply_markup: inlineKeyboard([
        [inlineButton("✅ Yes, unsubscribe", "unsubscribe:confirm")],
        [inlineButton("❌ No, keep it", "unsubscribe:cancel")],
      ]),
    },
  );
});

// Confirm unsubscribe
composer.callbackQuery("unsubscribe:confirm", async (ctx) => {
  await ctx.answerCallbackQuery();

  const userId = ctx.from?.id;
  if (!userId) return;

  const store = getStore();
  const profile = await store.getUser(userId);

  if (!profile) {
    await ctx.editMessageText("Couldn't find your profile.");
    return;
  }

  profile.subscription_status = "unsubscribed";
  profile.updated_at = now().toISOString();
  await store.saveUser(profile);

  await store.deleteSchedule(userId);
  await store.logEvent("unsubscribed", userId, "User unsubscribed via button");

  ctx.session.step = "idle";
  await ctx.editMessageText(
    "✅ You've been unsubscribed from the daily digest.\n\n" +
    "If you change your mind, tap /start to resubscribe.",
    { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
  );
});

// Cancel unsubscribe
composer.callbackQuery("unsubscribe:cancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "idle";
  await ctx.editMessageText(
    "No changes made. Your daily digest is still active.",
    { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
  );
});

export default composer;