import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { mainMenuKeyboard, inlineButton, inlineKeyboard, menuKeyboard } from "../toolkit/index.js";
import { getDomainStore } from "../storage.js";
import { nowSec } from "../clock.js";

// The /start handler renders the bot's MAIN MENU — the primary way users operate
// a button-first bot. For new users it triggers onboarding; for returning
// subscribers it shows the menu with their current settings.
const composer = new Composer<Ctx>();

const WELCOME = "👋 Welcome! Tap a button below to get started.";

const COMMON_TZS = [
  "UTC-12", "UTC-11", "UTC-10", "UTC-9", "UTC-8", "UTC-7", "UTC-6", "UTC-5",
  "UTC-4", "UTC-3", "UTC-2", "UTC-1", "UTC+0", "UTC+1", "UTC+2", "UTC+3",
  "UTC+4", "UTC+5", "UTC+5:30", "UTC+6", "UTC+7", "UTC+8", "UTC+9",
  "UTC+10", "UTC+11", "UTC+12", "UTC+13", "UTC+14",
];

composer.command("start", async (ctx) => {
  const userId = ctx.from!.id;
  const store = getDomainStore();
  const profile = await store.getUser(userId);

  if (profile && profile.subscription_status === "active") {
    // Returning subscriber
    await ctx.reply(
      `👋 Welcome back${profile.display_name ? `, ${profile.display_name}` : ""}! Your daily digest is set for ${profile.delivery_time} ${profile.timezone}.`,
      { reply_markup: mainMenuKeyboard() },
    );
    return;
  }

  // New or unsubscribed user — start onboarding
  ctx.session.step = "onboarding:timezone";

  // Try to detect timezone from Telegram
  const from = ctx.from as unknown as Record<string, unknown>;
  const telegramTz = from.time_zone as string | undefined;

  if (telegramTz) {
    const displayName = ctx.from!.first_name || "there";
    await store.setUser(userId, {
      telegram_id: userId,
      display_name: displayName,
      timezone: telegramTz,
      delivery_time: "09:00",
      subscription_status: "paused",
      subscribed_at: nowSec(),
      created_at: nowSec(),
    });

    const TIME_SLOTS = ["07:00", "08:00", "09:00", "12:00", "17:00", "18:00", "19:00", "20:00"];
    const timeButtons = TIME_SLOTS.map((t) => ({
      text: t,
      data: `time:${t}`,
    }));

    await ctx.reply(
      `👋 Welcome! I detected your timezone as ${telegramTz}. What time would you like to receive your daily crypto digest?`,
      { reply_markup: menuKeyboard(timeButtons, 2) },
    );
  } else {
    // No Telegram timezone — offer manual selection
    const tzButtons = COMMON_TZS.map((tz) => ({
      text: tz,
      data: `tz:${tz}`,
    }));

    await ctx.reply(
      "👋 Welcome! Let's get you set up.\n\n" +
      "First, what's your timezone? This helps us send the digest at the right local time for you.",
      {
        reply_markup: menuKeyboard(tzButtons, 3),
      },
    );
  }
});

// "Back to menu" — re-render the main menu in place from any sub-view.
composer.callbackQuery("menu:main", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(WELCOME, { reply_markup: mainMenuKeyboard() });
});

export default composer;