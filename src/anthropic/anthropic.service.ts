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

    const useThinking = !!modelDef?.supportsReasoning && reasoning !== 'off';

    // Adaptive thinking lets the model size its own reasoning; effort steers it.
    // Give a generous output ceiling so thinking + answer both fit.
    const maxTokens =
      params.maxOutputTokens ?? (useThinking ? REASONING_BUDGETS[reasoning] : 2048);

    // Prompt caching: cache the stable system prefix (persona + summary), and
    // set a rolling cache breakpoint on the last message so the whole growing
    // history prefix is cached and reused on the next turn (5-min ephemeral TTL,
    // ~90% cheaper reads). Only pays off within an active conversation.
    const mappedMessages: Anthropic.MessageParam[] = messages.map((m, i) => {
      if (i === messages.length - 1) {
        return {
          role: m.role,
          content: [
            {
              type: 'text',
              text: m.content,
              cache_control: { type: 'ephemeral' },
            },
          ],
        };
      }
      return { role: m.role, content: m.content };
    });

    const request: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: maxTokens,
      system: [
        { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
      ],
      messages: mappedMessages,
    };

    if (useThinking) {
      request.thinking = { type: 'adaptive' };
      request.output_config = { effort: reasoning };
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

  /**
   * One-shot completion (no streaming). Server-side tools (web_search) are
   * resolved by Anthropic transparently. When `tools`/`onToolUse` are given,
   * client-side tool calls (e.g. set_reaction) are executed locally in a short
   * loop until the model produces its final text answer.
   */
  async complete(params: {
    model: string;
    reasoning: ReasoningLevel;
    system: string;
    messages: ChatMessage[];
    maxOutputTokens?: number;
    tools?: Anthropic.MessageCreateParamsNonStreaming['tools'];
    onToolUse?: (name: string, input: unknown) => Promise<string>;
  }): Promise<CompletionResult> {
    const request = this.buildRequest(params);
    if (params.tools?.length) {
      request.tools = [...(request.tools ?? []), ...params.tools];
    }

    const convo: Anthropic.MessageParam[] = [...request.messages];
    let inputTokens = 0;
    let outputTokens = 0;

    for (let step = 0; step < 5; step++) {
      const response = await this.client.messages.create({
        ...request,
        messages: convo,
      });
      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;
      this.logger.debug(
        `usage in=${response.usage.input_tokens} ` +
          `cacheRead=${response.usage.cache_read_input_tokens ?? 0} ` +
          `cacheWrite=${response.usage.cache_creation_input_tokens ?? 0} ` +
          `out=${response.usage.output_tokens}`,
      );

      if (response.stop_reason === 'tool_use' && params.onToolUse) {
        const toolUses = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
        );
        convo.push({ role: 'assistant', content: response.content });
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const tu of toolUses) {
          let content: string;
          try {
            content = await params.onToolUse(tu.name, tu.input);
          } catch (err) {
            content = `Error: ${String(err)}`;
          }
          results.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content,
          });
        }
        convo.push({ role: 'user', content: results });
        continue;
      }

      return {
        text: this.extractText(response.content) || '…',
        inputTokens,
        outputTokens,
      };
    }

    return { text: '…', inputTokens, outputTokens };
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
