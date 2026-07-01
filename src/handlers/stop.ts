import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  registerMainMenuItem,
  inlineButton,
  inlineKeyboard,
  confirmKeyboard,
} from "../toolkit/index.js";
import { getDomainStore, getUserProfile, unsubscribeUser } from "../lib/storage.js";

// Stop/Unsubscribe — immediate unsubscribe from daily digest.
// Reachable as a /stop command OR as a button on the main menu.

registerMainMenuItem({ label: "⏹ Stop digest", data: "unsubscribe", order: 80 });

const composer = new Composer<Ctx>();

const UNSUBSCRIBE_CONFIRM =
  "Are you sure you want to stop receiving daily crypto digests? You can re-subscribe anytime by tapping /start.";

const UNSUBSCRIBED =
  "✅ You've been unsubscribed from the daily digest. No more messages will be sent.\n\nTap /start if you ever want to come back.";

const NOT_SUBSCRIBED =
  "You're not currently subscribed to the daily digest. Tap /start to get started!";

// ──────────────────────────────────────────────
// /stop command
// ──────────────────────────────────────────────
composer.command("stop", async (ctx) => {
  const kv = getDomainStore();
  const profile = await getUserProfile(kv, ctx.from!.id);

  if (!profile || profile.subscription_status !== "active") {
    await ctx.reply(NOT_SUBSCRIBED);
    return;
  }

  await ctx.reply(UNSUBSCRIBE_CONFIRM, {
    reply_markup: confirmKeyboard("unsubscribe", { yes: "✅ Yes, stop", no: "🔙 Keep it" }),
  });
});

// ──────────────────────────────────────────────
// Unsubscribe button from main menu
// ──────────────────────────────────────────────
composer.callbackQuery("unsubscribe", async (ctx) => {
  await ctx.answerCallbackQuery();

  const kv = getDomainStore();
  const profile = await getUserProfile(kv, ctx.from!.id);

  if (!profile || profile.subscription_status !== "active") {
    await ctx.editMessageText(NOT_SUBSCRIBED);
    return;
  }

  await ctx.editMessageText(UNSUBSCRIBE_CONFIRM, {
    reply_markup: confirmKeyboard("unsubscribe", { yes: "✅ Yes, stop", no: "🔙 Keep it" }),
  });
});

// ──────────────────────────────────────────────
// Confirm unsubscribe
// ──────────────────────────────────────────────
composer.callbackQuery("unsubscribe:yes", async (ctx) => {
  await ctx.answerCallbackQuery();
  const kv = getDomainStore();
  await unsubscribeUser(kv, ctx.from!.id);

  await ctx.editMessageText(UNSUBSCRIBED, {
    reply_markup: inlineKeyboard([[inlineButton("📥 Resubscribe", "onboarding:start")]]),
  });
});

// ──────────────────────────────────────────────
// Cancel unsubscribe
// ──────────────────────────────────────────────
composer.callbackQuery("unsubscribe:no", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("✅ Subscription unchanged — you'll keep receiving your daily digests.", {
    reply_markup: inlineKeyboard([[inlineButton("⬅️ Menu", "menu:main")]]),
  });
});

export default composer;