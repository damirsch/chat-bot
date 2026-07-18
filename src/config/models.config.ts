/**
 * Central registry of the Claude models the bot can switch between.
 *
 * Model ids are the real Anthropic Claude API identifiers (verified July 2026).
 * Fable 5 is intentionally excluded: it is expensive ($50/1M output) and
 * requires accepting a 30-day data-retention policy.
 */

export type ReasoningLevel = 'off' | 'low' | 'medium' | 'high';

export interface ModelDefinition {
  /** Anthropic API model id (the `model` field in the request). */
  id: string;
  /** Human label shown in the Telegram keyboard. */
  label: string;
  /** Whether this model supports extended thinking (reasoning). */
  supportsReasoning: boolean;
}

export const MODELS: ModelDefinition[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8', supportsReasoning: true },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', supportsReasoning: true },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', supportsReasoning: false },
];

export const DEFAULT_MODEL_ID = 'claude-sonnet-5';

/**
 * Token budget given to extended thinking for each reasoning level.
 * `off` disables thinking entirely.
 */
export const REASONING_BUDGETS: Record<ReasoningLevel, number> = {
  off: 0,
  low: 4000,
  medium: 10000,
  high: 24000,
};

export const REASONING_LEVELS: ReasoningLevel[] = [
  'off',
  'low',
  'medium',
  'high',
];

export function getModel(id: string): ModelDefinition | undefined {
  return MODELS.find((m) => m.id === id);
}

export function isValidModel(id: string): boolean {
  return MODELS.some((m) => m.id === id);
}
