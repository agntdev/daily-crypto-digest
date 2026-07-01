import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { mainMenuKeyboard, registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { getStore } from "../storage.js";
import { now } from "../clock.js";

// Register main menu items for every feature (button-first).
// These appear on the /start main menu. Sort order: lower numbers first.
registerMainMenuItem({ label: "📰 My Digest", data: "digest:show", order: 10 });
registerMainMenuItem({ label: "⏰ Change time", data: "time:change", order: 20 });
registerMainMenuItem({ label: "📝 Sample", data: "digest:sample", order: 30 });
registerMainMenuItem({ label: "✋ Stop digest", data: "unsubscribe", order: 40 });
registerMainMenuItem({ label: "💬 Feedback", data: "feedback", order: 50 });

const composer = new Composer<Ctx>();

// Welcome text for returning users
const WELCOME =
  "👋 Welcome to your Daily Crypto Digest.\n\n" +
  "Get 1–3 curated crypto news summaries every day at your chosen time.";

// Onboarding text
const TIMEZONE_PROMPT =
  "Let’s get you set up.\n\n" +
  "What’s your timezone? Tap one below or type a city (e.g. “Berlin”).";

const TIME_PROMPT =
  "What time would you like your daily digest?\n\n" +
  "Type a 24-hour time (e.g. “09:00”).";

const CONFIRM_TEXT =
  "Here’s your subscription:\n\n" +
  "Timezone: {tz}\n" +
  "Delivery time: {time}\n\n" +
  "Shall I start sending your daily digest?";

const ONBOARDING_DONE =
  "You’re all set! ✅\n\n" +
  "You’ll receive your first digest at {time} {tz}.\n" +
  "Tap /start anytime to manage your subscription.";

// Common timezone options with their IANA names
const TIMEZONE_OPTIONS = [
  { label: "UTC", data: "tz:UTC" },
  { label: "New York", data: "tz:America/New_York" },
  { label: "London", data: "tz:Europe/London" },
  { label: "Berlin", data: "tz:Europe/Berlin" },
  { label: "Dubai", data: "tz:Asia/Dubai" },
  { label: "Tokyo", data: "tz:Asia/Tokyo" },
  { label: "Singapore", data: "tz:Asia/Singapore" },
  { label: "Sydney", data: "tz:Australia/Sydney" },
];

function timezoneKeyboard() {
  const rows: ReturnType<typeof inlineButton>[][] = [];
  for (let i = 0; i < TIMEZONE_OPTIONS.length; i += 2) {
    rows.push([
      inlineButton(TIMEZONE_OPTIONS[i].label, TIMEZONE_OPTIONS[i].data),
      ...(TIMEZONE_OPTIONS[i + 1] ? [inlineButton(TIMEZONE_OPTIONS[i + 1].label, TIMEZONE_OPTIONS[i + 1].data)] : []),
    ]);
  }
  return inlineKeyboard(rows);
}

composer.command("start", async (ctx) => {
  const store = getStore();
  const profile = ctx.from?.id ? await store.getUser(ctx.from.id) : undefined;

  if (profile && profile.subscription_status === "active") {
    // Returning user — show main menu
    await ctx.reply(WELCOME, { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (profile && profile.subscription_status === "unsubscribed") {
    // Previously unsubscribed — restart subscription
    ctx.session.step = "onboarding_timezone";
    await ctx.reply(
      "Welcome back! Let’s get your subscription set up again.\n\n" +
      "What’s your timezone?",
      { reply_markup: timezoneKeyboard() },
    );
    return;
  }

  // New user — begin onboarding
  ctx.session.step = "onboarding_timezone";
  await ctx.reply(TIMEZONE_PROMPT, { reply_markup: timezoneKeyboard() });
});

// Back to menu
composer.callbackQuery("menu:main", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(WELCOME, { reply_markup: mainMenuKeyboard() });
});

// ---- Onboarding: timezone selection via callback ----

composer.callbackQuery(/^tz:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const tz = ctx.callbackQuery.data.slice(3); // "tz:..." → "..."
  ctx.session.data = { ...ctx.session.data, timezone: tz };
  ctx.session.step = "onboarding_time";

  const profile = ctx.from?.id ? await getStore().getUser(ctx.from.id) : undefined;
  if (profile && profile.subscription_status === "unsubscribed") {
    // If this is a returning user, show their old delivery time as default
    const defaultHint = profile.delivery_time ? ` (previous: ${profile.delivery_time})` : "";
    await ctx.editMessageText(
      `Got it, timezone set to ${tz}.${defaultHint}\n\n${TIME_PROMPT}`,
    );
  } else {
    await ctx.editMessageText(
      `Got it, timezone set to ${tz}.\n\n${TIME_PROMPT}`,
    );
  }
});

// ---- Onboarding: timezone via typed city name ----

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "onboarding_timezone") return next();

  const text = ctx.message.text.trim();
  if (text.length < 2) {
    await ctx.reply("Please type a city name or tap one of the buttons above.");
    return;
  }

  // Map common city names to IANA timezone names
  const tz = guessTimezone(text);
  if (!tz) {
    await ctx.reply(
      `Couldn’t find a timezone for "${text}". Tap one of the buttons above or try another city.`,
    );
    return;
  }

  ctx.session.data = { ...ctx.session.data, timezone: tz };
  ctx.session.step = "onboarding_time";
  await ctx.reply(
    `Got it, guessed timezone as ${tz}.\n\n${TIME_PROMPT}`,
    { reply_markup: { force_reply: true, input_field_placeholder: "e.g. 09:00" } },
  );
});

