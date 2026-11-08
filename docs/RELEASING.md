# Releasing AgentBridge

This repository can be installed directly from a tagged public GitHub release. Both npm packages are now published as well, and those tags are what the release workflow watches.

## Current state

| Package | Version | Tag prefix | Published by |
|---|---|---|---|
| `@chenacc/agentbridge` (bridge + CLI) | 0.1.4 | `bridge-v*` | GitHub Actions on tag push, OIDC trusted publishing, SLSA provenance |
| `@chenacc/dsh-agentbridge` (DSH plugin) | 0.3.3 | `dsh-v*` | same workflow |

Pushing `bridge-v0.1.5` publishes the bridge; pushing `dsh-v0.3.4` publishes the plugin. See [`PUBLISHING.md`](./PUBLISHING.md) for the full procedure and the market side of a release.

## GitHub release checklist

1. Choose and add an open-source license. Do not publish before this choice is explicit.
2. Create a Git repository and confirm no runtime data is staged. `.env`, `.agentbridge/`, `~/.agentbridge/`, logs, and `node_modules/` must remain excluded.
3. Run the release checks from the repository root:

   ```powershell
   npm ci
   npm run check
   npm test
   npm run verify:release     # plugin packaging acceptance, 17 checks
   npm pack --dry-run
   ```

4. Create a versioned commit and annotated tag — `bridge-v0.1.5` for the bridge, `dsh-v0.3.4` for the plugin — then push both the branch and tag to the public GitHub repository.
5. On a clean machine with Node.js 22+ and Codex installed, verify the installation command below, restart Codex, and invoke `/phone` from a local-project conversation.

## User installation

Windows PowerShell:

```powershell
npm install --global github:<github-owner>/<repository>#bridge-v0.1.4; agentbridge setup codex
```

macOS/Linux:

```bash
npm install --global github:<github-owner>/<repository>#bridge-v0.1.4 && agentbridge setup codex
```

`agentbridge setup codex` writes the user-level Codex skill. The package's CLI is installed globally and the generated skill records the installed CLI path, so do not replace this workflow with a temporary `npx` execution.

## Optional npm registry publication

Publish to npm only after selecting a package name that your account or organization owns. Before `npm publish`, update `package.json` with the selected scoped name, `repository`, `homepage`, `bugs`, and `license`; remove `private: true`; review the existing restrictive `files` allowlist; then publish with public access.

The documented install command can then become:

```powershell
npm install --global @<npm-scope>/agentbridge@latest; agentbridge setup codex
```

Keep the GitHub-tag command available as a reproducible alternative.
