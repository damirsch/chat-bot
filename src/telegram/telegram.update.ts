import { Logger } from '@nestjs/common';
import { Update, Start, Help, Command, On, Ctx, Action } from 'nestjs-telegraf';
import { Context } from 'telegraf';
import { ChatKind, MessageRole } from '@prisma/client';
import { ChatService } from '../chat/chat.service';
import {
  getModel,
  isValidModel,
  ReasoningLevel,
  REASONING_LEVELS,
} from '../config/models.config';
import { modelKeyboard, reasoningKeyboard, REASONING_LABELS } from './keyboards';
import { ResponderService } from './responder.service';
import { GroupGateService } from './group-gate.service';

@Update()
export class TelegramUpdate {
  private readonly logger = new Logger(TelegramUpdate.name);

  constructor(
    private readonly chat: ChatService,
    private readonly responder: ResponderService,
    private readonly groupGate: GroupGateService,
  ) {}

  @Start()
  async onStart(@Ctx() ctx: Context): Promise<void> {
    await ctx.reply(
      [
        'Привет! Я AI-бот на базе Claude.',
        '',
        'В личке отвечаю на каждое сообщение. В группах — когда меня зовут через @ или отвечают на моё сообщение, а иногда сам вступаю в разговор, если это уместно.',
        '',
        'Команды:',
        '/model — выбрать модель и уровень reasoning',
        '/persona — задать характер/поведение бота в этом чате',
        '/reset — очистить историю диалога',
        '/help — помощь',
      ].join('\n'),
    );
  }

  @Help()
  async onHelp(@Ctx() ctx: Context): Promise<void> {
    await ctx.reply(
      [
        'Я отвечаю с помощью моделей Claude от Anthropic.',
        '',
        '/model — переключить модель (Opus 4.8 / Sonnet 5 / Haiku 4.5) и reasoning.',
        '/persona — задать свой системный промпт (характер) для этого чата; /persona reset — вернуть дефолт.',
        '/reset — начать диалог с чистого листа.',
        '',
        'В группах вызывай меня через @упоминание или reply. Также я могу сам вставить реплику или поставить реакцию, когда это к месту.',
      ].join('\n'),
    );
  }

  @Command('model')
  async onModel(@Ctx() ctx: Context): Promise<void> {
    const chat = await this.resolveChat(ctx);
    if (!chat) return;
    const def = getModel(chat.model);
    await ctx.reply(
      `Текущая модель: *${def?.label ?? chat.model}*\nВыбери модель:`,
      { parse_mode: 'Markdown', ...modelKeyboard(chat.model) },
    );
  }

  @Command('reset')
  async onReset(@Ctx() ctx: Context): Promise<void> {
    const chat = await this.resolveChat(ctx);
    if (!chat) return;
    await this.chat.reset(chat.id);
    await ctx.reply('История очищена. Начнём заново 🙂');
  }

  @Command('persona')
  async onPersona(@Ctx() ctx: Context): Promise<void> {
    const chat = await this.resolveChat(ctx);
    if (!chat) return;

    const args = this.commandArgs(ctx);

    if (!args) {
      const current = chat.systemPrompt?.trim();
      await ctx.reply(
        current
          ? `Текущая персона (кастомная):\n\n${current}\n\nЧтобы задать новую: /persona <текст>\nСбросить к дефолту: /persona reset`
          : 'Сейчас используется персона по умолчанию.\n\nЗадать свою: /persona <текст>\nВернуть дефолт: /persona reset',
      );
      return;
    }

    if (args.toLowerCase() === 'reset') {
      await this.chat.setSystemPrompt(chat.id, null);
      await ctx.reply('Персона сброшена к значению по умолчанию.');
      return;
    }

    await this.chat.setSystemPrompt(chat.id, args);
    await ctx.reply('Готово — новая персона установлена для этого чата ✅');
  }

  @Action(/^model:(.+)$/)
  async onModelPick(@Ctx() ctx: Context): Promise<void> {
    const chat = await this.resolveChat(ctx);
    if (!chat) return;
    const data = this.callbackData(ctx);
    const modelId = data?.split(':')[1] ?? '';
    if (!isValidModel(modelId)) {
      await ctx.answerCbQuery('Неизвестная модель');
      return;
    }

    await this.chat.setModel(chat.id, modelId);
    const def = getModel(modelId)!;
    await ctx.answerCbQuery(`Модель: ${def.label}`);

    if (def.supportsReasoning) {
      await ctx.editMessageText(
        `Модель: *${def.label}*\nУровень reasoning:`,
        {
          parse_mode: 'Markdown',
          ...reasoningKeyboard(chat.reasoning as ReasoningLevel),
        },
      );
    } else {
      await ctx.editMessageText(`Модель установлена: *${def.label}*`, {
        parse_mode: 'Markdown',
      });
    }
  }

