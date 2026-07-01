import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { registerMainMenuItem, inlineButton, inlineKeyboard, menuKeyboard } from "../toolkit/index.js";
import { getDomainStore, getUserProfile, saveUserProfile } from "../lib/storage.js";
import { now } from "../lib/clock.js";

// /time — change delivery time preference
// Reachable as a command or a button on the main menu.

registerMainMenuItem({ label: "⏰ Change time", data: "change_time", order: 30 });

const composer = new Composer<Ctx>();

const DELIVERY_TIMES = [
  { text: "🌅 8:00 AM", data: "time:08:00" },
  { text: "🌞 12:00 PM", data: "time:12:00" },
  { text: "🌆 6:00 PM", data: "time:18:00" },
  { text: "🌙 8:00 PM", data: "time:20:00" },
];

// ──────────────────────────────────────────────
// /time command
// ──────────────────────────────────────────────
composer.command("time", async (ctx) => {
  const kv = getDomainStore();
  const profile = await getUserProfile(kv, ctx.from!.id);

  if (!profile || profile.subscription_status !== "active") {
    await ctx.reply("You're not subscribed yet. Tap /start to set up your digest first.");
    return;
  }

  ctx.session.step = "change_time";
  ctx.session.expiresAt = now().getTime() + 5 * 60 * 1000;

  const currentTime = profile.delivery_time || "not set";
  await ctx.reply(
    `Your current delivery time is ${currentTime}. Pick a new time for your daily digest:`,
    {
      reply_markup: menuKeyboard(
        DELIVERY_TIMES.map((t) => ({ text: t.text, data: t.data })),
        2,
      ),
    },
  );
});

// ──────────────────────────────────────────────
// Change time button from main menu
// ──────────────────────────────────────────────
composer.callbackQuery("change_time", async (ctx) => {
  await ctx.answerCallbackQuery();
  const kv = getDomainStore();
  const profile = await getUserProfile(kv, ctx.from!.id);

  if (!profile || profile.subscription_status !== "active") {
    await ctx.editMessageText(
      "You're not subscribed yet. Tap /start to set up your digest first.",
    );
    return;
  }

  ctx.session.step = "change_time";

  await ctx.editMessageText("Pick a new time for your daily digest:", {
    reply_markup: menuKeyboard(
      DELIVERY_TIMES.map((t) => ({ text: t.text, data: t.data })),
      2,
    ),
  });
});

// ──────────────────────────────────────────────
// Time selection (shared for both onboarding and change_time flows)
// ──────────────────────────────────────────────
// Note: time: callbacks are also handled in start.ts for onboarding.
// We register a more specific catch here for the change_time step.
// Actually let's just handle it here for all cases.
composer.callbackQuery(/^time:/, async (ctx) => {
  await ctx.answerCallbackQuery();

  // Skip if this is an onboarding step (handled by start.ts)
  if (ctx.session.step === "onboarding_delivery_time") return;

  const time = ctx.callbackQuery.data.slice(5);
  const kv = getDomainStore();
  const profile = await getUserProfile(kv, ctx.from!.id);

  if (!profile) {
    await ctx.editMessageText("Please tap /start to set up your account first.");
    return;
  }

  profile.delivery_time = time;
  await saveUserProfile(kv, profile);

  ctx.session.step = undefined;

  await ctx.editMessageText(
    `✅ Delivery time updated to ${time}. You'll receive your daily digest at that time.`,
    {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
    },
  );
});

export default composer;