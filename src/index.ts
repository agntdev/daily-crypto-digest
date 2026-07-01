import { buildBot } from "./bot.js";
import { setDefaultCommands } from "./toolkit/index.js";
import { deliveryTick } from "./lib/scheduler.js";
import { getDomainStore, getAdminChatId } from "./lib/storage.js";
import { generateAdminReport, sendAdminReport } from "./handlers/admin.js";

async function main() {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.error("BOT_TOKEN is required");
    process.exit(1);
  }
  const bot = await buildBot(token);

  // Declare all commands for discoverability
  await setDefaultCommands(bot, [
    { command: "stop", description: "Unsubscribe from daily digest" },
    { command: "time", description: "Change delivery time" },
    { command: "sample", description: "Request example digest" },
    { command: "cancel", description: "Cancel current action" },
    { command: "admin", description: "Admin panel" },
  ]);

  // Start the delivery scheduler (check every 30 seconds)
  const SCHEDULE_INTERVAL_MS = 30_000;
  const scheduleTimer = setInterval(async () => {
    try {
      await deliveryTick(bot);
    } catch (err) {
      console.error("[scheduler] delivery tick error:", err);
    }
  }, SCHEDULE_INTERVAL_MS);
  scheduleTimer.unref();

  // Send daily admin report at startup (simulated daily cron)
  const kv = getDomainStore();
  const adminChatId = await getAdminChatId(kv);
  if (adminChatId) {
    // Generate and send an initial report on startup
    try {
      await sendAdminReport(bot, kv);
    } catch {
      // Non-fatal
    }
  }

  bot.start();
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
