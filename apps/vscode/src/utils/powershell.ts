import { existsSync } from "node:fs"
import { isAbsolute } from "node:path"
import * as childProcess from "child_process"
import { Logger } from "@/shared/services/Logger"
import { getWindowsPwshInstallPaths, WINDOWS_POWERSHELL_LEGACY_PATH } from "./shell"

/**
 * How long to wait for a candidate to answer `$PSVersionTable.PSVersion`.
 *
 * This is a performance knob, not a correctness one: a candidate that runs slower
 * than this is recorded as "slow" and still considered usable, rather than being
 * discarded. It was previously load-bearing in the wrong way -- exceeding it made
 * a perfectly good PowerShell look absent, which on a cold or scanned CI runner
 * cost a wasted fallback and then a slow first hook.
 */
const POWERSHELL_PROBE_TIMEOUT_MS = 1200

let resolvedPowerShellPromise: Promise<string> | null = null
let probeWindowsExecutableImpl: PowerShellProbe = probeWindowsExecutableDetailed

function uniquePreserveOrder(values: string[]): string[] {
	return [...new Set(values.filter(Boolean))]
}

export function getFallbackWindowsPowerShellPath(): string {
	return WINDOWS_POWERSHELL_LEGACY_PATH
}

export function getWindowsPowerShellCandidates(): string[] {
	const envAbsoluteCandidates = [...getWindowsPwshInstallPaths(), WINDOWS_POWERSHELL_LEGACY_PATH]

	const commandNameFallbacks = ["pwsh.exe", "pwsh", "powershell.exe", "powershell"]

	return uniquePreserveOrder([...envAbsoluteCandidates, ...commandNameFallbacks])
}

export function resetPowerShellResolverCacheForTesting(): void {
	resolvedPowerShellPromise = null
	probeWindowsExecutableImpl = probeWindowsExecutableDetailed
}

/**
 * Outcome of probing one candidate.
 *
 * `slow` is separated from `missing` because conflating them is what caused this:
 * a shell that merely took longer than the probe budget to start was treated as
 * absent, so the resolver moved on, and on a cold runner it could walk several
 * candidates -- including an App Execution Alias that exists but is slow to
 * launch -- before settling on a worse shell.
 */
export type PowerShellProbeResult = "available" | "missing" | "slow"

/**
 * Probe hook signature.
 *
 * Accepts a boolean as well as the tri-state so callers written against the
 * original two-outcome contract keep working, and a plain `false` is read as
 * "missing" exactly as before. Only the tri-state can express "slow", which is
 * the case that motivated the change.
 */
export type PowerShellProbe = (
	candidate: string,
	timeoutMs?: number,
) => PowerShellProbeResult | boolean | Promise<PowerShellProbeResult | boolean>

function normalizeProbeResult(result: PowerShellProbeResult | boolean): PowerShellProbeResult {
	if (typeof result === "boolean") {
		return result ? "available" : "missing"
	}
	return result
}

export function setPowerShellProbeForTesting(probeFn: PowerShellProbe | null): void {
	probeWindowsExecutableImpl = probeFn ?? probeWindowsExecutableDetailed
}

/**
 * Whether an absolute candidate could be dismissed without spawning anything.
 *
 * Answering this from the filesystem costs a stat call instead of a process
 * launch, which on Windows removes most of the probe cost before it starts: the
 * `Program Files\PowerShell\7` and `\6` paths are absent on any machine without
 * PowerShell 7, and each was previously costing a full spawn to discover that.
 *
 * Bare command names are excluded because they need PATH resolution, which only
 * a spawn can answer.
 */
function absoluteCandidateIsAbsent(candidate: string): boolean {
	return isAbsolute(candidate) && !existsSync(candidate)
}

export async function probeWindowsExecutableDetailed(
	candidate: string,
	timeoutMs = POWERSHELL_PROBE_TIMEOUT_MS,
): Promise<PowerShellProbeResult> {
	if (absoluteCandidateIsAbsent(candidate)) {
		return "missing"
	}

	return await new Promise<PowerShellProbeResult>((resolve) => {
		const child = childProcess.spawn(candidate, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion"], {
			stdio: "ignore",
			windowsHide: true,
			shell: false,
		})

		let settled = false

		const finish = (result: PowerShellProbeResult) => {
			if (settled) {
				return
			}
			settled = true
			clearTimeout(timer)
			resolve(result)
		}

		const timer = setTimeout(() => {
			if (!child.killed) {
				child.kill("SIGTERM")
			}
			// "slow", not "missing": it answered nothing within the budget, but that
			// says nothing about whether it works.
			finish("slow")
		}, timeoutMs)

		child.once("error", () => finish("missing"))
		child.once("exit", (code) => finish(code === 0 ? "available" : "missing"))
	})
}

/**
 * Boolean form, kept for callers that only need "is this usable right now".
 *
 * Unchanged semantics: a probe that runs out of budget counts as not available.
 */
export async function probeWindowsExecutable(candidate: string, timeoutMs = POWERSHELL_PROBE_TIMEOUT_MS): Promise<boolean> {
	return (await probeWindowsExecutableDetailed(candidate, timeoutMs)) === "available"
}

export async function resolveWindowsPowerShellExecutable(): Promise<string> {
	if (!resolvedPowerShellPromise) {
		resolvedPowerShellPromise = (async () => {
			const candidates = getWindowsPowerShellCandidates()
			// Remembered rather than discarded: a candidate that was merely slow is
			// still a working shell, and on a cold runner it is often better than the
			// untested candidates further down the list.
			let slowestUsable: string | undefined

			for (const candidate of candidates) {
				const result = normalizeProbeResult(await probeWindowsExecutableImpl(candidate))
				if (result === "available") {
					Logger.debug(`[PowerShellResolver] Using PowerShell executable: ${candidate}`)
					return candidate
				}
				if (result === "slow" && !slowestUsable) {
					Logger.debug(`[PowerShellResolver] ${candidate} exceeded the probe budget; keeping it as a fallback`)
					slowestUsable = candidate
				}
			}

			if (slowestUsable) {
				Logger.warn(
					`[PowerShellResolver] No candidate answered within the probe budget, but ${slowestUsable} did respond eventually. Using it.`,
				)
				return slowestUsable
			}

			const fallback = getFallbackWindowsPowerShellPath()
			Logger.warn(
				`[PowerShellResolver] Could not resolve PowerShell executable from candidates ${candidates.join(", ")}. Falling back to ${fallback}.`,
			)
			return fallback
		})()
	}

	return resolvedPowerShellPromise
}
