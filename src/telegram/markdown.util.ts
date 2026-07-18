/**
 * Convert the CommonMark-ish Markdown that Claude produces into the limited
 * HTML subset that Telegram's `parse_mode: 'HTML'` understands.
 *
 * Telegram supports only a handful of tags (<b>, <i>, <u>, <s>, <code>,
 * <pre>, <a>, <blockquote>) and does NOT render Markdown headings or bullet
 * markers. So we translate:
 *   - headings (#, ##, …) -> bold line
 *   - **bold** / __bold__  -> <b>
 *   - *italic* / _italic_  -> <i>
 *   - `code` and ```blocks``` -> <code> / <pre>
 *   - [text](url)          -> <a href>
 *   - -, * bullets         -> •
 * Everything else is HTML-escaped so it renders literally.
 */

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function markdownToTelegramHtml(src: string): string {
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  // 1. Pull out fenced code blocks so their contents are left untouched.
  let text = src.replace(
    /```[ \t]*([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g,
    (_m, lang: string, code: string) => {
      const body = escapeHtml(code.replace(/\n$/, ''));
      const langAttr = lang
        ? ` class="language-${escapeHtml(lang)}"`
        : '';
      const html = lang
        ? `<pre><code${langAttr}>${body}</code></pre>`
        : `<pre>${body}</pre>`;
      codeBlocks.push(html);
      return `\u0000CB${codeBlocks.length - 1}\u0000`;
    },
  );

  // 2. Pull out inline code.
  text = text.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000IC${inlineCodes.length - 1}\u0000`;
  });

  // 3. Escape the remaining prose.
  text = escapeHtml(text);

  // 4. Block-level: headings -> bold, bullets -> •, hr -> blank.
  text = text.replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, '<b>$1</b>');
  text = text.replace(/^[ \t]*[-*][ \t]+/gm, '• ');
  text = text.replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '');

  // 5. Inline emphasis. Bold before italic so ** isn't eaten by the * rule.
  text = text.replace(/\*\*(?=\S)([^\n]+?)\*\*/g, '<b>$1</b>');
  text = text.replace(/__(?=\S)([^\n]+?)__/g, '<b>$1</b>');
  text = text.replace(
    /(^|[^\w*])\*(?=\S)([^*\n]+?)\*(?![\w*])/g,
    '$1<i>$2</i>',
  );
  text = text.replace(
    /(^|[^\w_])_(?=\S)([^_\n]+?)_(?![\w_])/g,
    '$1<i>$2</i>',
  );

  // 6. Links: [text](url)
  text = text.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2">$1</a>',
  );

  // 7. Restore code.
  text = text.replace(/\u0000IC(\d+)\u0000/g, (_m, i: string) => inlineCodes[+i]);
  text = text.replace(/\u0000CB(\d+)\u0000/g, (_m, i: string) => codeBlocks[+i]);

  return text;
}
