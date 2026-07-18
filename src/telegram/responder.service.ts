import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf, Context } from 'telegraf';
import { Chat, MessageRole } from '@prisma/client';
import { ChatService } from '../chat/chat.service';
import {
  AnthropicService,
  ALLOWED_REACTIONS,
} from '../anthropic/anthropic.service';
import { ReasoningLevel } from '../config/models.config';
import { markdownToTelegramHtml } from './markdown.util';

const TELEGRAM_MSG_LIMIT = 4000;
// Min gap between live-draft updates. Bot API caps drafts at 20 calls / 5s.
const DRAFT_THROTTLE_MS = 700;

@Injectable()
export class ResponderService {
  private readonly logger = new Logger(ResponderService.name);
  private readonly streamEnabled: boolean;

  constructor(
    @InjectBot() private readonly bot: Telegraf<Context>,
    private readonly chat: ChatService,
    private readonly anthropic: AnthropicService,
    private readonly config: ConfigService,
  ) {
    this.streamEnabled =
      this.config.get<string>('STREAM_ENABLED') !== 'false';
  }

  /**
   * Generate a Claude reply and send it as a single message (or a few, if it
   * exceeds Telegram's length limit). Optionally sent as a reply to a specific
   * message. When `stream` is set (private chats only) the reply is streamed
   * live via Telegram's ephemeral message drafts. The chat must already exist.
   */
  async respond(
    telegramChatId: number,
    opts: {
      replyToMessageId?: number;
      reactToMessageId?: number;
      stream?: boolean;
    } = {},
  ): Promise<void> {
    const chat = await this.chat.findByTelegramId(telegramChatId);
    if (!chat) return;

    if (opts.stream && this.streamEnabled) {
      await this.respondStreaming(chat, telegramChatId, opts);
      return;
    }

    const stopTyping = this.startTyping(telegramChatId);
    try {
      const { system, messages } = await this.chat.buildContext(chat);
      const result = await this.anthropic.complete({
        model: chat.model,
        reasoning: chat.reasoning as ReasoningLevel,
        system,
        messages,
        ...this.reactionTool(telegramChatId, opts.reactToMessageId),
      });

      await this.chat.addMessage({
        chatId: chat.id,
        role: MessageRole.ASSISTANT,
        content: result.text,
        tokens: result.outputTokens,
      });

      await this.sendReply(telegramChatId, result.text, opts.replyToMessageId);
      await this.chat.maybeSummarize(chat);
    } catch (err) {
      this.reportFailure(err, chat);
      await this.bot.telegram
        .sendMessage(
          telegramChatId,
          '⚠️ Не удалось получить ответ. Попробуй ещё раз.',
        )
        .catch(() => undefined);
    } finally {
      stopTyping();
    }
  }

  /**
   * Stream the reply into an ephemeral Telegram draft (private chats only),
   * then persist it as a real message. Falls back to a normal message if
   * anything goes wrong mid-stream.
   */
  private async respondStreaming(
    chat: Chat,
    telegramChatId: number,
    opts: { reactToMessageId?: number },
  ): Promise<void> {
    const draftId = Math.floor(Math.random() * 2_000_000_000) + 1;
    let buffer = '';
    let sentText = '';
    let lastSendAt = 0;
    let sending = false;

    const pushDraft = () => {
      if (sending || buffer === sentText) return;
      if (Date.now() - lastSendAt < DRAFT_THROTTLE_MS) return;
      sending = true;
      const snapshot = buffer.slice(0, 4096);
      lastSendAt = Date.now();
      void this.sendDraft(telegramChatId, draftId, snapshot).finally(() => {
        sentText = snapshot;
        sending = false;
      });
    };

    // Empty draft shows a native "Thinking…" placeholder while the model works.
    await this.sendDraft(telegramChatId, draftId, '');

    try {
      const { system, messages } = await this.chat.buildContext(chat);
      const result = await this.anthropic.completeStream({
        model: chat.model,
        reasoning: chat.reasoning as ReasoningLevel,
        system,
        messages,
        ...this.reactionTool(telegramChatId, opts.reactToMessageId),
        onTextDelta: (delta) => {
          buffer += delta;
          pushDraft();
        },
      });

      const finalText = result.text.trim();
      if (finalText) {
        await this.chat.addMessage({
          chatId: chat.id,
          role: MessageRole.ASSISTANT,
          content: finalText,
          tokens: result.outputTokens,
        });
        await this.sendReply(telegramChatId, finalText);
      }
      await this.chat.maybeSummarize(chat);
    } catch (err) {
      this.reportFailure(err, chat);
      // If we already streamed something, deliver it; else show the error.
      if (buffer.trim()) {
        await this.sendReply(telegramChatId, buffer.trim()).catch(
          () => undefined,
        );
      } else {
        await this.bot.telegram
          .sendMessage(
            telegramChatId,
            '⚠️ Не удалось получить ответ. Попробуй ещё раз.',
          )
          .catch(() => undefined);
      }
    }
  }

