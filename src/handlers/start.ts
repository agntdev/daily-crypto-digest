import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { mainMenuKeyboard, registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { getUserProfile, upsertUserProfile, logActivity } from "../lib/data.js";
import { initializeSchedule } from "./delivery.js";
import { now } from "../lib/clock.js";

/**
 * /start handler — onboarding, reconfiguration, and the main menu.
 * Voice: professional and concise.
 *
 * Flow:
 * 1. Greet the user
 * 2. If new (no profile), start onboarding: timezone + delivery time
 * 3. Confirm subscription
 * 4. Show main menu
 */

// Register top-level main-menu buttons so users can reach features by tapping.
registerMainMenuItem({ label: "📬 Sample digest", data: "menu:sample", order: 10 });
registerMainMenuItem({ label: "⏰ Set time", data: "menu:time", order: 20 });
registerMainMenuItem({ label: "💬 Feedback", data: "menu:feedback", order: 30 });
registerMainMenuItem({ label: "⏹️ Stop digest", data: "menu:unsubscribe", order: 40 });

const composer = new Composer<Ctx>();

const WELCOME =
  "👋 Welcome to Crypto Digest.\n\n" +
  "I deliver 1–3 curated crypto news summaries each day at your preferred time. Tap a button to get started.";

composer.command("start", async (ctx) => {
  const tgId = ctx.from?.id;
  if (!tgId) {
    await ctx.reply(WELCOME, { reply_markup: mainMenuKeyboard() });
    return;
  }

  const existing = await getUserProfile(tgId);

  if (existing) {
    // Returning user — show menu
    const timeDisplay = existing.deliveryTime || "not set";
    await ctx.reply(
      `Welcome back${existing.displayName ? ", " + existing.displayName : ""}. Your digest is scheduled for ${timeDisplay} (${existing.timezone || "UTC"}).\n\nWhat would you like to do?`,
      { reply_markup: mainMenuKeyboard() },
    );
  } else {
    // New user — onboarding
    // Step 1: Detect timezone from Telegram user data if available, else default to UTC
    // Telegram doesn't expose user timezone directly, so we default to UTC and let the user change it.
    const displayName = ctx.from?.first_name || "there";
    const tz = "UTC";

    await ctx.reply(
      `Hi ${displayName}, welcome to Crypto Digest.\n\n` +
        "I'll send you 1–3 curated crypto news summaries each day. First, let's set your delivery time.",
    );

    // Create profile immediately with defaults
    await upsertUserProfile({
      telegramId: tgId,
      displayName,
      timezone: tz,
      deliveryTime: "09:00",
      subscriptionStatus: "active",
      createdAt: now().getTime(),
      updatedAt: now().getTime(),
    });

    await logActivity({
      eventType: "onboarding",
      timestamp: now().getTime(),
      userId: tgId,
      details: `New user onboarded: ${displayName}`,
    });

    // Now let them pick a delivery time
    ctx.session.step = "awaiting_time";
    await ctx.reply(
      "At what local time should I send your daily digest? Tap a preset or type your own time (e.g., /time 08:30).",
      {
        reply_markup: timePresetKeyboard(),
      },
    );
  }
});

// "Back to menu" — re-render the main menu in place from any sub-view.
composer.callbackQuery("menu:main", async (ctx) => {
  await ctx.answerCallbackQuery();
  const tgId = ctx.from?.id;
  const existing = tgId ? await getUserProfile(tgId) : undefined;
  if (existing) {
    const timeDisplay = existing.deliveryTime || "not set";
    await ctx.editMessageText(
      `Welcome back${existing.displayName ? ", " + existing.displayName : ""}. Your digest is scheduled for ${timeDisplay} (${existing.timezone || "UTC"}).\n\nWhat would you like to do?`,
      { reply_markup: mainMenuKeyboard() },
    );
  } else {
    await ctx.editMessageText(WELCOME, { reply_markup: mainMenuKeyboard() });
  }
});

// Time preset selection via callback
composer.callbackQuery(/^time_preset:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  // Data format: time_preset:HH:MM — take everything after the first colon
  const time = ctx.callbackQuery.data.slice("time_preset:".length);
  const tgId = ctx.from?.id;
  if (!tgId) return;

  const profile = await getUserProfile(tgId);
  if (!profile) return;

  profile.deliveryTime = time;
  profile.updatedAt = now().getTime();
  await upsertUserProfile(profile);

  // Initialize the delivery schedule so the cron job knows when to send
  await initializeSchedule(tgId, time);

  ctx.session.step = undefined;

  await logActivity({
    eventType: "time_change",
    timestamp: now().getTime(),
    userId: tgId,
    details: `Delivery time set to ${time}`,
  });

  await ctx.editMessageText(
    `Your digest is now scheduled for ${time} (${profile.timezone}).\n\nI'll send you 1–3 curated summaries at that time each day.`,
    { reply_markup: mainMenuKeyboard() },
  );
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

export default composer;