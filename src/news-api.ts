/**
 * CryptoPanic API client — fetches curated crypto news.
 * Call external APIs against their real contract (correct endpoints, ids, params);
 * credentials from env. Do not fake responses.
 *
 * Endpoint: https://cryptopanic.com/api/v1/posts/?auth_token=<key>&kind=news&public=true
 * Sign up for a free API key at https://cryptopanic.com/developers/api/
 */
import type { DigestItem } from "./storage.js";
import { clock } from "./clock.js";

interface CryptopanicPost {
  title: string;
  slug: string;
  url: string;
  source: { title: string; domain: string };
  published_at: string;
  currencies?: { code: string; title: string }[];
  domain: string;
  kind: string;
}

interface CryptopanicResponse {
  count: number;
  next: string | null;
  previous: string | null;
  results: CryptopanicPost[];
}

let _apiKey: string | undefined;

export function setApiKey(key: string): void {
  _apiKey = key;
}

function getApiKey(): string {
  if (_apiKey) return _apiKey;
  const key = process.env.CRYPTOPANIC_API_KEY;
  if (!key) {
    throw new Error(
      "CRYPTOPANIC_API_KEY is required. Get one at https://cryptopanic.com/developers/api/",
    );
  }
  _apiKey = key;
  return key;
}

/**
 * Fetch top 1-3 crypto news articles, filtered to news items.
 * Uses CryptoPanic's default sort (news priority).
 * If the API is unreachable or returns no results, throws.
 */
export async function fetchTopStories(count = 3): Promise<DigestItem[]> {
  const key = getApiKey();
  const url = new URL("https://cryptopanic.com/api/v1/posts/");
  url.searchParams.set("auth_token", key);
  url.searchParams.set("kind", "news");
  url.searchParams.set("public", "true");
  url.searchParams.set("limit", String(Math.min(count, 25)));

  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "unknown");
    throw new Error(`CryptoPanic API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as CryptopanicResponse;
  const posts = data.results ?? [];

  if (posts.length === 0) {
    throw new Error("No news articles returned from CryptoPanic");
  }

  const now = clock().now();
  return posts.slice(0, count).map((post, i) => ({
    id: post.slug || `article-${now.getTime()}-${i}`,
    headline: post.title,
    summary_text: post.title, // CryptoPanic doesn't provide separate summaries
    source_name: post.source?.title || post.domain || "CryptoPanic",
    source_url: post.url,
    published_at: post.published_at || now.toISOString(),
    topic_tags: (post.currencies ?? []).map((c) => c.code),
  }));
}
