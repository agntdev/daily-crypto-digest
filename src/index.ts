import { buildBot } from "./bot.js";
import { setDefaultCommands } from "./toolkit/index.js";
import { checkAndDeliver } from "./scheduler.js";
import type { Bot } from "grammy";
import type { BotContext } from "./toolkit/index.js";

async function main() {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.error("BOT_TOKEN is required");
    process.exit(1);
  }
  const bot = await buildBot(token);
  // Publish the "/" command list to Telegram (discoverability). A button-first
  // bot exposes only /start + /help; everything else is reached via menu buttons.
  await setDefaultCommands(bot);

  // Start the daily digest scheduler: check every 6 minutes for users whose
  // delivery time has arrived.
  const SCHEDULER_INTERVAL_MS = 6 * 60 * 1000;
  setInterval(async () => {
    try {
      const result = await checkAndDeliver(bot as unknown as Bot<BotContext<Record<string, unknown>>>);
      if (result.delivered > 0 || result.errors > 0) {
        console.log(
          `[scheduler] checked=${result.checked} delivered=${result.delivered} errors=${result.errors}`,
        );
      }
    } catch (err) {
      console.error("[scheduler] error:", err);
    }
  }, SCHEDULER_INTERVAL_MS).unref();

  bot.start();
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});