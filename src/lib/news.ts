import { now } from "./clock.js";

/**
 * Real crypto news API client. Uses CryptoPanic as primary source,
 * falls back to NewsAPI. Credentials from env.
 *
 * CRYPTOPANIC_API_KEY — from https://cryptopanic.com/developers/api/
 * NEWSAPI_KEY — from https://newsapi.org/ (optional fallback)
 */

export interface NewsArticle {
  headline: string;
  summary: string;
  sourceName: string;
  sourceUrl: string;
  publishedAt: Date;
  topicTags: string[];
}

interface CryptoPanicPost {
  title: string;
  url: string;
  published_at: string;
  source: { title: string; domain: string };
  currencies?: Array<{ code: string; title: string }>;
}

/**
 * Fetch 1–3 curated crypto news summaries from real APIs.
 * Returns an empty array on failure (never throws — the caller
 * handles the "no news" case).
 */
export async function fetchCryptoNews(): Promise<NewsArticle[]> {
  const articles = await tryCryptoPanic();
  if (articles.length > 0) return articles.slice(0, 3);
  return tryNewsApi();
}

async function tryCryptoPanic(): Promise<NewsArticle[]> {
  const apiKey = process.env.CRYPTOPANIC_API_KEY;
  if (!apiKey) return [];

  const url = `https://cryptopanic.com/api/v1/posts/?auth_token=${apiKey}&kind=news&public=true&limit=5`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { results?: CryptoPanicPost[] };
    if (!data.results) return [];

    return data.results.map((post) => ({
      headline: post.title,
      summary: truncate(
        post.title,
        200,
      ),
      sourceName: post.source?.title ?? post.source?.domain ?? "CryptoPanic",
      sourceUrl: post.url,
      publishedAt: new Date(post.published_at),
      topicTags: (post.currencies ?? []).map((c) => c.code),
    }));
  } catch {
    return [];
  }
}

async function tryNewsApi(): Promise<NewsArticle[]> {
  const apiKey = process.env.NEWSAPI_KEY;
  if (!apiKey) return [];

  const url = `https://newsapi.org/v2/everything?q=crypto+OR+bitcoin+OR+blockchain&sortBy=publishedAt&pageSize=3&language=en&apiKey=${apiKey}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      articles?: Array<{
        title: string;
        description: string;
        url: string;
        source: { name: string };
        publishedAt: string;
      }>;
    };
    if (!data.articles) return [];

    return data.articles.map((a) => ({
      headline: a.title,
      summary: truncate(a.description ?? a.title, 200),
      sourceName: a.source?.name ?? "NewsAPI",
      sourceUrl: a.url,
      publishedAt: new Date(a.publishedAt),
      topicTags: [],
    }));
  } catch {
    return [];
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

// --- Digest item durable storage helpers ---
// These build on PersistentStore but encode the digest-item domain model.

import { getStore } from "./store.js";

const DIGEST_INDEX = "digests:all";

export interface StoredDigestItem extends NewsArticle {
  id: string;
}

let _digestIdCounter = 0;

export async function saveDigestItems(
  items: NewsArticle[],
): Promise<StoredDigestItem[]> {
  const store = getStore();
  const stored: StoredDigestItem[] = [];

  for (const item of items) {
    _digestIdCounter++;
    const id = `d${now().getTime()}-${_digestIdCounter}`;
    const rec: StoredDigestItem = { ...item, id };
    await store.kvSet(`digest:${id}`, rec);
    await store.setAdd(DIGEST_INDEX, id);
    stored.push(rec);
  }

  return stored;
}

export async function getDigestItem(
  id: string,
): Promise<StoredDigestItem | undefined> {
  return getStore().kvGet<StoredDigestItem>(`digest:${id}`);
}

/** Get the most recent N digest items, newest first. */
export async function getRecentDigests(n: number): Promise<StoredDigestItem[]> {
  const store = getStore();
  const ids = await store.setMembers(DIGEST_INDEX);
  // Fetch all and sort by publishedAt descending
  const items: StoredDigestItem[] = [];
  for (const id of ids) {
    const item = await store.kvGet<StoredDigestItem>(`digest:${id}`);
    if (item) items.push(item);
  }
  items.sort(
    (a, b) => b.publishedAt.getTime() - a.publishedAt.getTime(),
  );
  return items.slice(0, n);
}
