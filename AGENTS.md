# AGENTS.md

## What this repo ships

One OpenCode v2 plugin. It starts a PHP language server and answers four tools
from it, because OpenCode v2 runs no language server of its own
([#38528](https://github.com/anomalyco/opencode/issues/38528)).

## Layout

| File | Role |
| --- | --- |
| `index.js` | The plugin: tools, schemas, the Symfony switch |
| `client.js` | LSP client over stdio, one process per project root |
| `index.test.mjs` | The whole test suite, `node --test` |
| `fixtures/fake-lsp.mjs` | A fake server, so the suite needs no PHP |

## Hard rules

- A tool must return a readable sentence on failure, never throw a stack trace
  at the agent. A dead server, a missing file and a bad path all have a message.
- One process per project root, keyed by root and command. Starting a second
  one doubles the cost for no benefit.
- `php_definition`, `php_references` and `php_hover` stay on intelephense.
  `symfony-lsp` answers `null` for all three; do not route them there.
- The plugin reads `.symfony-lsp.json` only to decide which server to use. The
  server reads it itself. Do not parse its contents here.
- No dependency outside `node:` builtins.

## The Symfony path

`php_diagnostics` uses `symfony-lsp` when the project root holds a
`.symfony-lsp.json`. That server publishes an empty diagnostics list before it
boots the application, then publishes again once its runtime index is ready.
`waitForIndex()` waits for the `Runtime index ready` progress event, and the
`fresh` flag of `waitForDiagnostics()` reads past the cached empty push. Remove
either and the tool answers "no diagnostics" in 200 ms, which is false.

## Before you commit

```bash
npm test
node --check index.js
node --check client.js
```

## Release

The `Release` workflow publishes when the `package.json` version is absent
from npm. Bump first, push second.

```bash
npm version patch --no-git-tag-version
git add -A && git commit -m "chore: release X.Y.Z"
git push origin main
```

## Commits

Imperative subject, 72 characters or fewer, no trailing period.
