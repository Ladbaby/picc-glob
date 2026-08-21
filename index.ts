/**
 * picc-glob: Claude Code-style Glob (file finder) tool for pi.
 *
 * A faithful port of Claude Code's `Glob` tool (the file-finder that Claude Code
 * exposes as "find"). Claude Code's Glob is backed by **ripgrep**, not the Unix
 * `find` or a glob library:
 *
 *   rg --files --glob <pattern> --sort=modified --no-ignore --hidden <dir>
 *
 * Behavior replicated from `replications/claude-code`:
 *   - Input schema: `{ pattern: string, path?: string }` (verbatim from
 *     `tools/GlobTool/GlobTool.ts` / `Glob_schema.json`).
 *   - `path` is expanded (`~`, POSIX-style Windows paths, relative → absolute)
 *     via a port of `utils/path.ts` `expandPath`.
 *   - Absolute `pattern`s are split into a base directory + relative pattern via
 *     a port of `utils/glob.ts` `extractGlobBaseDirectory` (rg `--glob` only
 *     accepts relative patterns).
 *   - `--no-ignore` / `--hidden` are on by default, overridable via
 *     `PI_GLOB_NO_IGNORE` / `PI_GLOB_HIDDEN` (mirrors Claude Code's
 *     `CLAUDE_CODE_GLOB_NO_IGNORE` / `CLAUDE_CODE_GLOB_HIDDEN`, pi-prefixed).
 *   - Results are relativized against cwd (`toRelativePath`), capped at 100
 *     (`globLimits.maxResults ?? 100`), and the tool result text is Claude
 *     Code's exact format: newline-joined paths, or `"No files found"`, with a
 *     single trailing truncation notice when capped.
 *   - 20 s timeout (60 s on WSL), overridable via `PI_GLOB_TIMEOUT_SECONDS`;
 *     SIGTERM→SIGKILL escalation; EAGAIN ("os error 11") retries once with
 *     `-j 1` — a port of `utils/ripgrep.ts` `ripGrep`/`ripGrepRaw`.
 *
 * Tool name configuration:
 *   - Default: `"Glob"` (Claude Code's actual tool name).
 *   - Set `config.json` `toolName` to `"find"` (default location
 *     `~/.pi/agent/extensions/picc-glob/config.json`), or set
 *     `PICC_GLOB_TOOL_NAME=find`. Valid values: `"Glob"`, `"find"`.
 *
 * Requires `rg` (ripgrep) on PATH.
 *
 * References:
 * - Claude Code Glob tool: tools/GlobTool/GlobTool.ts (+ prompt.ts, UI.tsx)
 * - Claude Code glob logic: utils/glob.ts
 * - Claude Code ripgrep: utils/ripgrep.ts
 * - Claude Code path helpers: utils/path.ts
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	normalize,
	relative,
	resolve,
	sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ============================================================================
// Config
// ============================================================================

/** Tool names the glob tool may be registered as. */
const VALID_TOOL_NAMES = ["Glob", "find"] as const;
type ToolName = (typeof VALID_TOOL_NAMES)[number];

/**
 * Resolve the config.json path. The file is a sibling of this module
 * (`extensions/picc-glob/config.json`). Override at runtime via
 * PICC_GLOB_CONFIG_PATH.
 */
function resolveConfigPath(): string {
	const env = process.env.PICC_GLOB_CONFIG_PATH;
	if (env) return env;
	const here = dirname(fileURLToPath(import.meta.url));
	return join(here, "config.json");
}

function readToolNameFromConfig(): ToolName | undefined {
	const configPath = resolveConfigPath();
	if (!existsSync(configPath)) return undefined;
	try {
		const raw = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw) as { toolName?: unknown };
		const val = parsed?.toolName;
		if (
			typeof val === "string" &&
			(VALID_TOOL_NAMES as readonly string[]).includes(val)
		) {
			return val as ToolName;
		}
		if (val !== undefined) {
			console.warn(
				`[picc-glob] config.json: invalid toolName "${val}" — valid values are ${VALID_TOOL_NAMES.join(", ")}. Falling back to "Glob".`,
			);
		}
	} catch {
		// unreadable / malformed — fall through to default
	}
	return undefined;
}

function loadToolName(): ToolName {
	// Precedence: PICC_GLOB_TOOL_NAME env var > config.json > "Glob" default
	const envVal = process.env.PICC_GLOB_TOOL_NAME;
	if (typeof envVal === "string") {
		if ((VALID_TOOL_NAMES as readonly string[]).includes(envVal)) {
			return envVal as ToolName;
		}
		console.warn(
			`[picc-glob] PICC_GLOB_TOOL_NAME="${envVal}" is invalid — valid values are ${VALID_TOOL_NAMES.join(", ")}. Falling back to "Glob".`,
		);
	}
	return readToolNameFromConfig() ?? "Glob";
}

