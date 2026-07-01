import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { getStore } from "../storage.js";
import { fetchCryptoNews } from "../news.js";

const composer = new Composer<Ctx>();

// /sample — request immediate example digest
composer.command("sample", async (ctx) => {
  await showSampleDigest(ctx);
});

// Sample from main menu
composer.callbackQuery("digest:sample", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Fetching latest news…" });
  await showSampleDigest(ctx);
});

// Show digest (from menu) — either latest from store or fetch fresh
composer.callbackQuery("digest:show", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Fetching your digest…" });

  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.editMessageText("Couldn't identify you. Try /start again.");
    return;
  }

  const store = getStore();
  const profile = await store.getUser(userId);

  if (!profile || profile.subscription_status !== "active") {
    await ctx.editMessageText(
      "You're not subscribed yet. Tap /start to set up your daily digest.",
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
    );
    return;
  }

  // Fetch news
  const apiKey = process.env.NEWSAPI_KEY;
  const articles = await fetchCryptoNews(3, apiKey);

  if (articles.length === 0) {
    await ctx.editMessageText(
      "No news articles available right now. Check back later.",
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
    );
    return;
  }

  // Format digest
  const digestText = formatDigest(articles);

  // Add "More like this" and feedback buttons per article
  const buttons: ReturnType<typeof inlineButton>[][] = [];
  for (let i = 0; i < articles.length; i++) {
    buttons.push([
      inlineButton(`🔍 More like #${i + 1}`, `related:${i}`),
    ]);
  }
  buttons.push([
    inlineButton("💬 Feedback", "feedback"),
    inlineButton("⬅️ Back to menu", "menu:main"),
  ]);

  await ctx.editMessageText(digestText, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: inlineKeyboard(buttons),
  });
});

// "More like this" — request similar articles
composer.callbackQuery(/^related:/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Fetching related articles…" });

  const parts = ctx.callbackQuery.data.split(":");
  const index = parseInt(parts[1], 10);

  const apiKey = process.env.NEWSAPI_KEY;
  const articles = await fetchCryptoNews(3, apiKey);

  if (articles.length <= index) {
    await ctx.answerCallbackQuery({ text: "That article is no longer available.", show_alert: true });
    return;
  }

  const article = articles[index];
  const related = await fetchRelatedArticles(article.topics, apiKey);

  if (related.length === 0) {
    await ctx.editMessageText(
      `No related articles found for "${article.headline}".`,
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
    );
    return;
  }

  const text = `<b>Related to: ${escapeHtml(article.headline)}</b>\n\n` + formatDigest(related);

  const buttons: ReturnType<typeof inlineButton>[][] = [];
  buttons.push([
    inlineButton("💬 Feedback", "feedback"),
    inlineButton("⬅️ Back to menu", "menu:main"),
  ]);

  await ctx.editMessageText(text, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: inlineKeyboard(buttons),
  });
});

// ---- Helpers ----

function formatDigest(articles: Array<{ headline: string; summary: string; sourceName: string; sourceUrl: string; publishedAt: string; topics: string[] }>): string {
  let text = "<b>📰 Daily Crypto Digest</b>\n\n";
  for (const a of articles) {
    text += `<b>${escapeHtml(a.headline)}</b>\n`;
    text += `${escapeHtml(a.summary)}\n`;
    text += `<a href="${a.sourceUrl}">${escapeHtml(a.sourceName)}</a>`;
    if (a.topics.length > 0) {
      text += `  ·  ${a.topics.map((t) => `#${t.replace(/\s+/g, "")}`).join(" ")}`;
    }
    text += "\n\n";
  }
  return text.trim();
}

async function fetchRelatedArticles(
  topics: string[],
  apiKey?: string,
): Promise<Array<{ headline: string; summary: string; sourceName: string; sourceUrl: string; publishedAt: string; topics: string[] }>> {
  if (!apiKey) return [];

  const topicQuery = topics.slice(0, 2).join(" OR ");
  const baseUrl = process.env.NEWSAPI_BASE_URL ?? "https://newsapi.org/v2";
  const url = `${baseUrl}/everything?q=${encodeURIComponent(topicQuery)}&sortBy=relevancy&pageSize=3&language=en&apiKey=${apiKey}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as { articles?: Array<{ title?: string; description?: string; source?: { name?: string }; url?: string; publishedAt?: string }> };
    if (!data.articles) return [];
    return data.articles.slice(0, 3).map((a) => ({
      headline: a.title ?? "Untitled",
      summary: a.description ?? "No summary.",
      sourceName: a.source?.name ?? "Unknown",
      sourceUrl: a.url ?? "",
      publishedAt: a.publishedAt ?? "",
      topics: [],
    }));
  } catch {
    return [];
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Shared sample digest used by onboarding and /sample. */
export async function showSampleDigest(ctx: Ctx): Promise<void> {
  const apiKey = process.env.NEWSAPI_KEY;
  const articles = await fetchCryptoNews(3, apiKey);

  if (articles.length === 0) {
    await ctx.reply("No news articles available right now. Check back later.");
    return;
  }

  const text = "<b>📰 Sample Digest</b>\n\n" + formatDigest(articles);

  const buttons: ReturnType<typeof inlineButton>[][] = [];
  for (let i = 0; i < articles.length; i++) {
    buttons.push([inlineButton(`🔍 More like #${i + 1}`, `related:${i}`)]);
  }
  buttons.push([
    inlineButton("💬 Feedback", "feedback"),
    inlineButton("⬅️ Back to menu", "menu:main"),
  ]);

  await ctx.reply(text, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: inlineKeyboard(buttons),
  });
}

export default composer;