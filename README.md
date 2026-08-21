# picc-glob

Claude Code-style **Glob** (file finder) tool for [pi](https://pi.dev) — a faithful port of Claude Code's `Glob` tool (the file-finder Claude Code exposes as "find"), backed by **ripgrep**.

Part of [picc](https://github.com/Ladbaby/picc), a pi agent setup mirroring Claude Code's harness.

> pi's built-in `find` uses `fd` and different defaults, so it is *not* a faithful
> port of Claude Code. This extension replicates Claude Code's `Glob` exactly:
> `rg --files --glob <pattern> --sort=modified --no-ignore --hidden <dir>`.

## Usage

Install via `pi install npm:@ladbabynpm/picc-glob`.

## Tool

- **Name:** `Glob` (default) or `find` — configurable (see below).
- **Parameters:**
  - `pattern` (string, required) — the glob pattern to match files against.
  - `path` (string, optional) — directory to search in (default: cwd). Omit for
    the default; do not pass `"undefined"`/`"null"`.
- **Behavior:** results sorted by mtime, relativized to cwd, capped at 100 files.
  Output is the exact Claude Code format: newline-joined paths, or
  `No files found`, plus a single trailing truncation notice when capped.
- Requires `rg` (ripgrep) on `PATH`.

## Configuration

| Setting | Where | Values | Default |
|---|---|---|---|
| `toolName` | `config.json` | `"Glob"` \| `"find"` | `"Glob"` |
| `PICC_GLOB_TOOL_NAME` | env | `"Glob"` \| `"find"` | — |
| `PICC_GLOB_CONFIG_PATH` | env | absolute path to a config.json | sibling of `index.ts` |
| `PI_GLOB_NO_IGNORE` | env | truthy = add `--no-ignore` | on |
| `PI_GLOB_HIDDEN` | env | truthy = add `--hidden` | on |
| `PI_GLOB_TIMEOUT_SECONDS` | env | timeout in seconds | 20 (60 on WSL) |

Precedence for the tool name: `PICC_GLOB_TOOL_NAME` env > `config.json` > `"Glob"`.

`config.json` is read from `~/.pi/agent/extensions/picc-glob/config.json` by default.

```json
{ "toolName": "Glob" }
```

## Development

- `npm run lint` — biome check
- `npm run lint:fix` — biome check --write
- `npm run typecheck` — tsc --noEmit

No `any`; top-level imports only; strict TypeScript (ES2022, bundler resolution).
Dependencies beyond `node:*` are limited to `typebox` and
`@earendil-works/pi-coding-agent` (both bundled with pi).

## References

- Claude Code `Glob` tool: `replications/claude-code/tools/GlobTool/GlobTool.ts`
- Claude Code glob logic: `replications/claude-code/utils/glob.ts`
- Claude Code ripgrep: `replications/claude-code/utils/ripgrep.ts`
- Claude Code path helpers: `replications/claude-code/utils/path.ts`