  /** Push a live draft update (Bot API `sendMessageDraft`; private chats only). */
  private async sendDraft(
    telegramChatId: number,
    draftId: number,
    text: string,
  ): Promise<void> {
    await (
      this.bot.telegram.callApi as unknown as (
        method: string,
        payload: Record<string, unknown>,
      ) => Promise<unknown>
    )('sendMessageDraft', {
      chat_id: telegramChatId,
      draft_id: draftId,
      text,
    }).catch(() => undefined);
  }

  private reportFailure(err: unknown, chat: Chat): void {
    const e = err as { status?: number; message?: string };
    this.logger.error(
      `Failed to generate reply (model=${chat.model} reasoning=${chat.reasoning} status=${e.status ?? '?'}): ${e.message ?? String(err)}`,
      (err as Error)?.stack,
    );
  }

  /**
   * Build the `set_reaction` client tool + executor for a given target message.
   * Returns an empty object when there's no message to react to, so the tool is
   * simply not offered to the model in that case.
   */
  private reactionTool(
    telegramChatId: number,
    reactToMessageId?: number,
  ): {
    tools?: {
      name: string;
      description: string;
      input_schema: {
        type: 'object';
        properties: Record<string, unknown>;
        required: string[];
      };
    }[];
    onToolUse?: (name: string, input: unknown) => Promise<string>;
  } {
    if (!reactToMessageId) return {};

    return {
      tools: [
        {
          name: 'set_reaction',
          description:
            "Set a single emoji reaction on the user's latest message. " +
            'Use it for lightweight acknowledgement (agreement, appreciation, humour) ' +
            'or when the user explicitly asks you to react/like a message. ' +
            'You may still also send a short text reply afterwards. ' +
            `Allowed emojis only: ${ALLOWED_REACTIONS.join(' ')}.`,
          input_schema: {
            type: 'object',
            properties: {
              emoji: {
                type: 'string',
                description: 'One emoji from the allowed list.',
              },
            },
            required: ['emoji'],
          },
        },
      ],
      onToolUse: async (name, input) => {
        if (name !== 'set_reaction') return `Unknown tool: ${name}`;
        const emoji = (input as { emoji?: string })?.emoji?.trim() ?? '';
        if (!ALLOWED_REACTIONS.includes(emoji)) {
          return `Emoji "${emoji}" is not allowed. Pick one of: ${ALLOWED_REACTIONS.join(' ')}`;
        }
        await this.react(telegramChatId, reactToMessageId, emoji);
        return `Reaction ${emoji} was set on the message.`;
      },
    };
  }

  /** Send "typing…" now and keep refreshing it every 4s until stopped. */
  private startTyping(telegramChatId: number): () => void {
    const send = () =>
      this.bot.telegram
        .sendChatAction(telegramChatId, 'typing')
        .catch(() => undefined);
    void send();
    const interval = setInterval(send, 4000);
    return () => clearInterval(interval);
  }

  /**
   * Send the reply, splitting on Telegram's length limit. Each chunk of raw
   * Markdown is converted to Telegram-flavoured HTML and sent with
   * `parse_mode: 'HTML'`; on a parse error we fall back to the plain raw text.
   * The first chunk is sent as a reply to `replyToMessageId` when provided.
   */
  private async sendReply(
    telegramChatId: number,
    text: string,
    replyToMessageId?: number,
  ): Promise<void> {
    for (let i = 0; i < text.length; i += TELEGRAM_MSG_LIMIT) {
      const chunk = text.slice(i, i + TELEGRAM_MSG_LIMIT);
      const extra: Record<string, unknown> = {};
      if (i === 0 && replyToMessageId) {
        extra.reply_parameters = { message_id: replyToMessageId };
      }
      try {
        await this.bot.telegram.sendMessage(
          telegramChatId,
          markdownToTelegramHtml(chunk),
          { ...extra, parse_mode: 'HTML' },
        );
      } catch {
        await this.bot.telegram
          .sendMessage(telegramChatId, chunk, extra)
          .catch(() => undefined);
      }
    }
  }

  /** Set an emoji reaction on a message. */
  async react(
    telegramChatId: number,
    messageId: number,
    emoji: string,
  ): Promise<void> {
    await this.bot.telegram
      .setMessageReaction(telegramChatId, messageId, [
        { type: 'emoji', emoji: emoji as never },
      ])
      .catch((err) => this.logger.warn(`react failed: ${String(err)}`));
  }
}
