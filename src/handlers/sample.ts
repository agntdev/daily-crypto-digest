import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard, urlButton } from "../toolkit/index.js";
import {
  getUserProfile,
  logActivity,
} from "../lib/data.js";
import {
  fetchCryptoNews,
  saveDigestItems,
  getDigestItem,
} from "../lib/news.js";
import { now } from "../lib/clock.js";

/**
 * /sample command and "Sample digest" menu button — request an immediate
 * example digest to preview the format.
 */

const composer = new Composer<Ctx>();

// Menu button handler
composer.callbackQuery("menu:sample", async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendSampleDigest(ctx);
});

// /sample command
composer.command("sample", async (ctx) => {
  await sendSampleDigest(ctx);
});

async function sendSampleDigest(ctx: Ctx) {
  const tgId = ctx.from?.id;
  if (!tgId) {
    await ctx.reply("Sorry, I couldn't identify you. Try /start first.");
    return;
  }

  const profile = await getUserProfile(tgId);
  if (!profile) {
    await ctx.reply("Set up your subscription first. Tap /start to begin.");
    return;
  }

  // Let the user know we're fetching
  const isEdit = ctx.callbackQuery?.message?.message_id;
  if (isEdit) {
    await ctx.editMessageText("Fetching the latest crypto news…");
  } else {
    await ctx.reply("Fetching the latest crypto news…");
  }

  await logActivity({
    eventType: "sample_request",
    timestamp: now().getTime(),
    userId: tgId,
    details: "User requested sample digest",
  });

  const articles = await fetchCryptoNews();
  if (articles.length === 0) {
    const fallback = await getCachedSampleDigest();
    if (fallback) {
      await sendOrEditDigestMessage(ctx, fallback, isEdit ? ctx.callbackQuery!.message!.message_id : undefined);
      return;
    }
    const noNews =
      "No crypto news available right now. This can happen if the news APIs are temporarily unavailable. Try again in a few minutes.";
    if (isEdit) {
      await ctx.editMessageText(noNews, {
        reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
      });
    } else {
      await ctx.reply(noNews);
    }
    return;
  }

  const stored = await saveDigestItems(articles);
  await sendOrEditDigestMessage(ctx, stored, isEdit ? ctx.callbackQuery!.message!.message_id : undefined);
}

/** Get the most recently cached digest as a fallback. */
async function getCachedSampleDigest() {
  const { getRecentDigests } = await import("../lib/news.js");
  return getRecentDigests(3);
}

/**
 * Send or edit a digest message with formatted summaries and inline buttons.
 */
export async function sendOrEditDigestMessage(
  ctx: Ctx,
  items: Array<{ headline: string; summary: string; sourceName: string; sourceUrl: string; id: string }>,
  messageId?: number,
) {
  const now_ = now();
  const dateStr = now_.toISOString().split("T")[0];

  let text = `📬 Here's your digest, ${new Date(now_).toLocaleDateString("en-US", { month: "short", day: "numeric" })}:\n\n`;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    text += `▪️ ${item.headline}\n`;
    text += `${item.summary}\n`;
    text += `— ${item.sourceName}\n\n`;
  }

  const buttons: ReturnType<typeof inlineButton>[] = [];
  for (const item of items) {
    buttons.push(inlineButton(`📎 ${item.sourceName}`, `actual_source:${item.id}`));
  }

  const row1: ReturnType<typeof inlineButton>[] = [];
  if (items.length > 0) {
    row1.push(inlineButton("More like this", `related:${items[0].id}`));
  }
  row1.push(inlineButton("💬 Feedback", "menu:feedback"));

  const row2 = [
    inlineButton("⏹️ Stop digest", "unsubscribe"),
    inlineButton("⬅️ Menu", "menu:main"),
  ];

  const keyboard = inlineKeyboard([buttons, row1, row2]);

  if (messageId) {
    await ctx.api.editMessageText(ctx.chat!.id, messageId, text, {
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
  } else {
    await ctx.reply(text, {
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
  }
}

// Handler for "Actual source" button (shows the source URL)
composer.callbackQuery(/^actual_source:/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Opening source…" });
  const id = ctx.callbackQuery.data.split(":")[1];
  const item = await getDigestItem(id);
  if (item) {
    // Telegram's url button opens in external browser; we use a message with the link
    await ctx.reply(
      `Source: ${item.sourceName}\n\n${item.sourceUrl}`,
    );
  }
});

// Handler for "More like this" button
composer.callbackQuery(/^related:(.+)/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Finding related articles…" });
  const itemId = ctx.callbackQuery.data.split(":")[1];

  // Re-fetch from the news API to get more articles
  const articles = await fetchCryptoNews();
  if (articles.length === 0) {
    await ctx.reply("No related articles available right now. Try again later.");
    return;
  }

  const stored = await saveDigestItems(articles);
  await ctx.reply("Here are some related articles you might find interesting:");
  await sendOrEditDigestMessage(ctx, stored);
});

export default composer;