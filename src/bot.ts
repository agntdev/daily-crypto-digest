import { Composer } from "grammy";
import { readdirSync } from "node:fs";
import { createBot, type BotContext } from "./toolkit/index.js";

// The per-chat session shape (ephemeral conversation state only). Extend as the
// bot grows. Durable domain data must NOT live here — use the toolkit's
// persistent storage (see AGENTS.md).
export interface Session {
  /** Current flow step for multi-step conversations. */
  step?:
    | "onboarding_timezone"
    | "onboarding_delivery_time"
    | "onboarding_confirm"
    | "change_time"
    | "feedback";
  /** Temporary data during onboarding. */
  onboarding_timezone?: string;
  onboarding_delivery_time?: string;
  /** Flow timeout: unix ms when the current step expires. */
  expiresAt?: number;
}

export type Ctx = BotContext<Session>;

/**
 * buildBot — assembles the bot, AUTO-LOADS every feature handler from
 * src/handlers/, then registers the global fallback. Does NOT start the bot.
 * Add a feature by creating src/handlers/<name>.ts that default-exports a grammY
 * Composer — NEVER edit this file (concurrent feature PRs would conflict).
 */
export async function buildBot(token: string) {
  const bot = createBot<Session>(token, {
    initial: () => ({}),
  });

  // Flow timeout sweeper — reset idle if a step has been pending >5 minutes
  bot.use(async (ctx, next) => {
    const expires = ctx.session.expiresAt;
    if (expires && Date.now() > expires) {
      ctx.session.step = undefined;
      ctx.session.onboarding_timezone = undefined;
      ctx.session.onboarding_delivery_time = undefined;
      ctx.session.expiresAt = undefined;
      // Don't auto-reply — the handler that receives this update will
      // see step === undefined and decide what to show.
    }
    await next();
  });

  const dir = new URL("./handlers/", import.meta.url);
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter(
      (f) =>
        (f.endsWith(".js") || f.endsWith(".ts")) &&
        !f.endsWith(".d.ts") &&
        !f.includes(".test.") &&
        !f.includes(".spec."),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    files = []; // no handlers/ dir yet → nothing to load
  }
  for (const file of files.sort()) {
    const mod = (await import(new URL(file, dir).href)) as { default?: Composer<Ctx> };
    if (!mod.default) {
      throw new Error(`handler ${file} must default-export a grammY Composer`);
    }
    bot.use(mod.default);
  }

  bot.on("message", (ctx) => ctx.reply("Sorry, I didn't understand that. Try /help."));

  return bot;
}
