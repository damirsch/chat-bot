import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Chat, ChatKind, MessageRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AnthropicService, ChatMessage } from '../anthropic/anthropic.service';
import {
  DEFAULT_MODEL_ID,
  ReasoningLevel,
  isValidModel,
} from '../config/models.config';
import { DEFAULT_SYSTEM_PROMPT } from '../config/persona.config';

// Model used for cheap background tasks (summarization).
const UTILITY_MODEL = 'claude-haiku-4-5';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly historyWindow: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly anthropic: AnthropicService,
    private readonly config: ConfigService,
  ) {
    this.historyWindow = Number(this.config.get('HISTORY_WINDOW') ?? 20);
  }

  /** Fetch the chat row, creating it with defaults on first contact. */
  async getOrCreate(
    telegramId: number,
    kind: ChatKind,
    title?: string,
  ): Promise<Chat> {
    const existing = await this.prisma.chat.findUnique({
      where: { telegramId: BigInt(telegramId) },
    });
    if (existing) return existing;

    const defaultModel =
      this.config.get<string>('DEFAULT_MODEL') ?? DEFAULT_MODEL_ID;

    return this.prisma.chat.create({
      data: {
        telegramId: BigInt(telegramId),
        kind,
        title,
        model: isValidModel(defaultModel) ? defaultModel : DEFAULT_MODEL_ID,
      },
    });
  }

  async findByTelegramId(telegramId: number): Promise<Chat | null> {
    return this.prisma.chat.findUnique({
      where: { telegramId: BigInt(telegramId) },
    });
  }

  async setModel(chatId: string, model: string): Promise<void> {
    await this.prisma.chat.update({ where: { id: chatId }, data: { model } });
  }

  async setReasoning(
    chatId: string,
    reasoning: ReasoningLevel,
  ): Promise<void> {
    await this.prisma.chat.update({
      where: { id: chatId },
      data: { reasoning },
    });
  }

  async reset(chatId: string): Promise<void> {
    await this.prisma.message.deleteMany({ where: { chatId } });
    await this.prisma.summary.deleteMany({ where: { chatId } });
  }

  /** Set (or clear, when null) the per-chat system prompt override. */
  async setSystemPrompt(chatId: string, prompt: string | null): Promise<void> {
    await this.prisma.chat.update({
      where: { id: chatId },
      data: { systemPrompt: prompt },
    });
  }

  /** The effective base system prompt: env override or built-in default. */
  baseSystemPrompt(): string {
    return (
      this.config.get<string>('SYSTEM_PROMPT')?.trim() || DEFAULT_SYSTEM_PROMPT
    );
  }

  async addMessage(params: {
    chatId: string;
    role: MessageRole;
    content: string;
    telegramMsgId?: number;
    senderName?: string;
    tokens?: number;
  }): Promise<void> {
    await this.prisma.message.create({
      data: {
        chatId: params.chatId,
        role: params.role,
        content: params.content,
        telegramMsgId: params.telegramMsgId,
        senderName: params.senderName,
        tokens: params.tokens ?? 0,
      },
    });
  }

  /**
   * Build the message list to send to Claude: the rolling summary (if any)
   * is folded into the system prompt, followed by the most recent messages.
   */
  async buildContext(chat: Chat): Promise<{
    system: string;
    messages: ChatMessage[];
  }> {
    const recent = await this.prisma.message.findMany({
      where: { chatId: chat.id },
      orderBy: { createdAt: 'desc' },
      take: this.historyWindow,
    });
    recent.reverse();

    const summary = await this.prisma.summary.findUnique({
      where: { chatId: chat.id },
    });

    let system = chat.systemPrompt?.trim() || this.baseSystemPrompt();
    if (summary?.content) {
      system += `\n\nКонтекст предыдущей беседы (сводка):\n${summary.content}`;
    }

    const messages: ChatMessage[] = recent.map((m) => ({
      role: m.role === MessageRole.USER ? 'user' : 'assistant',
      content:
        m.role === MessageRole.USER && m.senderName
          ? `${m.senderName}: ${m.content}`
          : m.content,
    }));

    return { system, messages };
  }

  /**
   * If the verbatim history has grown beyond the window, compact the oldest
   * messages into (or onto) the rolling summary and delete them.
   */
  async maybeSummarize(chat: Chat): Promise<void> {
    const total = await this.prisma.message.count({
      where: { chatId: chat.id },
    });
    if (total <= this.historyWindow) return;

    const overflow = await this.prisma.message.findMany({
      where: { chatId: chat.id },
      orderBy: { createdAt: 'asc' },
      take: total - this.historyWindow,
    });
    if (overflow.length === 0) return;

    const existing = await this.prisma.summary.findUnique({
      where: { chatId: chat.id },
    });

    const transcript = overflow
      .map((m) => {
        const who =
          m.role === MessageRole.USER ? m.senderName ?? 'Пользователь' : 'Бот';
        return `${who}: ${m.content}`;
      })
      .join('\n');

    const prompt = [
      existing?.content
        ? `Текущая сводка беседы:\n${existing.content}\n`
        : '',
      'Новые сообщения, которые нужно добавить в сводку:',
      transcript,
      '',
      'Обнови сводку: кратко сохрани важные факты, имена, договорённости и контекст. Пиши тезисно.',
    ].join('\n');

    try {
      const updated = await this.anthropic.utility({
        model: UTILITY_MODEL,
        system:
          'Ты ведёшь компактную сводку диалога. Сохраняй только значимое.',
        prompt,
        maxOutputTokens: 1024,
      });

      await this.prisma.summary.upsert({
        where: { chatId: chat.id },
        create: { chatId: chat.id, content: updated },
        update: { content: updated },
      });

      await this.prisma.message.deleteMany({
        where: { id: { in: overflow.map((m) => m.id) } },
      });
    } catch (err) {
      this.logger.error('Failed to summarize history', err as Error);
    }
  }
}
