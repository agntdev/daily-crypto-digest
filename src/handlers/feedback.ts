import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { logActivity } from "../lib/data.js";
import { now } from "../lib/clock.js";

/**
 * Feedback handler — opens a feedback form in chat.
 * Triggered by the "Feedback" button or menu item.
 */

const composer = new Composer<Ctx>();

composer.callbackQuery("menu:feedback", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "awaiting_feedback";
  await ctx.editMessageText(
    "I'd love to hear from you. What feedback do you have about the digest? Just type your message below.",
    {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
    },
  );
});

// Direct callback "feedback" used on digest messages
composer.callbackQuery("feedback", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "awaiting_feedback";
  await ctx.reply(
    "I'd love to hear from you. What feedback do you have about the digest? Just type your message below.",
    {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
    },
  );
});

// Handle the actual feedback text input
composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "awaiting_feedback") return next();

  const tgId = ctx.from?.id;
  const text = ctx.message?.text?.trim() ?? "";
  if (!text) return next();

  await logActivity({
    eventType: "feedback",
    timestamp: now().getTime(),
    userId: tgId,
    details: `User feedback: ${text.slice(0, 500)}`,
  });

  ctx.session.step = undefined;

  await ctx.reply(
    "Thanks for your feedback — it helps make the digest better for everyone.\n\nTap a button to continue:",
    {
      reply_markup: inlineKeyboard([
        [inlineButton("📬 Sample digest", "menu:sample")],
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    },
  );
});

export default composer;