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

// Labels for the persistent reply keyboard (buttons under the input field).
export const BTN = {
  model: '🧠 Модель',
  persona: '🎭 Персона',
  summary: '📝 Сводка',
  compact: '🗜 Сжать',
  reset: '♻️ Сброс',
  help: '❓ Помощь',
} as const;

export const BUTTON_LABELS: ReadonlySet<string> = new Set(Object.values(BTN));

export function mainMenuKeyboard() {
  return Markup.keyboard([
    [BTN.model, BTN.persona],
    [BTN.summary, BTN.compact],
    [BTN.reset, BTN.help],
  ])
    .resize()
    .persistent();
}

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
