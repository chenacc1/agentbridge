// A deliberately small syntax highlighter for fenced code.
//
// It is not a parser: one ordered regex per language family colours comments,
// strings, numbers and keywords, and everything else is escaped verbatim. That is
// enough to make a code block readable on a phone without shipping a 300 KB
// language grammar, and it keeps one hard rule: the output is always escaped
// first, so model output can never inject markup through a code fence.

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character]);
}

const JS_KEYWORDS = "const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|default|class|extends|super|new|this|typeof|instanceof|in|of|delete|void|yield|await|async|import|export|from|as|try|catch|finally|throw|null|undefined|true|false|static|get|set|interface|type|enum|implements|readonly|public|private|protected";
const PYTHON_KEYWORDS = "def|class|return|if|elif|else|for|while|import|from|as|with|try|except|finally|raise|yield|lambda|pass|break|continue|and|or|not|in|is|None|True|False|async|await|global|nonlocal|assert|del";
const SHELL_KEYWORDS = "if|then|else|elif|fi|for|while|until|do|done|case|esac|function|return|export|local|echo|cd|set|source|exit|sudo|git|npm|node";
const SQL_KEYWORDS = "select|from|where|insert|into|values|update|set|delete|create|table|alter|drop|index|join|left|right|inner|outer|group|order|by|having|limit|offset|and|or|not|null|as|on|distinct|union|count|sum|avg";
const GO_KEYWORDS = "package|import|func|return|if|else|for|range|switch|case|default|type|struct|interface|map|chan|go|defer|select|var|const|nil|true|false|break|continue|fallthrough|goto";
const RUST_KEYWORDS = "fn|let|mut|pub|use|mod|struct|enum|impl|trait|match|if|else|for|while|loop|return|self|Self|super|crate|as|in|ref|move|where|const|static|unsafe|async|await|dyn|true|false|Some|None|Ok|Err";
const C_KEYWORDS = "int|char|float|double|void|long|short|unsigned|signed|struct|union|enum|typedef|const|static|extern|return|if|else|for|while|do|switch|case|break|continue|default|sizeof|goto|class|public|private|protected|namespace|using|template|virtual|override|nullptr|true|false|new|delete|throw|try|catch";

/**
 * How each language is recognised. `pattern` is a named-group alternation, so the
 * token kind comes straight from whichever group matched.
 */
