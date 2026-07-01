import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  mainMenuKeyboard,
  inlineButton,
  inlineKeyboard,
  menuKeyboard,
} from "../toolkit/index.js";
import {
  getDomainStore,
  getUserProfile,
  saveUserProfile,
  type KVStore,
  type UserProfile,
} from "../lib/storage.js";

// The /start handler renders the bot's MAIN MENU for subscribed users, or starts
// the onboarding wizard for new users.
//
// Onboarding flow (linear wizard):
//   1. Detect/deliver timezone selection → step "onboarding_timezone"
//   2. Delivery time preference → step "onboarding_delivery_time"
//   3. Confirm subscription → step "onboarding_confirm"
//   4. Save profile, show sample, redirect to main menu
const composer = new Composer<Ctx>();

const WELCOME =
  "👋 Welcome! This bot sends you 1–3 curated crypto news summaries each day at your chosen time.";

const ONBOARDING_TIMEZONE =
  "First, let's set your timezone. Pick the one closest to you:";

const COMMON_TIMEZONES = [
  { label: "🇺🇸 ET (UTC-5)", data: "tz:America/New_York" },
  { label: "🇺🇸 CT (UTC-6)", data: "tz:America/Chicago" },
  { label: "🇺🇸 MT (UTC-7)", data: "tz:America/Denver" },
  { label: "🇺🇸 PT (UTC-8)", data: "tz:America/Los_Angeles" },
  { label: "🇬🇧 London (UTC+0)", data: "tz:Europe/London" },
  { label: "🇪🇺 CET (UTC+1)", data: "tz:Europe/Berlin" },
  { label: "🇦🇪 Dubai (UTC+4)", data: "tz:Asia/Dubai" },
  { label: "🇮🇳 India (UTC+5:30)", data: "tz:Asia/Kolkata" },
  { label: "🇨🇳 China (UTC+8)", data: "tz:Asia/Shanghai" },
  { label: "🇯🇵 Japan (UTC+9)", data: "tz:Asia/Tokyo" },
  { label: "🇦🇺 AEST (UTC+10)", data: "tz:Australia/Sydney" },
  { label: "🌐 UTC", data: "tz:UTC" },
];

const DELIVERY_TIMES = [
  { text: "🌅 8:00 AM", data: "onboard_time:08:00" },
  { text: "🌞 12:00 PM", data: "onboard_time:12:00" },
  { text: "🌆 6:00 PM", data: "onboard_time:18:00" },
  { text: "🌙 8:00 PM", data: "onboard_time:20:00" },
];

// ──────────────────────────────────────────────
// /start command
// ──────────────────────────────────────────────
composer.command("start", async (ctx) => {
  const kv = getDomainStore();
  const profile = await getUserProfile(kv, ctx.from!.id);

  if (profile && profile.subscription_status === "active") {
    // Already subscribed — show main menu
    await ctx.reply(WELCOME, { reply_markup: mainMenuKeyboard() });
    return;
  }

  // Not subscribed — start onboarding
  ctx.session.step = "onboarding_timezone";
  ctx.session.onboarding_timezone = "UTC";
  ctx.session.onboarding_delivery_time = "09:00";

  await ctx.reply(WELCOME, {
    reply_markup: inlineKeyboard([
      [inlineButton("✅ Set up daily digest", "onboarding:start")],
    ]),
  });
});

// ──────────────────────────────────────────────
// Onboarding flow — step 1: timezone
// ──────────────────────────────────────────────
composer.callbackQuery("onboarding:start", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "onboarding_timezone";
  ctx.session.expiresAt = Date.now() + 5 * 60 * 1000;
  await ctx.editMessageText(ONBOARDING_TIMEZONE, {
    reply_markup: menuKeyboard(
      COMMON_TIMEZONES.map((t) => ({ text: t.label, data: t.data })),
      2,
    ),
  });
});

composer.callbackQuery(/^tz:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.session.step !== "onboarding_timezone") return;

  const tz = ctx.callbackQuery.data.slice(3); // strip "tz:"
  ctx.session.onboarding_timezone = tz;
  ctx.session.step = "onboarding_delivery_time";

  await ctx.editMessageText(
    "Great! Now pick what time you'd like your daily digest to arrive:",
    {
      reply_markup: menuKeyboard(
        DELIVERY_TIMES.map((t) => ({ text: t.text, data: t.data })),
        2,
      ),
    },
  );
});

