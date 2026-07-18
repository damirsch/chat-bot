import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatService } from '../chat/chat.service';
import { AnthropicService } from '../anthropic/anthropic.service';
import { ResponderService } from './responder.service';

interface Buffer {
  timer: NodeJS.Timeout;
  lastMessageId: number;
}

/**
 * Smart group behaviour: instead of replying to every message, group messages
 * that are not directly addressed to the bot are buffered for a short debounce
 * window, then a cheap Haiku "gate" decides whether the bot should respond,
 * react with an emoji, or stay silent.
 */
@Injectable()
export class GroupGateService {
  private readonly logger = new Logger(GroupGateService.name);
  private readonly enabled: boolean;
  private readonly debounceMs: number;
  private readonly cooldownMs: number;

  private readonly buffers = new Map<number, Buffer>();
  private readonly lastResponseAt = new Map<number, number>();

  constructor(
    private readonly config: ConfigService,
    private readonly chat: ChatService,
    private readonly anthropic: AnthropicService,
    private readonly responder: ResponderService,
  ) {
    this.enabled =
      (this.config.get<string>('GROUP_GATE_ENABLED') ?? 'true') !== 'false';
    this.debounceMs = Number(this.config.get('GATE_DEBOUNCE_MS') ?? 5000);
    this.cooldownMs = Number(this.config.get('GATE_COOLDOWN_MS') ?? 60000);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Queue a non-addressed group message; (re)arms the debounce timer. */
  enqueue(telegramChatId: number, messageId: number): void {
    if (!this.enabled) return;

    const existing = this.buffers.get(telegramChatId);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      this.buffers.delete(telegramChatId);
      void this.flush(telegramChatId, messageId);
    }, this.debounceMs);

    this.buffers.set(telegramChatId, { timer, lastMessageId: messageId });
  }

  private async flush(
    telegramChatId: number,
    lastMessageId: number,
  ): Promise<void> {
    try {
      const chat = await this.chat.findByTelegramId(telegramChatId);
      if (!chat) return;

      const { messages } = await this.chat.buildContext(chat);
      const recent = messages.slice(-12);
      if (recent.length === 0) return;

      const decision = await this.anthropic.gate(recent);

      if (decision.action === 'respond') {
        const last = this.lastResponseAt.get(telegramChatId) ?? 0;
        if (Date.now() - last < this.cooldownMs) {
          this.logger.debug(`Gate: respond suppressed by cooldown`);
          return;
        }
        this.lastResponseAt.set(telegramChatId, Date.now());
        await this.responder.respond(telegramChatId, {
          replyToMessageId: lastMessageId,
        });
      } else if (decision.action === 'react' && decision.emoji) {
        await this.responder.react(
          telegramChatId,
          lastMessageId,
          decision.emoji,
        );
      }
    } catch (err) {
      this.logger.error('Gate flush failed', err as Error);
    }
  }
}
