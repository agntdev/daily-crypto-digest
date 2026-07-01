import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { fetchNewsArticles } from "../lib/news.js";

// /sample — request an immediate example digest.
// Shows sample content whether or not the user is subscribed.

registerMainMenuItem({ label: "📰 Sample digest", data: "sample", order: 20 });

const composer = new Composer<Ctx>();

// ──────────────────────────────────────────────
// /sample command
// ──────────────────────────────────────────────
composer.command("sample", async (ctx) => {
  await ctx.reply("📬 Here's a sample of what your daily digest looks like:");
  await sendSampleDigest(ctx);
});

// ──────────────────────────────────────────────
// Sample digest button from main menu
// ──────────────────────────────────────────────
composer.callbackQuery("sample", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("📬 Here's a sample of what your daily digest looks like:");
  await sendSampleDigest(ctx);
});

// ──────────────────────────────────────────────
// Send sample digest
// ──────────────────────────────────────────────
async function sendSampleDigest(ctx: Ctx): Promise<void> {
  const articles = await fetchNewsArticles();
  const digests = articles.slice(0, 3);

  if (digests.length === 0) {
    await ctx.reply("Couldn't fetch news right now. Try again later.");
    return;
  }

  for (const article of digests) {
    const msg =
      `<b>${escapeHtml(article.title)}</b>\n\n` +
      `${escapeHtml(article.description)}\n\n` +
      `<i>Source: ${escapeHtml(article.source_name)}</i>`;

    await ctx.reply(msg, {
      parse_mode: "HTML",
      reply_markup: inlineKeyboard([
        [inlineButton("📎 More like this", `related:${article.source_name.slice(0, 20)}`)],
      ]),
    });
  }

  await ctx.reply("Subscribe to receive these daily at your chosen time — tap /start to set up.");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export default composer;