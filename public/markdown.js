// Relative, not "/highlight.js": this module is also imported directly by the Node
// tests, where a root-absolute specifier does not resolve.
import { highlightCode } from "./highlight.js";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character]);
}

// Inline code and math are lifted out before escaping so that their own syntax
// (`**`, `_`, `*`) is never mistaken for emphasis, and so `$x_1$` keeps its
// subscript. They are restored once the surrounding text has been formatted.
const STASH = "\u0000";
const STASH_PATTERN = new RegExp(`${STASH}(\\d+)${STASH}`, "g");
const INLINE_CODE = /`([^`\n]+)`/g;
const PAREN_MATH = /\\\((.{1,2000}?)\\\)/g;
// A dollar pair only counts as math when it cannot be money: no space just
// inside either delimiter, no digit right after the closer, and never across a
// line break. "$5 and $10" therefore stays text.
const DOLLAR_MATH = /\$(?![\s$])((?:\\.|[^$\\\n]){1,2000}?)(?<![\s\\])\$(?!\d)/g;

function createStash(options = {}) {
  const items = [];
  return {
    items,
    html(rendered) {
      items.push({ html: rendered });
      return `${STASH}${items.length - 1}${STASH}`;
    },
    math(tex, display) {
      items.push({ tex, display });
      return `${STASH}${items.length - 1}${STASH}`;
    },
    restore(value) {
      return value.replace(STASH_PATTERN, (_match, index) => {
        const item = items[Number(index)];
        if (!item) return "";
        if (typeof item.html === "string") return item.html;
        const render = typeof options.math === "function" ? options.math : null;
        if (!render) return `<code class="math-tex">${escapeHtml(item.tex)}</code>`;
        try {
          return render(item.tex, item.display === true);
        } catch {
          return `<code class="math-tex">${escapeHtml(item.tex)}</code>`;
        }
      });
    },
  };
}

function inlineMarkdown(value, options = {}) {
  const stash = createStash(options);
  let text = String(value ?? "").replace(/\u0000/g, "");
  text = text.replace(INLINE_CODE, (_match, code) => stash.html(`<code>${escapeHtml(code)}</code>`));
  text = text.replace(PAREN_MATH, (_match, tex) => stash.math(tex, false));
  text = text.replace(DOLLAR_MATH, (_match, tex) => stash.math(tex, false));
  const formatted = escapeHtml(text)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>")
    .replace(/(?<!_)_([^_\n]+)_(?!_)/g, "<em>$1</em>");
  return stash.restore(formatted);
}

function readList(lines, start, pattern) {
  const items = [];
  let index = start;
  while (index < lines.length) {
    const match = lines[index].match(pattern);
    if (!match) break;
    items.push(`<li>${inlineMarkdown(match[1])}</li>`);
    index += 1;
  }
  return { items, next: index };
}

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let current = "";
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (character === "\\" && trimmed[index + 1] === "|") {
      current += "|";
      index += 1;
      continue;
    }
    if (character === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  cells.push(current.trim());
  return cells;
}

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function isTableStart(lines, index) {
  if (index + 1 >= lines.length) return false;
  if (!lines[index].includes("|")) return false;
  if (!TABLE_SEPARATOR.test(lines[index + 1])) return false;
  return splitRow(lines[index]).length === splitRow(lines[index + 1]).length;
}

function alignmentOf(cell) {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return left ? "left" : "";
}

/**
 * A pipe table becomes a real table.
 *
 * Agent answers lean on tables for comparisons, and as raw pipes they read as
 * noise in the middle of prose. Numbers are right-aligned by column rule, and the
 * whole table scrolls inside its own box so a narrow phone keeps its layout
 * instead of pushing the page sideways.
 */
function readTable(lines, start, options = {}) {
  const header = splitRow(lines[start]);
  const alignments = splitRow(lines[start + 1]).map(alignmentOf);
  const rows = [];
  let index = start + 2;
  while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
    const cells = splitRow(lines[index]);
    if (!cells.length) break;
    rows.push(cells);
    index += 1;
  }
  const cell = (tag, content, column) => {
    const align = alignments[column];
    return `<${tag}${align ? ` style="text-align:${align}"` : ""}>${inlineMarkdown(content, options)}</${tag}>`;
  };
  const head = `<thead><tr>${header.map((content, column) => cell("th", content, column)).join("")}</tr></thead>`;
  const body = rows.length
    ? `<tbody>${rows.map((row) => `<tr>${header.map((_unused, column) => cell("td", row[column] ?? "", column)).join("")}</tr>`).join("")}</tbody>`
    : "";
  return {
    html: `<div class="md-table-wrap"><table class="md-table">${head}${body}</table></div>`,
    next: index,
  };
}

const FENCE_OPEN = /^\s*```([a-zA-Z0-9_+#.-]{0,40})\s*$/;
const DISPLAY_MATH_ONE_LINE = /^\s*\$\$(.+?)\$\$\s*$/;
const DISPLAY_MATH_BRACKET = /^\s*\\\[(.+?)\\\]\s*$/;
const HORIZONTAL_RULE = /^\s*([-*_])\1{2,}\s*$/;

function renderDisplayMath(tex, options = {}) {
  const render = typeof options.math === "function" ? options.math : null;
  const body = render ? render(tex, true) : `<code class="math-tex">${escapeHtml(tex)}</code>`;
  return `<div class="md-math" data-display="1">${body}</div>`;
}

function renderCodeFence(language, lines) {
  const tag = language ? ` data-lang="${escapeHtml(language)}"` : "";
  const label = language ? `<span class="md-code-lang">${escapeHtml(language)}</span>` : "<span class=\"md-code-lang\">代码</span>";
  const className = language ? ` class="language-${escapeHtml(language)}"` : "";
  // Colouring is cosmetic: an unknown language falls back to escaped text, so the
  // card, the copy button and the source round-trip all stay identical.
  const body = highlightCode(lines.join("\n"), language);
  return `<div class="md-code"${tag}><div class="md-code-head">${label}`
    + `<button class="md-code-copy" type="button" data-copy-code>复制</button></div>`
    + `<pre><code${className}>${body}</code></pre></div>`;
}

// A deliberately small, safe Markdown subset for all Agent message sources.
// Agent output is escaped before formatting, so it cannot inject HTML or scripts.
// Block types are rendered by kind — tables as tables, formulas as math, fenced
// code as its own card — because one undifferentiated paragraph buries the part
// the reader actually needs.
export function renderMessageMarkdown(value, options = {}) {
  const lines = String(value ?? "").replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(FENCE_OPEN);
    if (fence) {
      const language = fence[1].toLowerCase();
      const code = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      output.push(renderCodeFence(language, code));
      continue;
    }

    // A display formula can be fenced by $$ on one line or by a $$ pair around
    // several lines; both must be taken before paragraph accumulation.
    const oneLineMath = line.match(DISPLAY_MATH_ONE_LINE) ?? line.match(DISPLAY_MATH_BRACKET);
    if (oneLineMath) {
      output.push(renderDisplayMath(oneLineMath[1].trim(), options));
      index += 1;
      continue;
    }
    if (/^\s*\$\$\s*$/.test(line)) {
      const block = [];
      index += 1;
      while (index < lines.length && !/^\s*\$\$\s*$/.test(lines[index])) {
        block.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      output.push(renderDisplayMath(block.join("\n").trim(), options));
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      output.push(`<h${level}>${inlineMarkdown(heading[2], options)}</h${level}>`);
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const table = readTable(lines, index, options);
      output.push(table.html);
      index = table.next;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const list = readList(lines, index, /^\s*[-*+]\s+(.+)$/);
      output.push(`<ul>${list.items.join("")}</ul>`);
      index = list.next;
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const list = readList(lines, index, /^\s*\d+[.)]\s+(.+)$/);
      output.push(`<ol>${list.items.join("")}</ol>`);
      index = list.next;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      output.push(`<blockquote>${quote.map((entry) => inlineMarkdown(entry, options)).join("<br>")}</blockquote>`);
      continue;
    }

    if (HORIZONTAL_RULE.test(line)) {
      output.push("<hr>");
      index += 1;
      continue;
    }

    const paragraph = [];
    while (
      index < lines.length
      && lines[index].trim()
      && !/^(#{1,3})\s+|^\s*```|^\s*[-*+]\s+|^\s*\d+[.)]\s+|^>\s?/.test(lines[index])
      && !/^\s*\$\$\s*$/.test(lines[index])
      && !DISPLAY_MATH_ONE_LINE.test(lines[index])
      && !DISPLAY_MATH_BRACKET.test(lines[index])
      && !HORIZONTAL_RULE.test(lines[index])
      && !isTableStart(lines, index)
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    output.push(`<p>${paragraph.map((entry) => inlineMarkdown(entry, options)).join("<br>")}</p>`);
  }

  return output.join("");
}