// ---- Onboarding: delivery time input ----

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "onboarding_time") return next();

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

  const timeStr = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  ctx.session.data = { ...ctx.session.data, deliveryTime: timeStr };
  ctx.session.step = "onboarding_confirm";

  const tz = (ctx.session.data?.timezone as string) ?? "UTC";
  await ctx.reply(
    CONFIRM_TEXT.replace("{tz}", tz).replace("{time}", timeStr),
    {
      reply_markup: inlineKeyboard([
        [inlineButton("✅ Confirm", "onboard:confirm"), inlineButton("❌ Start over", "onboard:restart")],
      ]),
    },
  );
});

// ---- Onboarding: confirm / restart ----

composer.callbackQuery("onboard:confirm", async (ctx) => {
  await ctx.answerCallbackQuery();

  const userId = ctx.from?.id;
  if (!userId || !ctx.session.data) {
    await ctx.editMessageText("Something went wrong. Please try /start again.");
    return;
  }

  const tz = (ctx.session.data.timezone as string) ?? "UTC";
  const deliveryTime = (ctx.session.data.deliveryTime as string) ?? "09:00";
  const displayName = ctx.from?.first_name ?? "User";

  const store = getStore();

  // Check if there's an existing profile (returning user)
  const existing = await store.getUser(userId);

  await store.saveUser({
    telegram_id: userId,
    display_name: displayName,
    timezone: tz,
    delivery_time: deliveryTime,
    subscription_status: "active",
    created_at: existing?.created_at ?? now().toISOString(),
    updated_at: now().toISOString(),
  });

  await store.saveSchedule({
    user_id: userId,
    local_send_time: deliveryTime,
    next_scheduled_send: null,
  });

  await store.logEvent("subscription_activated", userId, `Subscribed with tz=${tz}, time=${deliveryTime}`);

  ctx.session.step = "idle";
  ctx.session.data = {};

  await ctx.editMessageText(
    ONBOARDING_DONE.replace("{time}", deliveryTime).replace("{tz}", tz),
  );

  // Show sample digest
  await showSampleDigest(ctx);
});

composer.callbackQuery("onboard:restart", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "onboarding_timezone";
  ctx.session.data = {};
  await ctx.editMessageText(TIMEZONE_PROMPT, { reply_markup: timezoneKeyboard() });
});

// ---- Helper: show a sample digest ----

async function showSampleDigest(ctx: Ctx): Promise<void> {
  const sample =
    "Here’s a sample of what to expect:\n\n" +
    "<b>Bitcoin Holds Above $60K as Institutional Interest Grows</b>\n" +
    "Bitcoin continues to trade above the $60,000 mark as institutional investors increase their exposure.\n" +
    "<a href=\"https://www.coindesk.com\">CoinDesk</a>\n\n" +
    "<b>Ethereum Layer-2 Solutions See Record Volumes</b>\n" +
    "Scaling solutions hit new highs in transaction volume as demand for cheaper transactions drives adoption.\n" +
    "<a href=\"https://cointelegraph.com\">CoinTelegraph</a>";

  await ctx.reply(sample, {
    parse_mode: "HTML",
    reply_markup: mainMenuKeyboard(),
  });
}

// ---- Timezone guesser ----

const CITY_TZ_MAP: Record<string, string> = {
  "new york": "America/New_York",
  nyc: "America/New_York",
  "los angeles": "America/Los_Angeles",
  la: "America/Los_Angeles",
  chicago: "America/Chicago",
  "san francisco": "America/Los_Angeles",
  london: "Europe/London",
  paris: "Europe/Paris",
  berlin: "Europe/Berlin",
  "the hague": "Europe/Amsterdam",
  amsterdam: "Europe/Amsterdam",
  madrid: "Europe/Madrid",
  rome: "Europe/Rome",
  zurich: "Europe/Zurich",
  dubai: "Asia/Dubai",
  tokyo: "Asia/Tokyo",
  singapore: "Asia/Singapore",
  hong: "Asia/Hong_Kong",
  hongkong: "Asia/Hong_Kong",
  shanghai: "Asia/Shanghai",
  beijing: "Asia/Shanghai",
  sydney: "Australia/Sydney",
  melbourne: "Australia/Melbourne",
  mumbai: "Asia/Kolkata",
  delhi: "Asia/Kolkata",
  kolkata: "Asia/Kolkata",
  seoul: "Asia/Seoul",
  bangkok: "Asia/Bangkok",
  istanbul: "Europe/Istanbul",
  moscow: "Europe/Moscow",
  sao: "America/Sao_Paulo",
  "sao paulo": "America/Sao_Paulo",
  "buenos aires": "America/Argentina/Buenos_Aires",
  toronto: "America/Toronto",
  vancouver: "America/Vancouver",
  "mexico city": "America/Mexico_City",
};

function guessTimezone(city: string): string | null {
  const key = city.toLowerCase().trim();
  if (CITY_TZ_MAP[key]) return CITY_TZ_MAP[key];
  // Try partial match
  for (const [name, tz] of Object.entries(CITY_TZ_MAP)) {
    if (name.includes(key) || key.includes(name)) return tz;
  }
  return null;
}

export default composer;
