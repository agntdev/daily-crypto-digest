import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { getDomainStore, getUserProfile, appendActivityLog } from "../lib/storage.js";
import { now } from "../lib/clock.js";

// Feedback — opens a feedback form in chat. Users type their feedback as a
// text message, and the bot acknowledges it (storing it for admin review).

registerMainMenuItem({ label: "💬 Feedback", data: "feedback", order: 90 });

const composer = new Composer<Ctx>();

const FEEDBACK_PROMPT =
  "We'd love to hear from you! Send a message with your thoughts, suggestions, or bug reports.";

const FEEDBACK_THANKS =
  "Thanks for your feedback! We'll review it and use it to improve the bot.";

// ──────────────────────────────────────────────
// Feedback button from main menu
// ──────────────────────────────────────────────
composer.callbackQuery("feedback", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "feedback";
  ctx.session.expiresAt = Date.now() + 5 * 60 * 1000;

  await ctx.editMessageText(FEEDBACK_PROMPT, {
    reply_markup: inlineKeyboard([[inlineButton("Cancel", "feedback:cancel")]]),
  });
});

// ──────────────────────────────────────────────
// Cancel feedback
// ──────────────────────────────────────────────
composer.callbackQuery("feedback:cancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = undefined;

  await ctx.editMessageText("Feedback cancelled.", {
    reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
  });
});

// ──────────────────────────────────────────────
// Receive feedback text
// ──────────────────────────────────────────────
composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "feedback") return next();

  const feedbackText = ctx.message.text.trim();
  ctx.session.step = undefined;

  if (feedbackText.length < 2) {
    await ctx.reply("Thanks anyway! Tap 💬 if you want to share more later.");
    return;
  }

  // Store feedback in the activity log (for admin review)
  const kv = getDomainStore();
  await appendActivityLog(kv, {
    event_type: "feedback",
    timestamp: now().toISOString(),
    user_id: ctx.from!.id,
    details: feedbackText,
  });

  await ctx.reply(FEEDBACK_THANKS, {
    reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
  });
});

export default composer;