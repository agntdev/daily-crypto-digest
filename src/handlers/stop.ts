import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { getUserProfile, upsertUserProfile, logActivity } from "../lib/data.js";
import { now } from "../lib/clock.js";

/**
 * /stop command and "Stop daily digest" button — immediate unsubscribe.
 * Unsubscribing sets subscription_status to inactive but preserves preferences
 * so the user can rejoin later via /start.
 */

const composer = new Composer<Ctx>();

const STOPPED =
  "Your daily digest is now paused. You won't receive any more summaries until you restart with /start.\n\n" +
  "Your preferences have been saved — tap /start anytime to resume.";

composer.command("stop", async (ctx) => {
  const tgId = ctx.from?.id;
  if (!tgId) {
    await ctx.reply("Sorry, I couldn't identify you. Try /start first.");
    return;
  }

  const profile = await getUserProfile(tgId);
  if (!profile) {
    await ctx.reply("You don't have an active subscription. Tap /start to set one up.");
    return;
  }

  if (profile.subscriptionStatus === "inactive") {
    await ctx.reply("Your digest is already paused. Tap /start to resume.");
    return;
  }

  profile.subscriptionStatus = "inactive";
  profile.updatedAt = now().getTime();
  await upsertUserProfile(profile);

  await logActivity({
    eventType: "unsubscribe",
    timestamp: now().getTime(),
    userId: tgId,
    details: "User unsubscribed via /stop command",
  });

  await ctx.reply(STOPPED);
});

// Button-based unsubscribe from the main menu
composer.callbackQuery("menu:unsubscribe", async (ctx) => {
  await ctx.answerCallbackQuery();
  const tgId = ctx.from?.id;
  if (!tgId) return;

  const profile = await getUserProfile(tgId);
  if (!profile) {
    await ctx.editMessageText(
      "You don't have an active subscription. Tap /start to set one up.",
    );
    return;
  }

  if (profile.subscriptionStatus === "inactive") {
    await ctx.editMessageText(
      "Your digest is already paused. Tap /start to resume.",
    );
    return;
  }

  profile.subscriptionStatus = "inactive";
  profile.updatedAt = now().getTime();
  await upsertUserProfile(profile);

  await logActivity({
    eventType: "unsubscribe",
    timestamp: now().getTime(),
    userId: tgId,
    details: "User unsubscribed via button",
  });

  await ctx.editMessageText(STOPPED, {
    reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
  });
});

// Direct callback for "Stop daily digest" button on delivery messages
composer.callbackQuery("unsubscribe", async (ctx) => {
  await ctx.answerCallbackQuery();
  const tgId = ctx.from?.id;
  if (!tgId) return;

  const profile = await getUserProfile(tgId);
  if (!profile) {
    await ctx.reply("You don't have an active subscription. Tap /start to set one up.");
    return;
  }

  if (profile.subscriptionStatus === "inactive") {
    await ctx.reply("Your digest is already paused. Tap /start to resume.");
    return;
  }

  profile.subscriptionStatus = "inactive";
  profile.updatedAt = now().getTime();
  await upsertUserProfile(profile);

  await logActivity({
    eventType: "unsubscribe",
    timestamp: now().getTime(),
    userId: tgId,
    details: "User unsubscribed via digest button",
  });

  await ctx.reply(STOPPED);
});

export default composer;