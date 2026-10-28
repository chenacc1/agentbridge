import test from "node:test";
import assert from "node:assert/strict";
import { renderMessageMarkdown } from "../public/markdown.js";

test("message markdown creates readable headings, lists, emphasis and code without allowing HTML", () => {
  const rendered = renderMessageMarkdown(`## 执行结果

已完成 **关键修复**：
- 修复模型选择
- 验证测试

使用 \`npm test\` 验证。

\`\`\`js
console.log("ok");
\`\`\`

<img src=x onerror=alert(1)>`);

  assert.match(rendered, /<h2>执行结果<\/h2>/);
  assert.match(rendered, /<strong>关键修复<\/strong>/);
  assert.match(rendered, /<ul><li>修复模型选择<\/li><li>验证测试<\/li><\/ul>/);
  assert.match(rendered, /<code>npm test<\/code>/);
  assert.match(rendered, /<pre><code class="language-js">console\.log\(<span class="tok-string">&quot;ok&quot;<\/span>\);<\/code><\/pre>/);
  assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(rendered, /<img/);
});

// Agent answers lean on tables, formulas and code. As raw text they read as one
// undifferentiated block, so each is rendered by its own kind.
test("tables become real tables with column alignment and inline formatting", () => {
  const rendered = renderMessageMarkdown([
    "| 方案 | 延迟 | 说明 |",
    "| --- | ---: | :---: |",
    "| 本地 | 12ms | **快** |",
    "| 云端 | `180ms` | 慢 |",
  ].join("\n"));

  assert.match(rendered, /<div class="md-table-wrap"><table class="md-table">/);
  assert.match(rendered, /<th>方案<\/th>/);
  assert.match(rendered, /<th style="text-align:right">延迟<\/th>/);
  assert.match(rendered, /<th style="text-align:center">说明<\/th>/);
  assert.match(rendered, /<td style="text-align:right">12ms<\/td>/);
  assert.match(rendered, /<td style="text-align:center"><strong>快<\/strong><\/td>/);
  assert.match(rendered, /<code>180ms<\/code>/);
  assert.equal((rendered.match(/<tr>/g) ?? []).length, 3);
});

