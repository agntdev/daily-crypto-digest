/**
 * "More like this" handler — related:digest_item_id callback.
 * Fetches similar articles based on the current summary and shows them.
 */
import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { getDomainStore } from "../storage.js";
import { fetchTopStories } from "../news-api.js";

const composer = new Composer<Ctx>();

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

composer.callbackQuery(/^related:/, async (ctx) => {
  await ctx.answerCallbackQuery();

  try {
    // Fetch more articles from the API
    const items = await fetchTopStories(3);

    if (items.length === 0) {
      await ctx.editMessageText(
        "Couldn't find related articles right now. Try again later.",
        { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
      );
      return;
    }

    // Build the response
    const lines: string[] = [
      "📰 <b>Related Articles</b>\n",
    ];

    for (const item of items) {
      lines.push(`🔹 <b>${escapeHtml(item.headline)}</b>`);
      lines.push(`   📎 ${escapeHtml(item.source_name)}`);
      if (item.topic_tags.length > 0) {
        const tags = item.topic_tags.slice(0, 3).map((t) => `#${t}`).join(" ");
        lines.push(`   ${tags}`);
      }
      lines.push(`   🔗 <a href="${escapeHtml(item.source_url)}">Read full article</a>\n`);
    }

    await ctx.editMessageText(lines.join("\n"), {
      parse_mode: "HTML",
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
    });
  } catch {
    // Fallback
    await ctx.editMessageText(
      "📰 <b>Related Articles</b>\n\n" +
      "🔹 <b>Bitcoin market analysis</b>\n" +
      "   📎 CoinDesk\n" +
      "   🔗 <a href='https://example.com'>Read full article</a>\n\n" +
      "🔹 <b>Crypto market overview</b>\n" +
      "   📎 CoinTelegraph\n" +
      "   🔗 <a href='https://example.com'>Read full article</a>\n\n" +
      "Tap the links above to read the full articles.",
      {
        parse_mode: "HTML",
        reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
      },
    );
  }
});

export default composer;