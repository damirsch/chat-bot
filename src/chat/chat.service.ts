import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Chat, ChatKind, MessageRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AnthropicService, ChatMessage } from '../anthropic/anthropic.service';
import {
  DEFAULT_MODEL_ID,
  ReasoningLevel,
  getModel,
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

    const modelDef = getModel(chat.model);
    const reasoningNote =
      modelDef?.supportsReasoning && chat.reasoning !== 'off'
        ? `, extended reasoning: ${chat.reasoning}`
        : '';
    system +=
      `\n\n# Your current model\n` +
      `You are running on ${modelDef?.label ?? chat.model} ` +
      `(Anthropic API id: ${chat.model}${reasoningNote}). ` +
      `If asked which model you are, answer with this exact model and version. ` +
      `The user can switch your model at any time with the /model command.`;

    if (this.config.get<string>('WEB_SEARCH_ENABLED') !== 'false') {
      system +=
        `\n\n# Web search\n` +
        `You have a web_search tool. Use it whenever a question needs up-to-date, ` +
        `real-time, or niche factual information you are not confident about ` +
        `(current events, prices, versions, dates, recent news). ` +
        `Do not claim you lack internet access — search instead. ` +
        `Cite sources briefly when it helps.`;
    }

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

  /** Return the current rolling summary text for a chat, if any. */
  async getSummary(chatId: string): Promise<string | null> {
    const summary = await this.prisma.summary.findUnique({
      where: { chatId },
    });
    return summary?.content ?? null;
  }

  /**
   * Auto-compaction: if the verbatim history has grown beyond the window,
   * fold the oldest messages into the rolling summary and delete them.
   */
  async maybeSummarize(chat: Chat): Promise<void> {
    await this.compact(chat, this.historyWindow);
  }

  /**
   * Force compaction now, keeping only a small verbatim tail. Returns the
   * number of messages that were folded into the summary (0 if nothing to do).
   */
  async forceCompact(chat: Chat): Promise<number> {
    return this.compact(chat, 4);
  }

  /**
   * Summarize every message beyond the newest `keepCount` into the rolling
   * summary and delete them. Returns how many messages were compacted.
   */
  private async compact(chat: Chat, keepCount: number): Promise<number> {
    const total = await this.prisma.message.count({
      where: { chatId: chat.id },
    });
    if (total <= keepCount) return 0;

    const overflow = await this.prisma.message.findMany({
      where: { chatId: chat.id },
      orderBy: { createdAt: 'asc' },
      take: total - keepCount,
    });
    if (overflow.length === 0) return 0;

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

      return overflow.length;
    } catch (err) {
      this.logger.error('Failed to summarize history', err as Error);
      return 0;
    }
  }
}
