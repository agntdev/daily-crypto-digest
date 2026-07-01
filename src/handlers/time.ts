/**
 * Time change handler — /time command + inline flow to change delivery time.
 * Registers "Change delivery time" button on the main menu.
 */
import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { registerMainMenuItem, inlineButton, inlineKeyboard, menuKeyboard } from "../toolkit/index.js";
import { getDomainStore } from "../storage.js";
import { clock } from "../clock.js";

const composer = new Composer<Ctx>();

// Register main menu button
registerMainMenuItem({
  label: "⏰ Change time",
  data: "change_time_start",
  order: 20,
});

const TIME_SLOTS = [
  "07:00", "08:00", "09:00", "10:00", "11:00", "12:00", "13:00",
  "14:00", "15:00", "16:00", "17:00", "18:00", "19:00", "20:00",
];

const COMMON_TZS = [
  "UTC-12", "UTC-11", "UTC-10", "UTC-9", "UTC-8", "UTC-7", "UTC-6", "UTC-5",
  "UTC-4", "UTC-3", "UTC-2", "UTC-1", "UTC+0", "UTC+1", "UTC+2", "UTC+3",
  "UTC+4", "UTC+5", "UTC+5:30", "UTC+6", "UTC+7", "UTC+8", "UTC+9",
  "UTC+10", "UTC+11", "UTC+12", "UTC+13", "UTC+14",
];

function timezoneTz(tz: string): number {
  const m = /^UTC([+-]\d+)(?::(\d+))?$/.exec(tz);
  if (!m) return 0;
  const hrs = parseInt(m[1], 10);
  const mins = m[2] ? parseInt(m[2], 10) : 0;
  const sign = hrs < 0 ? -1 : 1;
  return hrs * 3600 + sign * mins * 60;
}

// ── /time command ─────────────────────────────────────────────────────────────

composer.command("time", async (ctx) => {
  const userId = ctx.from!.id;
  const store = getDomainStore();
  const profile = await store.getUser(userId);

  if (!profile || profile.subscription_status !== "active") {
    await ctx.reply(
      "You need an active subscription to change the delivery time. Tap /start to subscribe first.",
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
    );
    return;
  }

  ctx.session.step = "change_time";

  const currentTime = profile.delivery_time || "09:00";
  const currentTz = profile.timezone || "UTC+0";

  // Offer timezone first, then time
  const tzButtons = COMMON_TZS.map((tz) => ({
    text: tz === currentTz ? `✓ ${tz}` : tz,
    data: `ctz:${tz}`,
  }));

  await ctx.reply(
    `Your current timezone is ${currentTz} and delivery is at ${currentTime}.\n\n` +
    "Pick a new timezone first:",
    { reply_markup: menuKeyboard(tzButtons, 3) },
  );
});

// ── Time change from menu button ─────────────────────────────────────────────

composer.callbackQuery("change_time_start", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from!.id;
  const store = getDomainStore();
  const profile = await store.getUser(userId);

  if (!profile || profile.subscription_status !== "active") {
    await ctx.editMessageText(
      "You need an active subscription to change the delivery time. Tap /start to subscribe first.",
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
    );
    return;
  }

  ctx.session.step = "change_time";

  const currentTime = profile.delivery_time || "09:00";
  const currentTz = profile.timezone || "UTC+0";

  const tzButtons = COMMON_TZS.map((tz) => ({
    text: tz === currentTz ? `✓ ${tz}` : tz,
    data: `ctz:${tz}`,
  }));

  await ctx.editMessageText(
    `Current: ${currentTz}, delivery at ${currentTime}.\n\nPick a new timezone:`,
    { reply_markup: menuKeyboard(tzButtons, 3) },
  );
});

// ── Timezone selection in change flow ─────────────────────────────────────────

composer.callbackQuery(/^ctz:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const tz = ctx.callbackQuery.data.slice(4); // "ctz:UTC+8" → "UTC+8"
  const userId = ctx.from!.id;
  const store = getDomainStore();
  const profile = await store.getUser(userId);

  if (profile) {
    profile.timezone = tz;
    await store.setUser(userId, profile);
  }

  // Show time slot picker with encoded callback data
  // Use "_" as separator between timezone and time (timezone can contain ":")
  const timeButtons = TIME_SLOTS.map((t) => ({
    text: profile?.delivery_time === t ? `✓ ${t}` : t,
    data: `ctime:${tz}__${t}`,
  }));

  await ctx.editMessageText("Now pick a new delivery time:", {
    reply_markup: menuKeyboard(timeButtons, 2),
  });
});

// ── Time selection in change flow ─────────────────────────────────────────────

composer.callbackQuery(/^ctime:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  // "ctime:UTC+5:30__08:00" → after "ctime:" → "UTC+5:30__08:00" → split on "__"
  const rest = ctx.callbackQuery.data.slice(6);
  const parts = rest.split("__");
  const tz = parts[0];
  const time = parts[1];

  const userId = ctx.from!.id;
  const store = getDomainStore();
  const profile = await store.getUser(userId);

  if (profile) {
    profile.delivery_time = time;
    profile.timezone = tz;
    await store.setUser(userId, profile);
  }

  // Update schedule
  const schedule = await store.getSchedule(userId);
  if (!schedule) {
    // Create new schedule
    const now = clock().now();
    const [h, m] = time.split(":").map(Number);
    const next = new Date(now.getTime());
    const tzOffset = timezoneTz(tz);
    next.setUTCHours(h - tzOffset / 3600, m, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    await store.setSchedule(userId, {
      user_id: userId,
      local_send_time: time,
      next_scheduled_send: Math.floor(next.getTime() / 1000),
      timezone: tz,
    });
  } else {
    const now = clock().now();
    const [h, m] = time.split(":").map(Number);
    const next = new Date(now.getTime());
    const tzOffset = timezoneTz(tz);
    next.setUTCHours(h - tzOffset / 3600, m, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    schedule.local_send_time = time;
    schedule.timezone = tz;
    schedule.next_scheduled_send = Math.floor(next.getTime() / 1000);
    await store.setSchedule(userId, schedule);
  }

  ctx.session.step = "subscribed";

  await ctx.editMessageText(
    `✅ Updated! Your daily digest will now arrive at ${time} ${tz}.`,
    { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
  );
});

export default composer;