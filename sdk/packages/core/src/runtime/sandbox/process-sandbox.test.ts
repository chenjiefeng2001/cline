import { describe, expect, it } from "vitest";
import { ProcessSandboxRuntime } from "./process-sandbox-runtime";
import {
	buildProcessSandboxCommand,
	buildSeatbeltProfile,
	defaultProcessSandboxBackend,
	detectProcessSandbox,
} from "./sandbox-command";
import {
	isSandboxUnavailableError,
	SandboxUnavailableError,
} from "./sandbox-runtime";

describe("buildSeatbeltProfile", () => {
	it("allows default but confines file writes to the workspace", () => {
		const profile = buildSeatbeltProfile("/repo/a");
		expect(profile).toContain("(version 1)");
		expect(profile).toContain("(allow default)");
		expect(profile).toContain("(deny file-write*)");
		expect(profile).toContain('(allow file-write* (subpath "/repo/a"))');
	});
});

describe("buildProcessSandboxCommand", () => {
	const base = {
		command: "npm",
		args: ["install"],
		workspaceRoot: "/repo/a",
	};

	it("wraps with sandbox-exec on darwin (seatbelt)", () => {
		const wrapped = buildProcessSandboxCommand({
			...base,
			backend: "seatbelt",
			platform: "darwin",
		});
		expect(wrapped?.command).toBe("sandbox-exec");
		expect(wrapped?.args[0]).toBe("-p");
		expect(wrapped?.args[1]).toContain('subpath "/repo/a"');
		expect(wrapped?.args.slice(2)).toEqual(["npm", "install"]);
	});

	it("wraps with bwrap on linux (bubblewrap, workspace-write)", () => {
		const wrapped = buildProcessSandboxCommand({
			...base,
			backend: "bubblewrap",
			platform: "linux",
		});
		expect(wrapped?.command).toBe("bwrap");
		expect(wrapped?.args).toEqual([
			"--ro-bind",
			"/",
			"/",
			"--bind",
			"/repo/a",
			"/repo/a",
			"--dev",
			"/dev",
			"--proc",
			"/proc",
			"--unshare-net",
			"--die-with-parent",
			"--",
			"npm",
			"install",
		]);
	});

	it("unshares the network namespace by default on bubblewrap", () => {
		// A sandbox that isolates writes but leaves a working socket is not an
		// isolation boundary: `curl` inside it exfiltrates whatever the agent reads.
		const wrapped = buildProcessSandboxCommand({
			...base,
			backend: "bubblewrap",
			platform: "linux",
		});
		expect(wrapped?.args).toContain("--unshare-net");
	});

	it("omits --unshare-net when network access is explicitly enabled", () => {
		const wrapped = buildProcessSandboxCommand({
			...base,
			backend: "bubblewrap",
			platform: "linux",
			networkAccess: true,
		});
		expect(wrapped?.args).not.toContain("--unshare-net");
	});

	it("denies network on seatbelt by default", () => {
		const profile = buildSeatbeltProfile("/repo/a");
		// Later rules win in Seatbelt, so the deny must follow `(allow default)`.
		expect(profile).toContain("(deny network*)");
		expect(profile.indexOf("(deny network*)")).toBeGreaterThan(
			profile.indexOf("(allow default)"),
		);
	});

	it("omits the seatbelt network deny when network access is enabled", () => {
		expect(buildSeatbeltProfile("/repo/a", true)).not.toContain("(deny network*)");
	});

	it("returns undefined on win32 (fail-closed, no silent downgrade)", () => {
		expect(
			buildProcessSandboxCommand({
				...base,
				backend: "seatbelt",
				platform: "win32",
			}),
		).toBeUndefined();
		expect(
			buildProcessSandboxCommand({
				...base,
				backend: "bubblewrap",
				platform: "win32",
			}),
		).toBeUndefined();
	});
});

describe("detectProcessSandbox", () => {
	it("reports unavailable with a reason on unsupported platforms", () => {
		const detection = detectProcessSandbox({ platform: "win32" });
		expect(detection.available).toBe(false);
		expect(detection.reason).toContain("win32");
	});

	it("detects seatbelt on darwin when sandbox-exec is on PATH", () => {
		const detection = detectProcessSandbox({
			platform: "darwin",
			pathEnv: "/fake/bin",
		});
		// The fake PATH has no sandbox-exec, so this must fail closed.
		expect(detection.available).toBe(false);
		expect(detection.backend).toBe("seatbelt");
		expect(detection.reason).toContain("sandbox-exec not found");
	});

	it("detects bubblewrap on linux when bwrap is on PATH", () => {
		const detection = detectProcessSandbox({
			platform: "linux",
			pathEnv: "/fake/bin",
		});
		expect(detection.available).toBe(false);
		expect(detection.backend).toBe("bubblewrap");
		expect(detection.reason).toContain("bwrap not found");
	});

	it("prefers an explicit backend over the platform default", () => {
		const detection = detectProcessSandbox({
			platform: "darwin",
			backend: "bubblewrap",
			pathEnv: "/fake/bin",
		});
		expect(detection.backend).toBe("bubblewrap");
	});
});

describe("defaultProcessSandboxBackend", () => {
	it("maps darwin to seatbelt, linux to bubblewrap, others to undefined", () => {
		expect(defaultProcessSandboxBackend("darwin")).toBe("seatbelt");
		expect(defaultProcessSandboxBackend("linux")).toBe("bubblewrap");
		expect(defaultProcessSandboxBackend("win32")).toBeUndefined();
	});
});

describe("SandboxUnavailableError", () => {
	it("is recognized by the type guard", () => {
		const error = new SandboxUnavailableError("seatbelt");
		expect(isSandboxUnavailableError(error)).toBe(true);
		expect(isSandboxUnavailableError(new Error("other"))).toBe(false);
		expect(error.code).toBe("sandbox_unavailable");
	});
});

describe("ProcessSandboxRuntime", () => {
	it("fails closed with a typed error when the sandbox is unavailable", async () => {
		const runtime = new ProcessSandboxRuntime({
			workspaceRoot: "/repo/a",
			platform: "win32",
		});
		expect(runtime.isAvailable()).toBe(false);
		await expect(
			runtime.exec({ command: "npm", args: ["install"] }),
		).rejects.toThrow(SandboxUnavailableError);
	});

	it("fails closed when the backend binary is missing from PATH", async () => {
		const runtime = new ProcessSandboxRuntime({
			workspaceRoot: "/repo/a",
			platform: process.platform === "win32" ? "linux" : "linux",
			pathEnv: "/definitely/not/a/real/path",
			backend: "bubblewrap",
		});
		expect(runtime.isAvailable()).toBe(false);
		await expect(
			runtime.exec({ command: "echo", args: ["hi"] }),
		).rejects.toThrow("bwrap not found on PATH");
	});
});