  @Action(/^reason:(.+)$/)
  async onReasoningPick(@Ctx() ctx: Context): Promise<void> {
    const chat = await this.resolveChat(ctx);
    if (!chat) return;
    const data = this.callbackData(ctx);
    const level = (data?.split(':')[1] ?? 'off') as ReasoningLevel;
    if (!REASONING_LEVELS.includes(level)) {
      await ctx.answerCbQuery('Неизвестный уровень');
      return;
    }

    await this.chat.setReasoning(chat.id, level);
    const def = getModel(chat.model);
    await ctx.answerCbQuery(`Reasoning: ${REASONING_LABELS[level]}`);
    await ctx.editMessageText(
      `Модель: *${def?.label ?? chat.model}*\nReasoning: *${REASONING_LABELS[level]}*`,
      { parse_mode: 'Markdown' },
    );
  }

  @On('text')
  async onText(@Ctx() ctx: Context): Promise<void> {
    const message = ctx.message;
    if (!message || !('text' in message)) return;
    const text = message.text;
    if (text.startsWith('/')) return; // commands handled elsewhere

    const chat = await this.resolveChat(ctx);
    if (!chat) return;

    const isPrivate = ctx.chat?.type === 'private';
    const senderName =
      message.from?.first_name ?? message.from?.username ?? undefined;

    const cleaned = this.stripMention(text, ctx.botInfo?.username);

    await this.chat.addMessage({
      chatId: chat.id,
      role: MessageRole.USER,
      content: cleaned,
      telegramMsgId: message.message_id,
      senderName,
    });

    const telegramChatId = Number(ctx.chat!.id);

    if (isPrivate) {
      // In private chats always reply to the user's message.
      await this.responder.respond(telegramChatId);
      return;
    }

    if (this.isAddressedToBot(ctx)) {
      // Direct @mention or reply — answer immediately.
      await this.responder.respond(telegramChatId, {
        replyToMessageId: message.message_id,
      });
      return;
    }

    // Otherwise let the smart gate decide (buffered), if enabled.
    this.groupGate.enqueue(telegramChatId, message.message_id);
  }

  private isAddressedToBot(ctx: Context): boolean {
    const message = ctx.message;
    if (!message) return false;

    const botId = ctx.botInfo?.id;
    if (
      'reply_to_message' in message &&
      message.reply_to_message?.from?.id === botId
    ) {
      return true;
    }

    if ('text' in message && 'entities' in message && message.entities) {
      const username = ctx.botInfo?.username?.toLowerCase();
      return message.entities.some((e) => {
        if (e.type === 'mention') {
          const mention = message
            .text!.slice(e.offset, e.offset + e.length)
            .toLowerCase();
          return mention === `@${username}`;
        }
        if (e.type === 'text_mention') {
          return e.user?.id === botId;
        }
        return false;
      });
    }
    return false;
  }

  private stripMention(text: string, username?: string): string {
    if (!username) return text.trim();
    return text.replace(new RegExp(`@${username}`, 'gi'), '').trim() || text;
  }

  private chatKind(ctx: Context): ChatKind {
    return ctx.chat?.type === 'private' ? ChatKind.PRIVATE : ChatKind.GROUP;
  }

  private async resolveChat(ctx: Context) {
    if (!ctx.chat) return null;
    const title =
      'title' in ctx.chat ? ctx.chat.title : ctx.chat.type === 'private'
        ? ctx.from?.first_name
        : undefined;
    return this.chat.getOrCreate(Number(ctx.chat.id), this.chatKind(ctx), title);
  }

  private callbackData(ctx: Context): string | undefined {
    const cb = ctx.callbackQuery;
    if (cb && 'data' in cb) return cb.data;
    return undefined;
  }

  /** Text after a command, e.g. "/persona be witty" -> "be witty". */
  private commandArgs(ctx: Context): string {
    const message = ctx.message;
    if (!message || !('text' in message)) return '';
    const text = message.text;
    const firstSpace = text.indexOf(' ');
    if (firstSpace === -1) return '';
    return text.slice(firstSpace + 1).trim();
  }
}
