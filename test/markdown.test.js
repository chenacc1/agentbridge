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
  assert.match(rendered, /<pre><code class="language-js">console\.log\(&quot;ok&quot;\);<\/code><\/pre>/);
  assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(rendered, /<img/);
});
