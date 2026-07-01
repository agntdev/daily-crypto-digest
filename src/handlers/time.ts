import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { getStore } from "../storage.js";
import { now } from "../clock.js";

const composer = new Composer<Ctx>();

// /time — change delivery time preference
composer.command("time", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const store = getStore();
  const profile = await store.getUser(userId);

  if (!profile || profile.subscription_status !== "active") {
    await ctx.reply("You're not subscribed yet. Tap /start to set up first.");
    return;
  }

  ctx.session.step = "changing_time";
  await ctx.reply(
    `Your current delivery time is ${profile.delivery_time} (${profile.timezone}).\n\n` +
    "Type a new time in 24-hour format (e.g. “09:00”).",
    { reply_markup: { force_reply: true, input_field_placeholder: "e.g. 14:30" } },
  );
});

// Change time from main menu
composer.callbackQuery("time:change", async (ctx) => {
  await ctx.answerCallbackQuery();

  const userId = ctx.from?.id;
  if (!userId) return;

  const store = getStore();
  const profile = await store.getUser(userId);

  if (!profile || profile.subscription_status !== "active") {
    await ctx.editMessageText(
      "You're not subscribed yet. Tap /start to set up first.",
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
    );
    return;
  }

  ctx.session.step = "changing_time";
  await ctx.editMessageText(
    `Your current delivery time is ${profile.delivery_time} (${profile.timezone}).\n\n` +
    "Type a new time in 24-hour format (e.g. “09:00”).",
  );
});

// Handle time input
composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "changing_time") return next();

  const text = ctx.message.text.trim();
  const match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    await ctx.reply("Please enter a valid 24-hour time like “09:00” or “14:30”.");
    return;
  }

  const hh = parseInt(match[1], 10);
  const mm = parseInt(match[2], 10);
  if (hh > 23 || mm > 59) {
    await ctx.reply("Invalid time. Hours must be 0–23 and minutes 0–59.");
    return;
  }

  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("Couldn't identify you. Try /start again.");
    return;
  }

  const timeStr = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  const store = getStore();
  const profile = await store.getUser(userId);

  if (!profile) {
    await ctx.reply("Couldn't find your profile. Try /start.");
    return;
  }

  profile.delivery_time = timeStr;
  profile.updated_at = now().toISOString();
  await store.saveUser(profile);

  await store.saveSchedule({
    user_id: userId,
    local_send_time: timeStr,
    next_scheduled_send: null,
  });

  await store.logEvent("delivery_time_changed", userId, `Changed to ${timeStr} (${profile.timezone})`);

  ctx.session.step = "idle";
  await ctx.reply(
    `✅ Delivery time updated to ${timeStr} (${profile.timezone}).`,
    { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
  );
});

export default composer;