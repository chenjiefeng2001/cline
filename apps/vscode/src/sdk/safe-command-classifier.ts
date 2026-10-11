import { parse as shellParse } from "shell-quote"

/**
 * Conservative classifier deciding whether a shell command may be run without
 * asking the user, when the `executeSafeCommands` setting is on.
 *
 * ## Why an allowlist
 *
 * The decision this feeds is "run it without asking", so the safe direction is
 * to recognise a small set of provably read-only commands and refuse
 * everything else. A denylist cannot express that: it fails open on anything it
 * has not heard of. `command-guard.ts` uses a denylist deliberately - blocking a
 * known-dangerous command during plan mode is the opposite posture, where an
 * unrecognised command should be allowed and merely not file-editing. That
 * machinery is deliberately not reused here.
 *
 * ## Why shell-quote
 *
 * Deciding this with regular expressions means re-implementing a shell parser
 * badly. `shell-quote` is already a declared dependency of this package and
 * returns operators as explicit `{ op }` tokens, which is exactly the signal
 * needed. It is not a full shell grammar, and §"limits" below records what it
 * misses.
 *
 * ## Fail closed
 *
 * Every path that cannot prove a command is safe returns false. Unparseable
 * input, an unfamiliar executable, a flag that could write - all of them land on
 * the normal approval flow rather than on silent execution. The only way to get
 * a false "safe" verdict is for something to appear in the allowlist below.
 */

/** Operators that mean "this is more than one thing". */
const UNSAFE_OPERATORS = new Set([
	"&&",
	"||",
	"|",
	";",
	"&",
	">",
	">>",
	">>",
	"1>",
	"2>",
	"<<",
	"<<<",
	"<",
	"(",
	")",
	"{",
	"}",
	"\n",
])

/**
 * Read-only executables. Anything not listed here is refused, so this list is
 * deliberately short rather than exhaustive: an unknown binary cannot be shown
 * to be harmless.
 *
 * Names are compared after normalisation (see `normalizeExecutable`), so entries
 * may be written in their usual lowercase form.
 */
const SAFE_EXECUTABLES = new Set([
	// Inspection
	"ls",
	"pwd",
	"cat",
	"head",
	"tail",
	"wc",
	"file",
	"stat",
	"du",
	"df",
	"tree",
	// Text processing that only reads stdin/files
	"sort",
	"uniq",
	"cut",
	"tr",
	"diff",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"find",
	// Environment / identity
	"echo",
	"printf",
	"true",
	"false",
	"test",
	"date",
	"whoami",
	"id",
	"groups",
	"hostname",
	"uname",
	"which",
	"type",
	"where",
	"env", // only reached with no arguments; see the env case below
	// Path helpers
	"basename",
	"dirname",
	"realpath",
	"readlink",
	// Windows equivalents
	"dir",
	// Reaches the subcommand rules below; listed here only so that a read-only
	// git subcommand is not rejected before those rules run.
	"git",
])

/**
 * `git` multiplexes hundreds of behaviours behind one executable, so the
 * executable name alone says nothing. Only these subcommands are read-only, and
 * even those are narrowed further below.
 */
const SAFE_GIT_SUBCOMMANDS = new Set([
	"status",
	"log",
	"diff",
	"show",
	"blame",
	"shortlog",
	"reflog",
	"describe",
	"ls-files",
	"ls-remote",
	"ls-tree",
	"rev-parse",
	"rev-list",
	"cat-file",
	"whatchanged",
	"grep",
	"cherry",
	"mergetest",
	"var",
	// Reachable only in an explicit read form; see gitSubcommandNeedsRefusal.
	"config",
])

/**
 * Subcommands that are read-only only in a restricted form.
 *
 * `git config` writes unless asked to read, so it needs an explicit read flag.
 * `git remote` lists by default and only mutates on certain subcommands, so it
 * is judged the other way round: those subcommands are named and refused.
 */
const READ_ONLY_FORM_SUBCOMMANDS: Record<string, readonly string[]> = {
	config: ["--get", "--get-all", "--get-regexp", "--list", "-l"],
}

const MUTATING_GIT_SUBCOMMANDS = new Set([
	"remote",
	"branch",
	"stash",
	"tag",
	"worktree",
	"submodule",
	"notes",
	"gc",
	"repack",
	"prune",
	"fetch",
	"pull",
	"push",
	"merge",
	"rebase",
	"cherry-pick",
	"revert",
	"apply",
	"am",
	"clean",
	"init",
	"clone",
	"add",
	"rm",
	"mv",
	"restore",
	"switch",
	"checkout",
	"update-index",
	"update-ref",
])

/** Flags that turn an otherwise read-only command into a writer. */
const DANGEROUS_FLAGS: Record<string, readonly string[]> = {
	sed: ["-i", "--in-place"],
	find: ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprintf", "-fls"],
	git: [
		"-d",
		"-D",
		"-m",
		"-M",
		"--delete",
		"--move",
		"--copy",
		"-c",
		"-C",
		"--set-upstream-to",
		"--unset-upstream",
		"--force",
		"-f",
		"--exec-path",
		"--upload-pack",
		"--receive-pack",
	],
}

/** `git branch` lists by default; these flags turn it into a writer. */
const DANGEROUS_BRANCH_FLAGS = [
	"-d",
	"-D",
	"-m",
	"-M",
	"--delete",
	"--move",
	"--copy",
	"-c",
	"-C",
	"--set-upstream-to",
	"--unset-upstream",
]

