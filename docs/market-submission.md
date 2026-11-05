# 提交收录：已完成 + 规则实录

**状态（2026-11-05）**

| 项 | 结果 |
|---|---|
| npm 包 | `@chenacc/dsh-agentbridge@0.1.0` 已发布，`dsh.bundle.patch = ./cordis.patch.yml` |
| 收录 PR | https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/12416 |
| 分支 / 文件 | `chenacc1:add-chenacc1-agentbridge` → `data/plugins/chenacc1__agentbridge--integrations-dsh-phone.yml` |
| 仓库 topic | 已加 `dsh-plugin`、`deepseek-harness` |
| 本地条目文件 | `docs/awesome-dsh-plugin/chenacc1_agentbridge.yml` |

## contributing.md 的真实规则（2026-11 抓取，别再凭印象）

- **README 是脚本生成的，不要手改。** 数据在 `data/plugins/`，一个插件一个 YAML。
- 文件名由 url 决定：`slugFor(url)` = `owner__repo`，monorepo 子包再接 `--路径-用连字符`。我们是
  `chenacc1__agentbridge--integrations-dsh-phone.yml`。文件名与 url 不匹配会被校验拒绝。
- 条目只允许这些键：`url` / `name` / `category` / `description` / `icon` / `tarball`。
  **没有 `npm:` 字段**——npm 包是从仓库的 `package.json` 的 `repository` 反查出来的，手写会被拒。
- `description.en` 必填、单行、句号结尾；`zh` 可选（不写由维护者补）。含 `: ` 必须加引号。
- `category` 取值：`agi ui usage theme model identity session memory tools wsl browser vision voice docs skill workflow git notify dev security remote market fun`。我们用 `remote`。
- monorepo 子包：`url` 指子目录（`.../tree/main/<path>`），`name` 用 `owner/repo#子包名`。

## CI 会卡什么（读 `scripts/check-submission.mjs` 确认过）

1. 一个 PR 最多 3 条；
2. `dsh.bundle`——**扫仓库里最多 40 个 `package.json`**，只要有一个声明 `dsh.bundle` 就通过；只声明 `dsh.client` 会失败。所以 `integrations/dsh-phone` 这种非 `packages/` 目录也能过；
3. 仓库创建满 1 天（我们 2026-09-13 建，OK）；
4. `awesome-lint` + 站点构建（双语一致、分隔符、日期、截图）。

## 仍建议补的两件事（非阻塞）

1. **把本地改动推到 GitHub**。现在 GitHub 上 `integrations/dsh-phone/package.json` 还是旧版（`@agentbridge/dsh-phone`、`private: true`）。列表指向的目录越新，评审读起来越顺：

   ```powershell
   git add -A; git commit -m "feat(dsh): publish dsh-agentbridge to npm, add market submission docs"; git push
   ```

2. **截图**（市场详情页会展示）：在插件子目录放 `screenshots.json`，相对路径指向仓库里已有图片，例如

   ```json
   ["../../docs/assets/screen-mobile-1.png"]
   ```

   注意相对路径不能跳出插件目录，所以更稳的做法是把 1-3 张截图复制到 `integrations/dsh-phone/assets/` 再引用。截图要 GitHub 托管（raw.githubusercontent 等），第三方图床会被拒。

## 评审关注点（照 contributing 原文）

- 描述必须与代码一致，提到命令或 API 就必须存在——夸大是主要打回原因；
- 分类不会被"打回"，选得不准维护者直接改；
- 被要求修改时会打 `held: author` 标签：推到**同一分支**，留**一条**评论说明改了什么即可，反复推送不会更快。

## 下一步（等合并后）

- 市场目录有缓存，搜到可能延迟几小时到一天；
- 发新版：改 `version` → 重跑 `scripts/publish-dsh-agentbridge.ps1` → 已装用户在「已安装」页点更新；
- 不想等审核时可自托管来源（设置 → 插件市场 → 高级 → 来源 → 添加标准来源），需要 `catalog-source.json` + `/v1/plugins` 两个 JSON，需要就说。
