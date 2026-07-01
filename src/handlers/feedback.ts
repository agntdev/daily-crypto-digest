import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { getStore } from "../storage.js";

const composer = new Composer<Ctx>();

// Feedback — open feedback form
composer.callbackQuery("feedback", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "feedback_awaiting";

  // Check if we're editing an existing message or sending new
  if (ctx.callbackQuery.message) {
    await ctx.editMessageText(
      "💬 What's on your mind? Send me your feedback, suggestions, or report an issue.\n\n" +
      "Type your message below.",
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
    );
  } else {
    await ctx.reply(
      "💬 What's on your mind? Send me your feedback, suggestions, or report an issue.\n\n" +
      "Type your message below.",
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
    );
  }
});

// Handle feedback text input
composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "feedback_awaiting") return next();

  const text = ctx.message.text.trim();
  if (text.length < 3) {
    await ctx.reply("Please write a bit more — at least 3 characters.");
    return;
  }

  const userId = ctx.from?.id;
  const store = getStore();

  // Store the feedback
  await store.logEvent("feedback", userId ?? null, text);

  // If admin chat is configured, forward the feedback
  const adminChatId = await store.getAdminChatId();
  if (adminChatId && userId) {
    const profile = await store.getUser(userId);
    const name = profile?.display_name ?? ctx.from?.first_name ?? "Unknown";
    try {
      await ctx.api.sendMessage(
        adminChatId,
        `💬 Feedback from ${name} (${userId}):\n\n${text}`,
      );
    } catch {
      // Admin chat may not be reachable — don't break the user flow
    }
  }

  ctx.session.step = "idle";
  await ctx.reply(
    "Thanks for your feedback! 🙏\n\n" +
    "It's been sent to the team and will help us improve.",
    { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
  );
});

export default composer;