/** `VAR=value command` prefixes an assignment and can smuggle a different binary. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

function normalizeExecutable(raw: string): string {
	const withoutPath = raw.split(/[/\\]/).pop() ?? raw
	return withoutPath.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "")
}

/** True when the shell never closed a quote - shell-quote does not report this. */
function hasUnterminatedQuote(command: string): boolean {
	let inSingle = false
	let inDouble = false
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]
		if (ch === "\\" && !inSingle) {
			i++
			continue
		}
		if (ch === "'" && !inDouble) inSingle = !inSingle
		else if (ch === '"' && !inSingle) inDouble = !inDouble
	}
	return inSingle || inDouble
}

function hasDangerousFlag(executable: string, argv: readonly string[]): boolean {
	const flags = DANGEROUS_FLAGS[executable]
	if (!flags) {
		return false
	}
	return argv.some((token) => flags.includes(token))
}

/**
 * `git` multiplexes hundreds of behaviours behind one executable, so the name
 * alone says nothing.
 *
 * Returns true when the invocation should be refused.
 */
function gitSubcommandNeedsRefusal(argv: readonly string[]): boolean {
	const subcommand = argv[0]
	if (!subcommand || subcommand.startsWith("-")) {
		// Bare `git`, or `git --version` with no subcommand.
		return true
	}

	if (MUTATING_GIT_SUBCOMMANDS.has(subcommand)) {
		if (subcommand === "remote") {
			// `git remote`, `git remote -v` and `git remote show` only read; the
			// nested subcommand is what decides.
			const nested = argv.slice(1).find((token) => !token.startsWith("-"))
			const mutating = ["add", "remove", "rm", "rename", "set-url", "set-head", "prune", "update"]
			return nested !== undefined && mutating.includes(nested)
		}
		if (subcommand === "branch") {
			return argv.slice(1).some((token) => DANGEROUS_BRANCH_FLAGS.includes(token))
		}
		// Everything else in the mutating set is refused on sight.
		return true
	}

	if (!SAFE_GIT_SUBCOMMANDS.has(subcommand)) {
		return true
	}

	// `git config` writes unless asked to read.
	if (subcommand === "config") {
		const readForms = READ_ONLY_FORM_SUBCOMMANDS.config
		return !argv.slice(1).some((token) => readForms.includes(token))
	}

	return false
}

/**
 * True only when the single command is provably read-only.
 *
 * Everything this cannot vouch for returns false.
 */
export function isCommandReadOnly(command: string): boolean {
	// A newline separates commands, and shell-quote silently folds it into the
	// token list (`ls\nrm -rf /` parses as `ls rm -rf /`), so it must be
	// rejected before tokenising or the second command would look like an
	// argument to the first.
	if (command.includes("\n") || command.includes("\r")) {
		return false
	}
	if (hasUnterminatedQuote(command)) {
		return false
	}

	let tokens: unknown[]
	try {
		tokens = shellParse(command)
	} catch {
		// Unbalanced brackets, stray metacharacters, etc.
		return false
	}

	const argv: string[] = []
	for (const token of tokens) {
		if (typeof token === "string") {
			// Command substitution survives tokenisation as literal backticks
			// (``echo `id` `` -> "echo", "`id`"), so it has to be caught here.
			if (token.includes("`") || token.includes("$(")) {
				return false
			}
			argv.push(token)
			continue
		}
		const op = (token as { op?: string })?.op
		if (typeof op === "string") {
			// Any operator means this is a compound command. Even `&&` between
			// two safe commands is refused: the right-hand side is only as safe
			// as whatever it turns out to be, and refusing costs one prompt.
			if (UNSAFE_OPERATORS.has(op) || op.length > 0) {
				return false
			}
			return false
		}
		// Comments and glob markers come back as other shapes; refuse them too.
		return false
	}

	if (argv.length === 0) {
		return false
	}

	const executable = normalizeExecutable(argv[0])
	const args = argv.slice(1)

	// `VAR=value cmd` / `FOO=bar env`: an assignment prefix can redirect which
	// binary runs, so it is never auto-approved.
	if (ENV_ASSIGNMENT.test(argv[0])) {
		return false
	}

	// `env` can launch anything; with no arguments it only prints the
	// environment, which is why it is on the list at all.
	if (executable === "env") {
		return args.length === 0
	}

	if (!SAFE_EXECUTABLES.has(executable)) {
		return false
	}

	if (hasDangerousFlag(executable, args)) {
		return false
	}

	if (executable === "git") {
		return !gitSubcommandNeedsRefusal(args)
	}

	return true
}

/** Pull the command strings out of whatever shape the tool call used. */
function extractCommands(input: unknown): string[] | null {
	if (typeof input === "string") {
		return [input]
	}
	if (Array.isArray(input)) {
		return input.every((entry) => typeof entry === "string") ? (input as string[]) : null
	}
	if (input === null || typeof input !== "object") {
		return null
	}

	const record = input as Record<string, unknown>
	for (const key of ["command", "cmd", "commands"] as const) {
		const value = record[key]
		if (typeof value === "string") {
			// Structured form carries its argv in `args`; a command plus args is
			// not something this classifier reconstructs, so it is refused.
			return Array.isArray(record.args) ? null : [value]
		}
		if (Array.isArray(value)) {
			return value.every((entry) => typeof entry === "string") ? (value as string[]) : null
		}
	}
	return null
}

/**
 * True when every command in a run_commands / execute_command call is safe to
 * auto-approve.
 *
 * An input shape this cannot read returns false, so an unrecognised call shape
 * falls through to the approval UI rather than being waved through.
 */
export function areCommandsSafeToAutoApprove(input: unknown): boolean {
	const commands = extractCommands(input)
	if (!commands || commands.length === 0) {
		return false
	}
	return commands.every(isCommandReadOnly)
}
