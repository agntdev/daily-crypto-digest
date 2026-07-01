import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { getUserProfile, upsertUserProfile, logActivity } from "../lib/data.js";
import { initializeSchedule } from "./delivery.js";
import { now } from "../lib/clock.js";

/**
 * /time command and "Set time" menu button — change delivery time preference.
 * Handles both preset selection via buttons and custom time entry via /time HH:MM.
 */

const composer = new Composer<Ctx>();

composer.callbackQuery("menu:time", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "awaiting_time";
  await ctx.editMessageText(
    "At what local time should I send your daily digest? Tap a preset or type your own time (e.g., /time 08:30).",
    {
      reply_markup: timePresetKeyboard(),
    },
  );
});

// /time command with optional custom time
composer.command("time", async (ctx) => {
  const tgId = ctx.from?.id;
  if (!tgId) {
    await ctx.reply("Sorry, I couldn't identify you. Try /start first.");
    return;
  }

  const profile = await getUserProfile(tgId);
  if (!profile) {
    await ctx.reply("Set up your subscription first. Tap /start to begin.");
    return;
  }

  // Check if there's a time argument
  const text = ctx.message?.text ?? "";
  const match = /^\/time(?:\s+(\d{1,2}:\d{2}))?/.exec(text.trim());

  if (match && match[1]) {
    const customTime = match[1];
    if (!isValidTime(customTime)) {
      await ctx.reply(
        "That doesn't look right. Use HH:MM format (e.g., /time 09:30). Hours: 0–23, minutes: 0–59.",
        {
          reply_markup: timePresetKeyboard(),
        },
      );
      return;
    }

    profile.deliveryTime = customTime;
    profile.updatedAt = now().getTime();
    await upsertUserProfile(profile);

    await initializeSchedule(tgId, customTime);

    await logActivity({
      eventType: "time_change",
      timestamp: now().getTime(),
      userId: tgId,
      details: `Custom delivery time set to ${customTime}`,
    });

    await ctx.reply(
      `Your digest is now scheduled for ${customTime} (${profile.timezone}).\n\nI'll send you 1–3 curated summaries at that time each day.`,
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
    );
  } else {
    // No custom time argument — show preset keyboard
    ctx.session.step = "awaiting_time";
    await ctx.reply(
      "At what local time should I send your daily digest? Tap a preset or type your own time (e.g., /time 08:30).",
      {
        reply_markup: timePresetKeyboard(),
      },
    );
  }
});

function timePresetKeyboard() {
  return inlineKeyboard([
    [
      inlineButton("🌅 08:00", "time_preset:08:00"),
      inlineButton("☀️ 09:00", "time_preset:09:00"),
      inlineButton("🕛 12:00", "time_preset:12:00"),
    ],
    [
      inlineButton("🌤 16:00", "time_preset:16:00"),
      inlineButton("🌇 18:00", "time_preset:18:00"),
      inlineButton("🌙 21:00", "time_preset:21:00"),
    ],
    [inlineButton("⬅️ Back to menu", "menu:main")],
  ]);
}

function isValidTime(time: string): boolean {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return false;
  const h = Number(match[1]);
  const m = Number(match[2]);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

export default composer;