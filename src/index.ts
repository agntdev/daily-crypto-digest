import { buildBot } from "./bot.js";
import { setDefaultCommands } from "./toolkit/index.js";
import { deliveryTick } from "./lib/scheduler.js";
import { getDomainStore, getAdminChatId, getAllUserIds, getUserProfile, anonymizeUser } from "./lib/storage.js";
import { generateAdminReport, sendAdminReport } from "./handlers/admin.js";
import { now } from "./lib/clock.js";

/**
 * Check for inactive users and anonymize them.
 * Runs every 24 hours. Anonymizes users whose last update was >90 days ago.
 */
async function runAnonymization(kv: ReturnType<typeof getDomainStore>): Promise<void> {
  try {
    const allIds = await getAllUserIds(kv);
    const cutoff = now().getTime() - 90 * 24 * 60 * 60 * 1000;
    let anonymized = 0;

    for (const id of allIds) {
      const profile = await getUserProfile(kv, id);
      if (!profile) continue;

      // Only anonymize unsubscribed or paused users whose last update is >90 days
      if (profile.subscription_status === "active") continue;

      const updatedAt = new Date(profile.updated_at).getTime();
      if (updatedAt < cutoff) {
        await anonymizeUser(kv, id);
        anonymized++;
      }
    }

    if (anonymized > 0) {
      console.log(`[anonymize] Anonymized ${anonymized} inactive user(s)`);
    }
  } catch (err) {
    console.error("[anonymize] Error during anonymization:", err);
  }
}

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

  // Daily admin report — fires roughly every 24h after bot starts
  const DAILY_REPORT_MS = 24 * 60 * 60 * 1000;
  const kv = getDomainStore();
  const reportTimer = setInterval(async () => {
    try {
      await sendAdminReport(bot, kv);
    } catch {
      // Non-fatal
    }
  }, DAILY_REPORT_MS);
  reportTimer.unref();

  // Daily user anonymization job (privacy — anonymize inactive users after 90 days)
  const anonymizeTimer = setInterval(async () => {
    await runAnonymization(kv);
  }, DAILY_REPORT_MS);
  anonymizeTimer.unref();

  // Send initial admin report at startup (and log startup event)
  const adminChatId = await getAdminChatId(kv);
  if (adminChatId) {
    try {
      await sendAdminReport(bot, kv);
    } catch {
      // Non-fatal
    }
  }

  // Run anonymization check at startup too
  await runAnonymization(kv);

  bot.start();
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});