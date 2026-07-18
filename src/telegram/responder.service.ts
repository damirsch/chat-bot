import { Injectable, Logger } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf, Context } from 'telegraf';
import { MessageRole } from '@prisma/client';
import { ChatService } from '../chat/chat.service';
import { AnthropicService } from '../anthropic/anthropic.service';
import { ReasoningLevel } from '../config/models.config';

const TELEGRAM_MSG_LIMIT = 4000;

@Injectable()
export class ResponderService {
  private readonly logger = new Logger(ResponderService.name);

  constructor(
    @InjectBot() private readonly bot: Telegraf<Context>,
    private readonly chat: ChatService,
    private readonly anthropic: AnthropicService,
  ) {}

  /**
   * Generate a Claude reply and send it as a single message (or a few, if it
   * exceeds Telegram's length limit). Optionally sent as a reply to a specific
   * message. The chat must already exist in the DB.
   */
  async respond(
    telegramChatId: number,
    opts: { replyToMessageId?: number } = {},
  ): Promise<void> {
    const chat = await this.chat.findByTelegramId(telegramChatId);
    if (!chat) return;

    const stopTyping = this.startTyping(telegramChatId);
    try {
      const { system, messages } = await this.chat.buildContext(chat);
      const result = await this.anthropic.complete({
        model: chat.model,
        reasoning: chat.reasoning as ReasoningLevel,
        system,
        messages,
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
      const e = err as { status?: number; message?: string };
      this.logger.error(
        `Failed to generate reply (model=${chat.model} reasoning=${chat.reasoning} status=${e.status ?? '?'}): ${e.message ?? String(err)}`,
        (err as Error)?.stack,
      );
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
   * Send the reply, splitting on Telegram's length limit. The first chunk is
   * sent as a reply to `replyToMessageId` when provided; Markdown is attempted
   * with a plain-text fallback if parsing fails.
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
        await this.bot.telegram.sendMessage(telegramChatId, chunk, {
          ...extra,
          parse_mode: 'Markdown',
        });
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