// ============================================================================
// Constants
// ============================================================================

/** Mirrors Claude Code `globLimits.maxResults ?? 100` (GlobTool.ts). */
const DEFAULT_LIMIT = 100;

/** Mirrors Claude Code `utils/ripgrep.ts` MAX_BUFFER_SIZE (20 MB). */
const MAX_BUFFER_SIZE = 20_000_000;

/**
 * Tool description — verbatim from Claude Code `tools/GlobTool/prompt.ts`
 * (`Glob_description.md`).
 */
const DESCRIPTION = `- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead`;

const TRUNCATION_NOTICE =
	"(Results are truncated. Consider using a more specific path or pattern.)";

// ============================================================================
// Path helpers (ports of claude-code utils/path.ts)
// ============================================================================

function isWindows(): boolean {
	return platform() === "win32";
}

/**
 * WSL is not a value in Node's `Platform` union, so compare against the
 * string form (Claude Code's `getPlatform() === 'wsl'`).
 */
function isWsl(): boolean {
	return (platform() as string) === "wsl";
}

/**
 * Port of claude-code `expandPath(path, baseDir)`. Handles `~`, POSIX-style
 * Windows paths (`/c/Users/...`), and relative→absolute resolution.
 */
function posixPathToWindowsPath(posixPath: string): string {
	const m = posixPath.match(/^\/([a-zA-Z])\/(.*)$/);
	if (m) {
		return `${m[1]}:/${(m[2] ?? "").split("/").join("\\")}`;
	}
	return posixPath;
}

function expandPath(input: string, baseDir: string): string {
	const trimmed = input.trim();
	if (!trimmed) return normalize(baseDir);

	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));

	let processed = trimmed;
	if (isWindows() && /^\/[a-z]\//i.test(trimmed)) {
		processed = posixPathToWindowsPath(trimmed);
	}

	if (isAbsolute(processed)) return normalize(processed);
	return resolve(baseDir, processed);
}

/**
 * Port of claude-code `toRelativePath`: relativize against cwd, keeping the
 * absolute path when it would escape cwd (starts with `..`).
 */
function toRelativePath(absolutePath: string, cwd: string): string {
	const rel = relative(cwd, absolutePath);
	return rel.startsWith("..") ? absolutePath : rel;
}

/**
 * Resolve a path as returned by ripgrep against the search directory.
 *
 * rg emits paths relative to its target directory. On Windows the output
 * mixes separators (a drive-rooted prefix uses `/`, the rest uses `\`, e.g.
 * `C:/c/Users/...\file`), and Node's `path.join` mangles drive-rooted
 * relative paths (`join('C:\a', 'C:/b')` → `C:\a\C:\b`). So:
 *   - if the path is already absolute (either separator) → normalize it;
 *   - else if it starts with the search directory → slice it off;
 *   - otherwise fall back to `path.join` (correct for `.`-relative and
 *     plain drive-relative paths).
 */
