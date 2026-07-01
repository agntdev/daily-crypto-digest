import { Composer } from "grammy";
import type { Ctx } from "../bot.js";

// /cancel — resets any active flow. Works from any step so users can escape
// a multi-step form without restarting the bot.

const composer = new Composer<Ctx>();

composer.command("cancel", async (ctx) => {
  ctx.session.step = undefined;
  ctx.session.onboarding_timezone = undefined;
  ctx.session.onboarding_delivery_time = undefined;
  ctx.session.expiresAt = undefined;

  await ctx.reply("Cancelled. Tap /start to open the menu.");
});

export default composer;