test("a pipe row without a separator stays prose, and table cells cannot inject html", () => {
  const prose = renderMessageMarkdown("a | b | c 只是普通文本");
  assert.doesNotMatch(prose, /<table/);
  assert.match(prose, /<p>a \| b \| c 只是普通文本<\/p>/);

  const injected = renderMessageMarkdown([
    "| 名字 | 备注 |",
    "| --- | --- |",
    "| <img src=x onerror=alert(1)> | `</table><script>x</script>` |",
  ].join("\n"));
  assert.doesNotMatch(injected, /<img/);
  assert.doesNotMatch(injected, /<script/);
  assert.match(injected, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(injected, /&lt;\/table&gt;/);
});

test("formulas use the provided typesetter and never become raw TeX", () => {
  const calls = [];
  const options = { math: (tex, display) => { calls.push({ tex, display }); return `<span class="katex">${tex}</span>`; } };
  const rendered = renderMessageMarkdown([
    "质能关系 $E = mc^2$ 与行内 `$x_1$` 不同。",
    "",
    "$$",
    "\\sum_{i=1}^{n} i",
    "$$",
    "",
    "\\[ a^2 + b^2 = c^2 \\]",
  ].join("\n"), options);

  assert.deepEqual(calls, [
    { tex: "E = mc^2", display: false },
    { tex: "\\sum_{i=1}^{n} i", display: true },
    { tex: "a^2 + b^2 = c^2", display: true },
  ]);
  // Inline code keeps its literal dollars instead of becoming a formula.
  assert.match(rendered, /<code>\$x_1\$<\/code>/);
  assert.match(rendered, /<div class="md-math" data-display="1">/);
});

test("currency is not mistaken for a formula", () => {
  const calls = [];
  const options = { math: (tex) => { calls.push(tex); return `<span class="katex">${tex}</span>`; } };
  const rendered = renderMessageMarkdown("成本 $5 与 $10 之间的差额，以及 $12.5 的单价。", options);
  assert.deepEqual(calls, []);
  assert.match(rendered, /成本 \$5 与 \$10 之间的差额/);
});

test("without a typesetter a formula degrades to readable escaped tex", () => {
  const rendered = renderMessageMarkdown("公式 $$\\frac{1}{2}$$ 作废?");
  assert.match(rendered, /<code class="math-tex">\\frac\{1\}\{2\}<\/code>/);
});

test("fenced code becomes its own card with a language label and copy control", () => {
  const rendered = renderMessageMarkdown([
    "先执行：",
    "",
    "```python",
    "def f(x):",
    "    return x * 2",
    "```",
  ].join("\n"));

  assert.match(rendered, /<div class="md-code" data-lang="python">/);
  assert.match(rendered, /<span class="md-code-lang">python<\/span>/);
  assert.match(rendered, /<button class="md-code-copy" type="button" data-copy-code>复制<\/button>/);
  // The fence is coloured now, so the source is compared after stripping tokens.
  const body = rendered.match(/<pre><code class="language-python">([\s\S]*?)<\/code><\/pre>/)[1]
    .replace(/<\/?span[^>]*>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  assert.equal(body, "def f(x):\n    return x * 2");
  assert.match(rendered, /<span class="tok-keyword">def<\/span>/);
  // A table-looking line inside a fence must stay code.
  const table = renderMessageMarkdown(["```", "| a | b |", "| --- | --- |", "```"].join("\n"));
  assert.doesNotMatch(table, /<table/);
});

test("code fences colour their tokens and stay escaped", async () => {
  const { highlightCode, normalizeLanguage } = await import("../public/highlight.js");
  assert.equal(normalizeLanguage("ts"), "javascript");
  assert.equal(normalizeLanguage("BASH"), "shell");
  assert.equal(normalizeLanguage("no-such-language"), null);

  const js = highlightCode('const x = 42; // note\nreturn "hi";', "js");
  assert.match(js, /<span class="tok-keyword">const<\/span>/);
  assert.match(js, /<span class="tok-number">42<\/span>/);
  assert.match(js, /<span class="tok-comment">\/\/ note<\/span>/);
  assert.match(js, /<span class="tok-string">&quot;hi&quot;<\/span>/);

  const python = highlightCode("def f():\n    # c\n    return 1", "python");
  assert.match(python, /<span class="tok-keyword">def<\/span>/);
  assert.match(python, /<span class="tok-comment"># c<\/span>/);

  // Unknown languages are escaped and left alone.
  const plain = highlightCode("a < b && c > d", "no-such-language");
  assert.equal(plain, "a &lt; b &amp;&amp; c &gt; d");
  assert.doesNotMatch(plain, /tok-/);

  // Model output can never close the code element or open a script.
  const injected = highlightCode('</code><script>alert("x")</script>', "js");
  assert.doesNotMatch(injected, /<script/);
  assert.doesNotMatch(injected, /<\/code>/);
  assert.match(injected, /&lt;\/code&gt;/);
});

test("a coloured fence keeps its exact source text and copy affordance", () => {
  const rendered = renderMessageMarkdown(["```js", "const a = 1;", "```"].join("\n"));
  assert.match(rendered, /<div class="md-code" data-lang="js">/);
  assert.match(rendered, /data-copy-code/);
  assert.match(rendered, /<span class="tok-keyword">const<\/span> a = <span class="tok-number">1<\/span>;/);
  // Stripping the token spans must return the original source verbatim.
  const stripped = rendered
    .replace(/<\/?span[^>]*>/g, "")
    .match(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/)[1]
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  assert.equal(stripped, "const a = 1;");
});

// A family whose regex was mangled silently fell back to plain text, and only the
// language actually being rendered showed it. Cover every family with a snippet
// that must produce at least one token.
test("every supported language actually colourises its own syntax", async () => {
  const { highlightCode, supportedLanguages, normalizeLanguage } = await import("../public/highlight.js");
  const samples = {
    javascript: 'const a = 1; // note\nconst s = "hi";',
    python: "def f():\n    # note\n    return 1",
    shell: "git status # note\nif [ -f a ]; then echo 1; fi",
    json: '{"a": 1, "b": true}',
    css: ".a { color: #fff; width: 12px }",
    html: '<div class="a">x</div>',
    sql: "SELECT a FROM t WHERE b = 1 -- note",
    yaml: "# note\nkey: 1",
    go: 'package main\nfunc main() { return }',
    rust: "fn main() { let x = 1; }",
    c: "int main() { return 0; }",
  };
  assert.deepEqual(supportedLanguages().sort(), Object.keys(samples).sort(), "a language was added without a sample");
  for (const [language, source] of Object.entries(samples)) {
    const html = highlightCode(source, language);
    assert.match(html, /class="tok-/, `${language} produced no tokens`);
    assert.doesNotMatch(html, /<script/, `${language} leaked a tag`);
    const text = html.replace(/<\/?span[^>]*>/g, "")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    assert.equal(text, source, `${language} changed the source text`);
    assert.notEqual(normalizeLanguage(language), null);
  }
});