function resolveRgPath(p: string, searchDir: string): string {
	const norm = p.replace(/\//g, sep);
	if (isAbsolute(norm)) return normalize(norm);
	if (isAbsolute(p)) return normalize(p);
	if (p.startsWith(searchDir)) return normalize(p.slice(searchDir.length));
	return normalize(join(searchDir, p));
}

/**
 * Port of claude-code `extractGlobBaseDirectory`: split an absolute glob
 * pattern into a static base directory and the remaining relative pattern
 * (rg `--glob` only accepts relative patterns).
 */
function extractGlobBaseDirectory(pattern: string): {
	baseDir: string;
	relativePattern: string;
} {
	const globChars = /[*?[{]/;
	const match = pattern.match(globChars);

	if (!match || match.index === undefined) {
		const dir = dirname(pattern);
		const file = basename(pattern);
		return { baseDir: dir, relativePattern: file };
	}

	const staticPrefix = pattern.slice(0, match.index);
	const lastSepIndex = Math.max(
		staticPrefix.lastIndexOf("/"),
		staticPrefix.lastIndexOf(sep),
	);

	if (lastSepIndex === -1) {
		return { baseDir: "", relativePattern: pattern };
	}

	let baseDir = staticPrefix.slice(0, lastSepIndex);
	const relativePattern = pattern.slice(lastSepIndex + 1);

	// Root directory patterns (e.g. /*.txt)
	if (baseDir === "" && lastSepIndex === 0) {
		baseDir = "/";
	}
	// Windows drive root (e.g. C:/*.txt → C:/)
	if (isWindows() && /^[A-Za-z]:$/.test(baseDir)) {
		baseDir = baseDir + sep;
	}

	return { baseDir, relativePattern };
}

// ============================================================================
// Ripgrep execution (port of claude-code utils/ripgrep.ts)
// ============================================================================

function isEnvTruthy(v: string | undefined): boolean {
	if (v === undefined || v === "") return false;
	const s = v.trim().toLowerCase();
	return s === "1" || s === "true" || s === "yes" || s === "on";
}

function isEagainError(stderr: string): boolean {
	return (
		stderr.includes("os error 11") ||
		stderr.includes("Resource temporarily unavailable")
	);
}

interface RipgrepOutcome {
	lines: string[];
	stderr: string;
	/** Non-null when ripgrep could not complete cleanly (exit != 0/1 or spawn error). */
	error: string | null;
	/** True when the invocation was cut short by the timeout. */
	timedOut: boolean;
}

/**
 * Run a single ripgrep invocation, resolving with its outcome. Handles the
 * timeout (SIGTERM→SIGKILL on POSIX; default on Windows) and abort signal.
 * `singleThread` prepends `-j 1` (used for the EAGAIN retry).
 */
function runRipgrepOnce(
	args: string[],
	target: string,
	abortSignal: AbortSignal,
	timeoutMs: number,
	singleThread: boolean,
): Promise<RipgrepOutcome> {
	return new Promise<RipgrepOutcome>((resolvePromise) => {
		const threadArgs = singleThread ? ["-j", "1"] : [];
		const fullArgs = [...threadArgs, ...args, target];

		const child = spawn("rg", fullArgs, {
			signal: abortSignal,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		let stdout = "";
		let stderr = "";
		let stdoutTruncated = false;
		let stderrTruncated = false;
		let settled = false;
		let killedByTimeout = false;
		let killTimeoutId: ReturnType<typeof setTimeout> | undefined;

		child.stdout?.on("data", (data: Buffer) => {
			if (!stdoutTruncated) {
				stdout += data.toString();
				if (stdout.length > MAX_BUFFER_SIZE) {
					stdout = stdout.slice(0, MAX_BUFFER_SIZE);
					stdoutTruncated = true;
				}
			}
		});
		child.stderr?.on("data", (data: Buffer) => {
			if (!stderrTruncated) {
				stderr += data.toString();
				if (stderr.length > MAX_BUFFER_SIZE) {
					stderr = stderr.slice(0, MAX_BUFFER_SIZE);
					stderrTruncated = true;
				}
			}
		});

		const timeoutId = setTimeout(() => {
			killedByTimeout = true;
			if (platform() === "win32") {
				child.kill();
			} else {
				child.kill("SIGTERM");
				killTimeoutId = setTimeout(() => child.kill("SIGKILL"), 5_000);
			}
		}, timeoutMs);

		const finish = (result: RipgrepOutcome) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			if (killTimeoutId) clearTimeout(killTimeoutId);
			resolvePromise(result);
		};

		child.on("close", (code) => {
			if (code === 0 || code === 1) {
				// 0 = matches found, 1 = no matches — both success.
				finish({
					lines: parseLines(stdout),
					stderr,
					error: null,
					timedOut: false,
				});
			} else {
				finish({
					lines: parseLines(stdout),
					stderr,
					error: `ripgrep exited with code ${code}`,
					timedOut: killedByTimeout,
				});
			}
		});

		child.on("error", (err: NodeJS.ErrnoException) => {
			finish({
				lines: parseLines(stdout),
				stderr,
				error: `${err.message}`,
				timedOut: false,
			});
		});
	});
}

function parseLines(stdout: string): string[] {
	return stdout
		.trim()
		.split("\n")
		.map((line) => line.replace(/\r$/, ""))
		.filter(Boolean);
}

/**
 * Run ripgrep with Claude Code's semantics: retry once on EAGAIN with
 * `-j 1`, treat exit 1 as "no matches", and throw a descriptive error when a
 * timeout yields zero results.
 */
async function ripGrep(
	args: string[],
	target: string,
	abortSignal: AbortSignal,
): Promise<string[]> {
	const defaultTimeout = isWsl() ? 60_000 : 20_000;
	const parsedSeconds =
		parseInt(process.env.PI_GLOB_TIMEOUT_SECONDS ?? "", 10) || 0;
	const timeoutMs = parsedSeconds > 0 ? parsedSeconds * 1000 : defaultTimeout;

	const run = async (singleThread: boolean): Promise<RipgrepOutcome> =>
		runRipgrepOnce(args, target, abortSignal, timeoutMs, singleThread);

	let result = await run(false);

	// EAGAIN (resource-constrained envs): retry once, single-threaded. Claude
	// Code retries only when the error is EAGAIN and has not yet retried.
	if (result.error !== null && isEagainError(result.stderr)) {
		result = await run(true);
	}

	if (result.error === null) return result.lines;

	// A timeout that produced no results is reported as an error so the caller
	// knows the search did not complete (rather than assuming no matches).
	if (result.timedOut && result.lines.length === 0) {
		const secs = Math.round(timeoutMs / 1000);
		throw new Error(
			`Ripgrep search timed out after ${secs} seconds. The search may have matched files but did not complete in time. Try searching a more specific path or pattern.`,
		);
	}

	// Surface the error; partial lines are intentionally dropped to keep the
	// port simple and predictable (Claude Code keeps them, but they are at
	// most the last incomplete line and rarely useful here).
	throw new Error(result.error);
}

// ============================================================================
// Tool execution
// ============================================================================

const GLOB_SCHEMA = Type.Object({
	pattern: Type.String({
		description: "The glob pattern to match files against",
	}),
	path: Type.Optional(
		Type.String({
			description:
				'The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.',
		}),
	),
});

async function executeGlob(
	params: { pattern: string; path?: string },
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<string> {
	const abort = signal ?? new AbortController().signal;

	// Resolve search directory (port of GlobTool.getPath).
	const dir = params.path ? expandPath(params.path, cwd) : cwd;
	// Validate the provided path is an existing directory (port of
	// GlobTool.validateInput). UNC paths are skipped to avoid NTLM leaks.
	if (params.path) {
		if (dir.startsWith("\\\\") || dir.startsWith("//")) {
			// UNC — skip filesystem check.
		} else {
			let isDir = false;
			try {
				isDir = statSync(dir).isDirectory();
			} catch {
				throw new Error(`Directory does not exist: ${params.path}. ${cwd}.`);
			}
			if (!isDir) {
				throw new Error(`Path is not a directory: ${params.path}`);
			}
		}
	}

	// Handle absolute patterns: split into base dir + relative pattern
	// (port of utils/glob.ts).
	let searchDir = dir;
	let searchPattern = params.pattern;
	if (isAbsolute(params.pattern)) {
		const { baseDir, relativePattern } = extractGlobBaseDirectory(
			params.pattern,
		);
		if (baseDir) {
			searchDir = baseDir;
			searchPattern = relativePattern;
		}
	}

	const noIgnore = isEnvTruthy(process.env.PI_GLOB_NO_IGNORE ?? "true");
	const hidden = isEnvTruthy(process.env.PI_GLOB_HIDDEN ?? "true");
	const args = [
		"--files",
		"--glob",
		searchPattern,
		"--sort=modified",
		...(noIgnore ? ["--no-ignore"] : []),
		...(hidden ? ["--hidden"] : []),
	];

	const raw = await ripGrep(args, searchDir, abort);

	// ripgrep returns paths relative to searchDir; convert to absolute.
	const absolutePaths = raw.map((p) => resolveRgPath(p, searchDir));

	const truncated = absolutePaths.length > DEFAULT_LIMIT;
	const files = absolutePaths.slice(0, DEFAULT_LIMIT);

	// Relativize against cwd to save tokens (port of GlobTool.call).
	const filenames = files.map((p) => toRelativePath(p, cwd));

	if (filenames.length === 0) {
		return "No files found";
	}
	return [...filenames, ...(truncated ? [TRUNCATION_NOTICE] : [])].join("\n");
}

// ============================================================================
// Extension entry point
// ============================================================================

export default function (pi: ExtensionAPI): void {
	const toolName = loadToolName();

	pi.registerTool({
		name: toolName,
		label: toolName,
		description: DESCRIPTION,
		promptSnippet: "Find files by glob pattern (ripgrep)",
		parameters: GLOB_SCHEMA,
		async execute(
			_toolCallId,
			params,
			signal,
			_onUpdate,
			ctx: ExtensionContext,
		) {
			try {
				const text = await executeGlob(params, ctx.cwd, signal);
				return {
					content: [{ type: "text", text }],
					details: { pattern: params.pattern, path: params.path ?? undefined },
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Glob search failed: ${message}` }],
					isError: true,
					details: { pattern: params.pattern, path: params.path ?? undefined },
				};
			}
		},
	});
}