// ──────────────────────────────────────────────
// Onboarding flow — step 2: delivery time
// ──────────────────────────────────────────────
composer.callbackQuery(/^onboard_time:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.session.step !== "onboarding_delivery_time") {
    return;
  }

  const time = ctx.callbackQuery.data.slice(13); // strip "onboard_time:"
  ctx.session.onboarding_delivery_time = time;
  ctx.session.step = "onboarding_confirm";

  const tzLabel =
    COMMON_TIMEZONES.find((t) => t.data === `tz:${ctx.session.onboarding_timezone}`)
      ?.label ?? ctx.session.onboarding_timezone;

  await ctx.editMessageText(
    `Here's your setup:\n\n` +
      `🌍 Timezone: ${tzLabel}\n` +
      `⏰ Daily delivery: ${time}\n\n` +
      `Tap Confirm to start receiving your daily crypto digest.`,
    {
      reply_markup: inlineKeyboard([
        [
          inlineButton("✅ Confirm", "onboarding:confirm"),
          inlineButton("🔙 Back", "onboarding:timezone_back"),
        ],
      ]),
    },
  );
});

// ──────────────────────────────────────────────
// Onboarding flow — step 3: confirm
// ──────────────────────────────────────────────
composer.callbackQuery("onboarding:confirm", async (ctx) => {
  await ctx.answerCallbackQuery();
  const kv = getDomainStore();
  const tz = ctx.session.onboarding_timezone ?? "UTC";
  const deliveryTime = ctx.session.onboarding_delivery_time ?? "09:00";

  const profile: UserProfile = {
    telegram_id: ctx.from!.id,
    display_name: ctx.from!.first_name || `User ${ctx.from!.id}`,
    timezone: tz,
    delivery_time: deliveryTime,
    subscription_status: "active",
    created_at: "",
    updated_at: "",
  };

  await saveUserProfile(kv, profile);

  ctx.session.step = undefined;
  ctx.session.onboarding_timezone = undefined;
  ctx.session.onboarding_delivery_time = undefined;

  await ctx.editMessageText(
    "✅ You're all set! You'll receive your first digest at the chosen time.\n\n" +
      "Here's a preview of what to expect:",
  );

  // Show sample digest
  await sendSampleDigest(ctx, kv);
});

composer.callbackQuery("onboarding:timezone_back", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "onboarding_timezone";
  await ctx.editMessageText(ONBOARDING_TIMEZONE, {
    reply_markup: menuKeyboard(
      COMMON_TIMEZONES.map((t) => ({ text: t.label, data: t.data })),
      2,
    ),
  });
});

// ──────────────────────────────────────────────
// "Back to menu" — re-render the main menu
// ──────────────────────────────────────────────
composer.callbackQuery("menu:main", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(WELCOME, { reply_markup: mainMenuKeyboard() });
});

// ──────────────────────────────────────────────
// Reconfigure subscription — existing user re-onboards
// ──────────────────────────────────────────────
composer.callbackQuery("onboarding:reconfigure", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "onboarding_timezone";
  ctx.session.onboarding_timezone = "UTC";
  ctx.session.onboarding_delivery_time = "09:00";

  await ctx.editMessageText(ONBOARDING_TIMEZONE, {
    reply_markup: menuKeyboard(
      COMMON_TIMEZONES.map((t) => ({ text: t.label, data: t.data })),
      2,
    ),
  });
});

// ──────────────────────────────────────────────
// Sample digest helper
// ──────────────────────────────────────────────
async function sendSampleDigest(ctx: Ctx, kv: KVStore): Promise<void> {
  // Use a static sample so specs are deterministic
  const sampleArticles = [
    {
      title: "Bitcoin Holds $60K as Institutional Inflows Rise",
      description:
        "Bitcoin continues to trade above the $60,000 mark as institutional investors increase their positions.",
      source_name: "CoinDesk",
      source_url: "https://www.coindesk.com",
    },
    {
      title: "Ethereum Layer 2 Activity Surpasses Mainnet",
      description:
        "Ethereum scaling solutions now process more daily transactions than the Ethereum mainnet.",
      source_name: "The Block",
      source_url: "https://www.theblock.co",
    },
  ];

  for (const article of sampleArticles) {
    const msg =
      `<b>${escapeHtml(article.title)}</b>\n\n` +
      `${escapeHtml(article.description)}\n\n` +
      `<i>Source: ${escapeHtml(article.source_name)}</i>`;

    await ctx.reply(msg, {
      parse_mode: "HTML",
      reply_markup: inlineKeyboard([
        [inlineButton("🔗 Open article", "sample:url_dummy")],
        [inlineButton("📎 More like this", "related:sample")],
      ]),
    });
  }

  await ctx.reply("Tap /start to open the menu whenever you need it.", {
    reply_markup: mainMenuKeyboard(),
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export default composer;