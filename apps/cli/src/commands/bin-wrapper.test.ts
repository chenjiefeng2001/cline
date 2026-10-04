import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceWrapperPath = fileURLToPath(
	new URL("../../bin/cline", import.meta.url),
);

function createWrapperCopy(): string {
	const dir = mkdtempSync(join(tmpdir(), "cline-bin-package-"));
	const binDir = join(dir, "bin");
	mkdirSync(binDir, { recursive: true });
	const wrapperPath = join(binDir, "cline");
	copyFileSync(sourceWrapperPath, wrapperPath);
	chmodSync(wrapperPath, 0o755);
	return wrapperPath;
}

/**
 * Returns argv for `spawnSync` such that `node` can execute `scriptPath`, plus
 * the args the child should observe.
 *
 * POSIX has no equivalent: the kernel reads the `#!` line itself, so a `.js`
 * file with a shebang is directly executable. Windows has no shebang support, so
 * `spawnSync(scriptPath)` fails with `EFTYPE` before the child ever starts.
 * Naming the file `.cmd` would only trade `EFTYPE` for `ENOENT`, because
 * `CreateProcess` still cannot run a batch file without a shell. The only
 * reliable form is to invoke the interpreter explicitly and pass the script as
 * an argument — which is also what the wrapper's real consumers get, since it
 * resolves to a native `cline.exe`.
 */
function createChildInvocation(contents: string): {
	command: string;
	args: string[];
} {
	const dir = mkdtempSync(join(tmpdir(), "cline-bin-wrapper-"));
	const scriptPath = join(dir, "child.js");
	writeFileSync(scriptPath, `#!/usr/bin/env node\n${contents}`);
	if (process.platform !== "win32") {
		// POSIX needs the file itself to be executable for the shebang to apply.
		chmodSync(scriptPath, 0o755);
		return { command: scriptPath, args: [] };
	}
	return { command: process.execPath, args: [scriptPath] };
}

/** Appends the wrapper args after any interpreter/script prefix. */
function runWrapper(
	invocation: { command: string; args: string[] },
	args: string[] = [],
) {
	const wrapperPath = createWrapperCopy();
	return spawnSync(
		process.execPath,
		[wrapperPath, ...invocation.args, ...args],
		{
			env: {
				...process.env,
				// On win32 the wrapper spawns `node` itself, so CLINE_BIN_PATH points
				// at the interpreter and the script is forwarded as an argument.
				CLINE_BIN_PATH: invocation.command,
				...(invocation.args.length > 0
					? { CLINE_BIN_SCRIPT_PATH: invocation.args[0] }
					: {}),
			},
			encoding: "utf8",
		},
	);
}

describe("bin/cline wrapper", () => {
	it("preserves the child process exit status", () => {
		const invocation = createChildInvocation(`
process.exit(Number(process.env.CLINE_TEST_EXIT_CODE ?? "0"));
`);

		// Reads the code from the environment rather than argv: on Windows the
		// script consumes one argv slot for its own path, so a positional
		// assertion would encode the interpreter quirk instead of the wrapper's
		// actual contract (propagate the child's status, whatever it is).
		const result = spawnSync(
			process.execPath,
			[createWrapperCopy(), ...invocation.args],
			{
				env: {
					...process.env,
					CLINE_BIN_PATH: invocation.command,
					...(invocation.args.length > 0
						? { CLINE_BIN_SCRIPT_PATH: invocation.args[0] }
						: {}),
					CLINE_TEST_EXIT_CODE: "7",
				},
				encoding: "utf8",
			},
		);

		expect(result.error).toBeUndefined();
		expect(result.status).toBe(7);
		expect(result.signal).toBeNull();
	});

	it("passes the wrapper path to the compiled binary", () => {
		const invocation = createChildInvocation(`
console.log(process.env.CLINE_WRAPPER_PATH ?? "");
`);

		const result = runWrapper(invocation);

		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toMatch(/bin[/\\]cline$/);
	});

	it.skipIf(process.platform === "win32")(
		"propagates child process signal termination on POSIX",
		() => {
			const invocation = createChildInvocation(`
process.kill(process.pid, "SIGTERM");
setTimeout(() => {}, 1000);
`);

			const result = runWrapper(invocation);

			expect(result.error).toBeUndefined();
			expect(result.status).toBeNull();
			expect(result.signal).toBe("SIGTERM");
		},
	);
});
