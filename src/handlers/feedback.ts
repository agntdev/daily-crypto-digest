/**
 * Feedback handler — opens a feedback form, collects user text input.
 * Registers a "✉️ Feedback" button on the main menu.
 */
import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { getDomainStore } from "../storage.js";
import { nowSec } from "../clock.js";

const composer = new Composer<Ctx>();

registerMainMenuItem({
  label: "✉️ Feedback",
  data: "feedback",
  order: 60,
});

// ── Feedback button / start flow ─────────────────────────────────────────────

composer.callbackQuery("feedback", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "feedback";

  await ctx.editMessageText(
    "We'd love to hear from you! Please type your feedback, suggestions, or report an issue.\n\n" +
    "Just write your message below:",
    { reply_markup: inlineKeyboard([[inlineButton("Cancel", "feedback:cancel")]]) },
  );
});

// ── Cancel feedback ───────────────────────────────────────────────────────────

composer.callbackQuery("feedback:cancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "idle";
  await ctx.editMessageText("Feedback cancelled. Tap /start if you need anything else.", {
    reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
  });
});

// ── Collect feedback text ─────────────────────────────────────────────────────

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "feedback") return next();

  const text = ctx.message.text.trim();
  if (text.length < 3) {
    await ctx.reply("Thanks, but could you write a bit more? A few words help us improve.");
    return;
  }

  const userId = ctx.from!.id;
  const store = getDomainStore();

  // Store feedback as an activity log entry
  await store.addLog({
    id: `fb-${userId}-${nowSec()}`,
    event_type: "feedback",
    timestamp: nowSec(),
    user_id: userId,
    details: text.slice(0, 2000),
  });

  // If an admin chat is configured, forward the feedback there
  const admin = await store.getAdminConfig();
  if (admin?.admin_chat_id) {
    try {
      const name = ctx.from!.first_name || "User";
      await ctx.api.sendMessage(
        admin.admin_chat_id,
        `📬 Feedback from ${name} (${userId}):\n\n${text}`,
      );
    } catch {
      // Non-fatal: admin notification failed
    }
  }

  ctx.session.step = "subscribed";

  await ctx.reply(
    "Thank you for your feedback! We appreciate it and will use it to improve the bot.",
    { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
  );
});

export default composer;