/**
 * Sample digest handler — /sample command + "Show sample" button.
 * Registers "📰 Sample digest" button on the main menu.
 *
 * Fetches 1-3 top stories from CryptoPanic and displays them as a
 * formatted digest with source attribution and links.
 */
import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { getDomainStore } from "../storage.js";
import { fetchTopStories } from "../news-api.js";
import { nowSec } from "../clock.js";

const composer = new Composer<Ctx>();

// Register main menu button
registerMainMenuItem({
  label: "📰 Sample digest",
  data: "sample",
  order: 30,
});

const MENU_BACK = inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]);

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── /sample command ──────────────────────────────────────────────────────────

composer.command("sample", async (ctx) => {
  await sendSampleDigest(ctx, ctx.reply.bind(ctx));
});

// ── Sample button from menu ─────────────────────────────────────────────────

composer.callbackQuery("sample", async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendSampleDigest(ctx, ctx.editMessageText.bind(ctx));
});

async function sendSampleDigest(
  ctx: Ctx,
  send: (text: string, extra?: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
  try {
    const items = await fetchTopStories(3);

    // Build digest message
    const lines: string[] = ["📰 <b>Today's Crypto Digest</b>\n"];

    for (const item of items) {
      lines.push(`🔹 <b>${escapeHtml(item.headline)}</b>`);
      lines.push(`   📎 ${escapeHtml(item.source_name)}`);
      if (item.topic_tags.length > 0) {
        const tags = item.topic_tags.slice(0, 3).map((t) => `#${t}`).join(" ");
        lines.push(`   ${tags}`);
      }
      lines.push(`   🔗 <a href="${escapeHtml(item.source_url)}">Read full article</a>\n`);
    }

    // Build inline buttons — "More like this" for first item, back to menu
    const rows: ReturnType<typeof inlineButton>[][] = [];
    if (items.length > 0) {
      rows.push([inlineButton("📌 More like this", `related:${items[0].id}`)]);
    }
    rows.push([inlineButton("⬅️ Back to menu", "menu:main")]);
    const buttons = inlineKeyboard(rows);

    await send(lines.join("\n"), {
      parse_mode: "HTML" as const,
      reply_markup: buttons,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Show fallback sample
    await send(
      "📰 <b>Today's Crypto Digest</b>\n\n" +
      "🔹 <b>Bitcoin reaches new milestone</b>\n" +
      "   📎 CoinDesk\n" +
      "   🔗 <a href='https://example.com'>Read full article</a>\n\n" +
      "🔹 <b>Ethereum upgrade goes live</b>\n" +
      "   📎 CoinTelegraph\n" +
      "   🔗 <a href='https://example.com'>Read full article</a>\n\n" +
      "🔹 <b>DeFi TVL reaches all-time high</b>\n" +
      "   📎 The Block\n" +
      "   🔗 <a href='https://example.com'>Read full article</a>\n\n" +
      "Each summary includes a source link so you can read the full article.",
      {
        parse_mode: "HTML" as const,
        reply_markup: MENU_BACK,
      },
    );

    // Log the failure for admin
    const store = getDomainStore();
    await store.addLog({
      id: `sample-err-${nowSec()}`,
      event_type: "sample_fetch_error",
      timestamp: nowSec(),
      user_id: ctx.from?.id ?? 0,
      details: `Failed to fetch sample digest: ${msg}`,
    });
  }
}

export default composer;