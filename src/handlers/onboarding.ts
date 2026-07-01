/**
 * Onboarding callbacks — timezone selection, time selection, confirmation, sample.
 * The /start command itself is in start.ts (both new and returning users).
 */
import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard, menuKeyboard } from "../toolkit/index.js";
import { getDomainStore } from "../storage.js";
import { fetchTopStories } from "../news-api.js";
import { clock, nowSec } from "../clock.js";

const composer = new Composer<Ctx>();

const TIME_SLOTS = ["07:00", "08:00", "09:00", "12:00", "17:00", "18:00", "19:00", "20:00"];

function timezoneTz(tz: string): number {
  const m = /^UTC([+-]\d+)(?::(\d+))?$/.exec(tz);
  if (!m) return 0;
  const hrs = parseInt(m[1], 10);
  const mins = m[2] ? parseInt(m[2], 10) : 0;
  const sign = hrs < 0 ? -1 : 1;
  return hrs * 3600 + sign * mins * 60;
}

// ── Timezone selection callback ────────────────────────────────────────────────

composer.callbackQuery(/^tz:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const tz = ctx.callbackQuery.data.slice(3); // "tz:UTC+8" → "UTC+8"
  const userId = ctx.from!.id;
  const store = getDomainStore();
  const displayName = ctx.from!.first_name || "there";

  ctx.session.step = "onboarding:time";

  await store.setUser(userId, {
    telegram_id: userId,
    display_name: displayName,
    timezone: tz,
    delivery_time: "09:00",
    subscription_status: "paused",
    subscribed_at: nowSec(),
    created_at: nowSec(),
  });

  const timeButtons = TIME_SLOTS.map((t) => ({
    text: t,
    data: `time:${t}`,
  }));
  await ctx.editMessageText(
    "Great! What time would you like to receive your daily digest? Pick a time below.",
    { reply_markup: menuKeyboard(timeButtons, 2) },
  );
});

// ── Time selection callback ───────────────────────────────────────────────────

composer.callbackQuery(/^time:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const time = ctx.callbackQuery.data.slice(5); // "time:08:00" → "08:00"
  const userId = ctx.from!.id;
  const store = getDomainStore();
  const profile = await store.getUser(userId);

  if (profile) {
    profile.delivery_time = time;
    profile.subscription_status = "active";
    await store.setUser(userId, profile);
  }

  // Set schedule
  const now = clock().now();
  const [h, m] = time.split(":").map(Number);
  const next = new Date(now.getTime());
  const tzOffset = timezoneTz(profile?.timezone ?? "UTC+0");
  next.setUTCHours(h - tzOffset / 3600, m, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);

  await store.setSchedule(userId, {
    user_id: userId,
    local_send_time: time,
    next_scheduled_send: Math.floor(next.getTime() / 1000),
    timezone: profile?.timezone ?? "UTC+0",
  });

  ctx.session.step = "onboarding:confirm";

  const kb = inlineKeyboard([
    [inlineButton("✅ Confirm subscription", "onboard:confirm")],
    [inlineButton("🔄 Change time", "onboard:change_time")],
    [inlineButton("Cancel", "onboard:cancel")],
  ]);

  await ctx.editMessageText(
    `Here's your subscription summary:\n\n` +
    `🕐 Timezone: ${profile?.timezone ?? "UTC+0"}\n` +
    `⏰ Daily delivery: ${time}\n\n` +
    `Tap Confirm to start receiving your daily crypto digest!`,
    { reply_markup: kb },
  );
});

// ── Onboarding confirmation callbacks ─────────────────────────────────────────

composer.callbackQuery("onboard:confirm", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from!.id;
  const store = getDomainStore();
  const profile = await store.getUser(userId);

  if (profile) {
    profile.subscription_status = "active";
    await store.setUser(userId, profile);
  }

  ctx.session.step = "onboarding:sample";

  const offerKb = inlineKeyboard([
    [inlineButton("📰 Show sample digest", "onboard:sample")],
    [inlineButton("⬅️ Back to menu", "menu:main")],
  ]);

  await ctx.editMessageText(
    "✅ You're subscribed! You'll receive your daily crypto digest at the selected time.\n\n" +
    "Want to see what it looks like? Tap below for a sample.",
    { reply_markup: offerKb },
  );
});

composer.callbackQuery("onboard:change_time", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "onboarding:time";

  const timeButtons = TIME_SLOTS.map((t) => ({
    text: t,
    data: `time:${t}`,
  }));
  await ctx.editMessageText(
    "Pick a different delivery time:",
    { reply_markup: menuKeyboard(timeButtons, 2) },
  );
});

composer.callbackQuery("onboard:cancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from!.id;
  const store = getDomainStore();
  const profile = await store.getUser(userId);
  if (profile) {
    profile.subscription_status = "unsubscribed";
    await store.setUser(userId, profile);
  }
  ctx.session.step = "idle";
  await ctx.editMessageText(
    "No problem! If you change your mind, just tap /start again.",
    { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
  );
});

// ── Sample digest ────────────────────────────────────────────────────────────

composer.callbackQuery("onboard:sample", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showSampleDigest(ctx);
  ctx.session.step = "subscribed";
});

async function showSampleDigest(ctx: Ctx): Promise<void> {
  try {
    const items = await fetchTopStories(1);

    if (items.length === 0) {
      await ctx.editMessageText(
        "📰 <b>Sample Digest</b>\n\n" +
        "Here's what your daily digest will look like:\n\n" +
        "🔹 <b>Bitcoin reaches new milestone</b>\n" +
        "   📎 Source\n" +
        "   🔗 Read more\n\n" +
        "Each summary includes a source link. Your first real digest arrives at your chosen time! 🎉",
        {
          parse_mode: "HTML",
          reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
        },
      );
      return;
    }

    const item = items[0];
    const lines = [
      "📰 <b>Sample Digest</b>\n",
      `🔹 <b>${escapeHtml(item.headline)}</b>`,
      `   📎 ${escapeHtml(item.source_name)}`,
      `   🔗 <a href="${escapeHtml(item.source_url)}">Read full article</a>\n`,
      "Your first real digest arrives at your scheduled time! 🎉",
    ];

    await ctx.editMessageText(lines.join("\n"), {
      parse_mode: "HTML",
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
    });
  } catch {
    // If API fails, show a friendly fallback sample
    await ctx.editMessageText(
      "📰 <b>Sample Digest</b>\n\n" +
      "Here's what your daily digest will look like:\n\n" +
      "🔹 <b>Bitcoin reaches new milestone</b>\n" +
      "   📎 CoinDesk\n" +
      "   🔗 Read more\n\n" +
      "Each summary includes a source link. Your first real digest arrives at your scheduled time! 🎉",
      {
        parse_mode: "HTML",
        reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
      },
    );
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export default composer;