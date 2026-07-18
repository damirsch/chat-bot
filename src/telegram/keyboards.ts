import { Markup } from 'telegraf';
import {
  MODELS,
  REASONING_LEVELS,
  ReasoningLevel,
} from '../config/models.config';

const REASONING_LABELS: Record<ReasoningLevel, string> = {
  off: 'Выкл',
  low: 'Низкий',
  medium: 'Средний',
  high: 'Высокий',
};

export function modelKeyboard(currentModel: string) {
  const rows = MODELS.map((m) => [
    Markup.button.callback(
      `${m.id === currentModel ? '✅ ' : ''}${m.label}`,
      `model:${m.id}`,
    ),
  ]);
  return Markup.inlineKeyboard(rows);
}

export function reasoningKeyboard(current: ReasoningLevel) {
  const buttons = REASONING_LEVELS.map((lvl) =>
    Markup.button.callback(
      `${lvl === current ? '✅ ' : ''}${REASONING_LABELS[lvl]}`,
      `reason:${lvl}`,
    ),
  );
  return Markup.inlineKeyboard(buttons, { columns: 2 });
}

export { REASONING_LABELS };
