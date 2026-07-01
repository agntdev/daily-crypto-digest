import { buildBot } from "./bot.js";
import { setDefaultCommands } from "./toolkit/index.js";
import { startDeliveryScheduler } from "./handlers/delivery.js";

async function main() {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.error("BOT_TOKEN is required");
    process.exit(1);
  }
  const bot = await buildBot(token);
  // Publish the "/" command list to Telegram (discoverability). A button-first
  // bot exposes only /start + /help; everything else is reached via menu buttons.
  // /stop, /time, and /sample are listed as typed shortcuts for power users.
  await setDefaultCommands(bot, [
    { command: "stop", description: "Unsubscribe from daily digest" },
    { command: "time", description: "Change delivery time" },
    { command: "sample", description: "Get a sample digest now" },
  ]);

  // Start the background delivery scheduler
  startDeliveryScheduler(bot.api);

  bot.start();
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