const LANGUAGES = {
  javascript: {
    // The backtick form is written as \x60 so the whole pattern can stay inside a
    // single String.raw chunk: mixing raw and plain template chunks silently ate
    // the \d and \b escapes and made this family never match anything.
    pattern: String.raw`(?<comment>//[^\n]*|/\*[\s\S]*?\*/)|(?<string>"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\x60(?:\\\\.|[^\x60\\\\])*\x60)|(?<number>\b0[xX][\da-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(?<keyword>\b(?:${JS_KEYWORDS})\b)`,
  },
  python: {
    pattern: String.raw`(?<comment>#[^\n]*)|(?<string>"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(?<number>\b0[xX][\da-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(?<keyword>\b(?:${PYTHON_KEYWORDS})\b)`,
  },
  shell: {
    pattern: String.raw`(?<comment>#[^\n]*)|(?<string>"(?:\\.|[^"\\])*"|'[^']*')|(?<number>\b\d+(?:\.\d+)?\b)|(?<keyword>\b(?:${SHELL_KEYWORDS})\b)`,
  },
  json: {
    pattern: String.raw`(?<comment>//[^\n]*)|(?<string>"(?:\\.|[^"\\\n])*")|(?<number>-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(?<keyword>\b(?:true|false|null)\b)`,
  },
  css: {
    pattern: String.raw`(?<comment>/\*[\s\S]*?\*/)|(?<string>"[^"]*"|'[^']*')|(?<number>#[\da-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?)|(?<keyword>@[a-zA-Z-]+|:root|!important)`,
  },
  html: {
    pattern: String.raw`(?<comment><!--[\s\S]*?-->)|(?<string>"[^"]*"|'[^']*')|(?<keyword></?[a-zA-Z][\w:-]*|/?>)`,
  },
  sql: {
    pattern: String.raw`(?<comment>--[^\n]*|/\*[\s\S]*?\*/)|(?<string>'(?:''|[^'])*')|(?<number>\b\d+(?:\.\d+)?\b)|(?<keyword>\b(?:${SQL_KEYWORDS})\b)`,
  },
  yaml: {
    pattern: String.raw`(?<comment>#[^\n]*)|(?<string>"[^"\n]*"|'[^'\n]*')|(?<number>\b-?\d+(?:\.\d+)?\b)|(?<keyword>\b[\w.-]+:(?=\s|$)|^\s*-(?=\s))`,
  },
  go: {
    pattern: String.raw`(?<comment>//[^\n]*|/\*[\s\S]*?\*/)|(?<string>"(?:\\.|[^"\\\n])*"|\x60[^\x60]*\x60)|(?<number>\b0[xX][\da-fA-F]+\b|\b\d+(?:\.\d+)?\b)|(?<keyword>\b(?:${GO_KEYWORDS})\b)`,
  },
  rust: {
    pattern: String.raw`(?<comment>//[^\n]*|/\*[\s\S]*?\*/)|(?<string>"(?:\\.|[^"\\\n])*")|(?<number>\b\d+(?:\.\d+)?(?:[a-z]\w*)?\b)|(?<keyword>\b(?:${RUST_KEYWORDS})\b)`,
  },
  c: {
    pattern: String.raw`(?<comment>//[^\n]*|/\*[\s\S]*?\*/)|(?<string>"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\n])')|(?<number>\b0[xX][\da-fA-F]+\b|\b\d+(?:\.\d+)?[fFuUlL]?\b)|(?<keyword>\b(?:${C_KEYWORDS})\b)`,
  },
};

const ALIASES = {
  js: "javascript", jsx: "javascript", ts: "javascript", tsx: "javascript", mjs: "javascript", cjs: "javascript", node: "javascript",
  py: "python", python3: "python",
  sh: "shell", shell: "shell", bash: "shell", zsh: "shell", console: "shell", ps1: "shell", powershell: "shell", cmd: "shell",
  json5: "json", jsonc: "json",
  scss: "css", less: "css",
  xml: "html", svg: "html", vue: "html", markup: "html",
  postgres: "sql", postgresql: "sql", mysql: "sql", sqlite: "sql", tsql: "sql",
  yml: "yaml",
  golang: "go",
  rs: "rust",
  cpp: "c", "c++": "c", cc: "c", h: "c", hpp: "c", cs: "c", java: "c", kotlin: "c", swift: "c", php: "c", objectivec: "c",
};

export function normalizeLanguage(language) {
  const key = String(language ?? "").trim().toLowerCase();
  if (!key) return null;
  if (LANGUAGES[key]) return key;
  return ALIASES[key] ?? null;
}

/** Families this highlighter can colour; used by the tests to cover all of them. */
export function supportedLanguages() {
  return Object.keys(LANGUAGES);
}

const COMPILED = new Map();

function patternFor(language) {
  const family = normalizeLanguage(language);
  if (!family) return null;
  if (!COMPILED.has(family)) COMPILED.set(family, new RegExp(LANGUAGES[family].pattern, "g"));
  return COMPILED.get(family);
}

/**
 * Highlight `code` for `language`, or escape it unchanged when the language is not
 * one we colour. Either way the output is HTML-safe.
 */
export function highlightCode(code, language) {
  const source = String(code ?? "");
  const pattern = patternFor(language);
  if (!pattern) return escapeHtml(source);
  pattern.lastIndex = 0;
  let html = "";
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    const kind = Object.keys(match.groups ?? {}).find((group) => match.groups[group] !== undefined);
    if (!kind) continue;
    html += escapeHtml(source.slice(cursor, match.index));
    html += `<span class="tok-${kind}">${escapeHtml(match[0])}</span>`;
    cursor = match.index + match[0].length;
  }
  html += escapeHtml(source.slice(cursor));
  return html;
}
