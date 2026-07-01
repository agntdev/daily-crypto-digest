import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { fetchRelatedArticles } from "../lib/news.js";
import { getDomainStore, getDigestItem } from "../lib/storage.js";

// "More like this" — request similar articles based on a digest item.
// Reachable as an inline button on digest messages.
// Callback format: related:<digest_item_id>

const composer = new Composer<Ctx>();

// ──────────────────────────────────────────────
// Related articles callback
// ──────────────────────────────────────────────
composer.callbackQuery(/^related:/, async (ctx) => {
  await ctx.answerCallbackQuery();

  const itemId = ctx.callbackQuery.data.slice(8); // strip "related:"
  await ctx.reply("📚 Finding more articles like that...");

  // Look up the digest item for tags/source
  const kv = getDomainStore();
  const digestItem = itemId === "sample" ? null : await getDigestItem(kv, itemId);

  const tags = digestItem?.topic_tags ?? [];
  const source = digestItem?.source_name ?? undefined;

  const articles = await fetchRelatedArticles(process.env, tags, source);
  const related = articles.slice(0, 2);

  if (related.length === 0) {
    await ctx.reply("Couldn't find related articles right now. Try again later.");
    return;
  }

  for (const article of related) {
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
});

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export default composer;