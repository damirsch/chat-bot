# chat-bot

Telegram AI chat bot powered by Anthropic Claude, built with NestJS.

- Works in **private chats** (replies to every message) and **groups**.
- **Smart group mode**: besides `@mention`/reply, a cheap Haiku "gate" decides on its own whether to chime in, react with an emoji, or stay silent — with a debounce buffer for message bursts and a cooldown to avoid spam.
- **Streaming replies**: the answer is edited into a single message as tokens arrive (`editMessageText`).
- **Switch models** on the fly: Opus 4.8 / Sonnet 5 / Haiku 4.5, with adjustable reasoning level.
- **Custom personality** per chat via `/persona` (falls back to `SYSTEM_PROMPT` env, then a built-in default).
- **Persistent history** in PostgreSQL with automatic **rolling summarization** to keep context small.

## Stack

- NestJS 11 + `nestjs-telegraf` (Telegraf, long-polling)
- `@anthropic-ai/sdk`
- Prisma + PostgreSQL
- Docker / docker-compose

## Setup (local)

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
   - For groups, set the privacy mode in BotFather (`/setprivacy`):
     - **OFF (Disable)** → the bot sees all group messages. Required for smart group mode (`GROUP_GATE_ENABLED=true`), so the gate can decide when to chime in.
     - **ON** → the bot only sees commands, `@mentions` and replies. Use this if you set `GROUP_GATE_ENABLED=false` and want mention-only behaviour.
2. Get an Anthropic API key from the [console](https://console.anthropic.com/).
3. Copy env and fill it in:
   ```bash
   cp .env.example .env
   ```
4. Install deps and generate the Prisma client:
   ```bash
   npm install
   npm run prisma:generate
   ```
5. Start a local Postgres (or use the docker-compose one) and run migrations:
   ```bash
   npm run prisma:migrate
   ```
6. Run the bot:
   ```bash
   npm run start:dev
   ```

## Commands

- `/start` — intro
- `/help` — help
- `/model` — pick the model + reasoning level (inline keyboard)
- `/reset` — clear the conversation history

## Deploy (VPS with Docker)

1. Copy the repo to the server and create `.env` with `TELEGRAM_BOT_TOKEN` and `ANTHROPIC_API_KEY`.
2. Build and run:
   ```bash
   docker compose up -d --build
   ```
   The `bot` container runs `prisma db push` on start (creates/syncs tables), then launches long-polling.

## Configuration

| Env var | Default | Description |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | — | Bot token from BotFather |
| `ANTHROPIC_API_KEY` | — | Anthropic API key |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `DEFAULT_MODEL` | `claude-sonnet-5` | Model for new chats |
| `HISTORY_WINDOW` | `20` | Verbatim messages kept before summarizing |
| `SYSTEM_PROMPT` | — | Optional global personality override |
| `GROUP_GATE_ENABLED` | `true` | Smart group mode (bot decides when to chime in) |
| `GATE_DEBOUNCE_MS` | `5000` | Debounce window for group message bursts |
| `GATE_COOLDOWN_MS` | `60000` | Min gap between self-initiated group replies |

## Roadmap (next)

- Vector memory (pgvector + an embeddings provider like Voyage AI) for long-term semantic recall beyond the rolling summary.
- React to incoming user reactions as lightweight feedback.
- Handle non-text messages (photos, voice) via multimodal input.

## Models

Model ids are the real Anthropic Claude API identifiers. Fable 5 is intentionally
**not** included (expensive and requires a data-retention policy). See
`src/config/models.config.ts` to adjust the list.
