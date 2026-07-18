import { Injectable, Logger } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf, Context } from 'telegraf';
import { MessageRole } from '@prisma/client';
import { ChatService } from '../chat/chat.service';
import { AnthropicService } from '../anthropic/anthropic.service';
import { ReasoningLevel } from '../config/models.config';

const TELEGRAM_MSG_LIMIT = 4000;
const EDIT_THROTTLE_MS = 1100;

@Injectable()
export class ResponderService {
  private readonly logger = new Logger(ResponderService.name);

  constructor(
    @InjectBot() private readonly bot: Telegraf<Context>,
    private readonly chat: ChatService,
    private readonly anthropic: AnthropicService,
  ) {}

  /**
   * Generate a streamed Claude reply and edit it into a single Telegram
   * message as tokens arrive. The chat must already exist in the DB.
   */
  async respond(
    telegramChatId: number,
    opts: { replyToMessageId?: number } = {},
  ): Promise<void> {
    const chat = await this.chat.findByTelegramId(telegramChatId);
    if (!chat) return;

    await this.bot.telegram
      .sendChatAction(telegramChatId, 'typing')
      .catch(() => undefined);

    const placeholder = await this.bot.telegram.sendMessage(
      telegramChatId,
      '✍️…',
      opts.replyToMessageId
        ? { reply_parameters: { message_id: opts.replyToMessageId } }
        : {},
    );
    const messageId = placeholder.message_id;

    let lastEditAt = 0;
    let lastSent = '✍️…';

    const flush = (text: string, force = false): void => {
      const now = Date.now();
      const trimmed = text.slice(0, TELEGRAM_MSG_LIMIT);
      if (!trimmed) return;
      if (!force && now - lastEditAt < EDIT_THROTTLE_MS) return;
      if (trimmed === lastSent) return;
      lastEditAt = now;
      lastSent = trimmed;
      void this.bot.telegram
        .editMessageText(telegramChatId, messageId, undefined, trimmed)
        .catch(() => undefined);
    };

    try {
      const { system, messages } = await this.chat.buildContext(chat);
      const result = await this.anthropic.streamComplete(
        {
          model: chat.model,
          reasoning: chat.reasoning as ReasoningLevel,
          system,
          messages,
        },
        (accumulated) => flush(accumulated),
      );

      await this.finalize(telegramChatId, messageId, result.text);

      await this.chat.addMessage({
        chatId: chat.id,
        role: MessageRole.ASSISTANT,
        content: result.text,
        tokens: result.outputTokens,
      });
      await this.chat.maybeSummarize(chat);
    } catch (err) {
      this.logger.error('Failed to stream reply', err as Error);
      await this.bot.telegram
        .editMessageText(
          telegramChatId,
          messageId,
          undefined,
          '⚠️ Не удалось получить ответ. Попробуй ещё раз.',
        )
        .catch(() => undefined);
    }
  }

  /**
   * Final render: fit the first chunk into the streamed message (trying
   * Markdown, falling back to plain text) and send any overflow as new
   * messages.
   */
  private async finalize(
    chatId: number,
    messageId: number,
    text: string,
  ): Promise<void> {
    const head = text.slice(0, TELEGRAM_MSG_LIMIT);
    const rest = text.slice(TELEGRAM_MSG_LIMIT);

    try {
      await this.bot.telegram.editMessageText(
        chatId,
        messageId,
        undefined,
        head,
        { parse_mode: 'Markdown' },
      );
    } catch {
      await this.bot.telegram
        .editMessageText(chatId, messageId, undefined, head)
        .catch(() => undefined);
    }

    for (let i = 0; i < rest.length; i += TELEGRAM_MSG_LIMIT) {
      const chunk = rest.slice(i, i + TELEGRAM_MSG_LIMIT);
      await this.bot.telegram.sendMessage(chatId, chunk).catch(() => undefined);
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
