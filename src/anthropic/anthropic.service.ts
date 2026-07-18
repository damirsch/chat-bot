import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import {
  REASONING_BUDGETS,
  ReasoningLevel,
  getModel,
} from '../config/models.config';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CompletionResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export type GateAction = 'respond' | 'react' | 'silent';

export interface GateDecision {
  action: GateAction;
  emoji?: string;
}

// Model used for cheap background tasks (summarization, gate classification).
export const UTILITY_MODEL = 'claude-haiku-4-5';

// Telegram only allows a fixed set of emoji as message reactions.
export const ALLOWED_REACTIONS = [
  '👍',
  '❤',
  '🔥',
  '🥰',
  '👏',
  '😁',
  '🤔',
  '🎉',
  '👌',
  '🙏',
  '😢',
  '🤯',
  '💯',
  '🤝',
];

@Injectable()
export class AnthropicService {
  private readonly logger = new Logger(AnthropicService.name);
  private readonly client: Anthropic;
  private readonly webSearchEnabled: boolean;
  private readonly webSearchMaxUses: number;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY is not set');
    }
    this.client = new Anthropic({ apiKey });
    this.webSearchEnabled =
      this.config.get<string>('WEB_SEARCH_ENABLED') !== 'false';
    this.webSearchMaxUses = Number(
      this.config.get<string>('WEB_SEARCH_MAX_USES') ?? '5',
    );
  }

  private buildRequest(params: {
    model: string;
    reasoning: ReasoningLevel;
    system: string;
    messages: ChatMessage[];
    maxOutputTokens?: number;
  }): Anthropic.MessageCreateParamsNonStreaming {
    const { model, reasoning, system, messages } = params;
    const modelDef = getModel(model);

    const thinkingBudget =
      modelDef?.supportsReasoning && reasoning !== 'off'
        ? REASONING_BUDGETS[reasoning]
        : 0;

    const outputAllowance = params.maxOutputTokens ?? 2048;
    const maxTokens =
      thinkingBudget > 0 ? thinkingBudget + outputAllowance : outputAllowance;

    const request: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: maxTokens,
      system,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };

    if (thinkingBudget > 0) {
      request.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
    }

    if (this.webSearchEnabled) {
      request.tools = [
        {
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: this.webSearchMaxUses,
        },
      ];
    }

    return request;
  }

  private extractText(content: Anthropic.ContentBlock[]): string {
    return content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
  }

  /** One-shot completion (no streaming). */
  async complete(params: {
    model: string;
    reasoning: ReasoningLevel;
    system: string;
    messages: ChatMessage[];
    maxOutputTokens?: number;
  }): Promise<CompletionResult> {
    const response = await this.client.messages.create(
      this.buildRequest(params),
    );
    return {
      text: this.extractText(response.content) || '…',
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }

  /** Cheap deterministic call used for utility tasks like summarization. */
  async utility(params: {
    model: string;
    system: string;
    prompt: string;
    maxOutputTokens?: number;
  }): Promise<string> {
    const response = await this.client.messages.create({
      model: params.model,
      max_tokens: params.maxOutputTokens ?? 1024,
      system: params.system,
      messages: [{ role: 'user', content: params.prompt }],
    });
    return this.extractText(response.content);
  }

  /**
   * Decide whether the bot should chime into a group conversation.
   * Uses the cheap utility model and is biased strongly towards silence.
   */
  async gate(recent: ChatMessage[]): Promise<GateDecision> {
    const convo = recent
      .map((m) => `${m.role === 'user' ? 'User' : 'Bot'}: ${m.content}`)
      .join('\n');

    const system = [
      'You are an AI participant in a Telegram group chat, deciding whether to react to the latest messages.',
      'Default to staying silent — a good participant does not interrupt every message.',
      'Messages may be annotated in parentheses with who they reply to, e.g. "(в ответ Bob: «...»)". If the latest message is clearly directed at another specific participant (a reply to them, or addressing them by name) and does not need you, stay SILENT — do not butt into a conversation between other people.',
      'Choose "respond" only when it clearly adds value: a direct question you can answer, a request for help addressed to the group or to you, or a factual gap you can genuinely fill.',
      'Choose "react" for light acknowledgement (agreement, appreciation, humor) where a full message is unnecessary.',
      'Otherwise choose "silent".',
      'Reply with ONLY a compact JSON object, no prose: {"action":"respond"|"react"|"silent","emoji":"<single emoji or empty>"}.',
    ].join(' ');

    const prompt = `Recent messages:\n${convo}\n\nDecision JSON:`;

    try {
      const raw = await this.utility({
        model: UTILITY_MODEL,
        system,
        prompt,
        maxOutputTokens: 60,
      });
      return this.parseGate(raw);
    } catch (err) {
      this.logger.warn(`Gate failed, staying silent: ${String(err)}`);
      return { action: 'silent' };
    }
  }

  private parseGate(raw: string): GateDecision {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return { action: 'silent' };
    try {
      const parsed = JSON.parse(match[0]) as GateDecision;
      if (parsed.action === 'respond') return { action: 'respond' };
      if (parsed.action === 'react') {
        const emoji = (parsed.emoji ?? '').trim();
        if (ALLOWED_REACTIONS.includes(emoji)) return { action: 'react', emoji };
        return { action: 'silent' };
      }
      return { action: 'silent' };
    } catch {
      return { action: 'silent' };
    }
  }
}
