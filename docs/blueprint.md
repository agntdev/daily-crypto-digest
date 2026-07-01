# Daily Crypto Digest Bot — Bot specification

**Archetype:** content

**Voice:** professional and concise — write every user-facing message, button label, error, and empty state in this voice.

A Telegram bot delivering 1–3 curated crypto news summaries per day at user-selected times. Targets casual and active crypto followers who want concise, high-quality content without reading full articles.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- casual crypto followers
- active crypto traders
- Telegram users seeking curated content

## Success criteria

- Users receive daily summaries at their chosen local time
- Summaries include source attribution and links
- Unsubscribe commands/buttons work instantly

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Begin onboarding or reconfigure subscription
- **/stop** (command, actor: user, command: /stop) — Unsubscribe from daily digest
- **/time** (command, actor: user, command: /time) — Change delivery time preference
- **/sample** (command, actor: user, command: /sample) — Request immediate example digest
- **Stop daily digest** (button, actor: user, callback: unsubscribe) — Immediate unsubscribe action
- **More like this** (button, actor: user, callback: related:digest_item_id) — Request similar articles based on current summary
- **Feedback** (button, actor: user, callback: feedback) — Open feedback form in chat

## Flows

### Onboarding
_Trigger:_ /start

1. Detect timezone (Telegram-provided or manual selection)
2. Set delivery time preference
3. Confirm subscription
4. Show sample digest format

_Data touched:_ user_profile

### Daily Delivery
_Trigger:_ scheduled_local_time

1. Fetch 1-3 prioritized summaries
2. Format with source attribution and links
3. Send bundled message with inline buttons

_Data touched:_ digest_item, delivery_schedule

### Admin Reporting
_Trigger:_ daily_cron

1. Generate delivery stats report
2. Send to admin Telegram channel

_Data touched:_ activity_log

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

- **user_profile** _(retention: persistent)_ — User subscription preferences and metadata
  - fields: telegram_id, display_name, timezone, delivery_time, subscription_status
- **digest_item** _(retention: persistent)_ — Curated crypto news summary
  - fields: headline, summary_text, source_name, source_url, published_at, topic_tags
- **delivery_schedule** _(retention: persistent)_ — User-specific delivery timing
  - fields: user_id, local_send_time, next_scheduled_send
- **activity_log** _(retention: persistent)_ — Admin reporting and error tracking
  - fields: event_type, timestamp, user_id, details

## Integrations

- **Telegram** (required) — Bot API messaging and user interaction
- **Crypto News APIs** (required) — Aggregate articles from multiple crypto publishers
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- Configure admin Telegram chat for reports
- Set news source priorities
- Adjust summary length limits
- Manage user subscriptions in bulk

## Notifications

- Daily delivery confirmation to users
- Admin error alerts for failed deliveries
- Admin daily report with delivery stats

## Permissions & privacy

- Store user preferences with Telegram ID
- Collect delivery logs for audit
- Anonymize user data after 90 days

## Edge cases

- Timezone detection failure
- Multiple simultaneous delivery attempts
- Source API outages
- User requesting changes during delivery window

## Required tests

- End-to-end onboarding flow with timezone detection
- Daily delivery at user-selected local time
- Unsubscribe via command and button
- Admin error alert propagation

## Assumptions

- News sources will be curated by default
- Summaries will be auto-generated from articles
- Timezone defaults to UTC if undetectable
