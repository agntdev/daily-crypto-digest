import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { fetchNewsArticles } from "../lib/news.js";
import { getDomainStore, saveDigestItem, getSummaryLengthLimit } from "../lib/storage.js";
import { now } from "../lib/clock.js";

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
  const kv = getDomainStore();
  const articles = await fetchNewsArticles();
  const digests = articles.slice(0, 3);

  if (digests.length === 0) {
    await ctx.reply("Couldn't fetch news right now. Try again later.");
    return;
  }

  const summaryLimit = await getSummaryLengthLimit(kv);

  for (const article of digests) {
    // Persist digest item
    const itemId = `sample-${now().getTime()}-${article.source_name.slice(0, 10)}`;
    await saveDigestItem(kv, {
      id: itemId,
      headline: article.title,
      summary_text: article.description,
      source_name: article.source_name,
      source_url: article.source_url,
      published_at: article.published_at,
      topic_tags: article.categories ?? ["crypto"],
    });

    const desc = article.description.length > summaryLimit
      ? article.description.slice(0, summaryLimit).replace(/\s+\S*$/, "") + "…"
      : article.description;

    const msg =
      `<b>${escapeHtml(article.title)}</b>\n\n` +
      `${escapeHtml(desc)}\n\n` +
      `<i>Source: ${escapeHtml(article.source_name)}</i>`;

    await ctx.reply(msg, {
      parse_mode: "HTML",
      reply_markup: inlineKeyboard([
        [inlineButton("📎 More like this", `related:${itemId}`)],
      ]),
    });
  }

  await ctx.reply("Subscribe to receive these daily at your chosen time — tap /start to set up.");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export default composer;