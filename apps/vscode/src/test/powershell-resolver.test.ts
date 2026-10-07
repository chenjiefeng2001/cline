import { afterEach, beforeEach, describe, it } from "mocha"
import "should"
import {
	getFallbackWindowsPowerShellPath,
	getWindowsPowerShellCandidates,
	type PowerShellProbeResult,
	probeWindowsExecutable,
	probeWindowsExecutableDetailed,
	resetPowerShellResolverCacheForTesting,
	resolveWindowsPowerShellExecutable,
	setPowerShellProbeForTesting,
} from "../utils/powershell"
import { WINDOWS_POWERSHELL_LEGACY_PATH } from "../utils/shell"

describe("PowerShell resolver", () => {
	let originalProgramFiles: string | undefined
	let originalProgramW6432: string | undefined

	beforeEach(() => {
		originalProgramFiles = process.env.ProgramFiles
		originalProgramW6432 = process.env.ProgramW6432
		setPowerShellProbeForTesting(null)
		resetPowerShellResolverCacheForTesting()
	})

	afterEach(() => {
		setPowerShellProbeForTesting(null)
		resetPowerShellResolverCacheForTesting()
		process.env.ProgramFiles = originalProgramFiles
		process.env.ProgramW6432 = originalProgramW6432
	})

	it("prefers absolute pwsh candidate when available", async () => {
		process.env.ProgramFiles = "C:\\Program Files"
		process.env.ProgramW6432 = ""

		const preferredCandidate = getWindowsPowerShellCandidates()[0]
		let probeCalls = 0
		setPowerShellProbeForTesting(async (candidate) => {
			probeCalls += 1
			return candidate === preferredCandidate
		})

		const resolved = await resolveWindowsPowerShellExecutable()
		resolved.should.equal(preferredCandidate)
		probeCalls.should.equal(1)
	})

	it("orders candidates with absolute paths first and command names last, without duplicates", () => {
		process.env.ProgramFiles = "C:\\Program Files"
		delete process.env.ProgramW6432
		const candidates = getWindowsPowerShellCandidates()
		const uniqueCount = new Set(candidates).size

		candidates.length.should.equal(uniqueCount)
		candidates[0].should.equal("C:\\Program Files\\PowerShell\\7\\pwsh.exe")
		candidates.should.containEql(WINDOWS_POWERSHELL_LEGACY_PATH)
		candidates.indexOf(WINDOWS_POWERSHELL_LEGACY_PATH).should.be.lessThan(candidates.indexOf("pwsh.exe"))
		candidates.slice(-2).should.deepEqual(["powershell.exe", "powershell"])
	})

	it("falls back to legacy Windows PowerShell path when no candidates resolve", async () => {
		setPowerShellProbeForTesting(async () => false)

		const resolved = await resolveWindowsPowerShellExecutable()
		resolved.should.equal(getFallbackWindowsPowerShellPath())
		resolved.should.equal(WINDOWS_POWERSHELL_LEGACY_PATH)
	})

	it("caches resolved executable and probes only once", async () => {
		process.env.ProgramFiles = "C:\\Program Files"
		process.env.ProgramW6432 = ""

		const preferredCandidate = getWindowsPowerShellCandidates()[0]
		let probeCalls = 0
		setPowerShellProbeForTesting(async () => {
			probeCalls += 1
			return true
		})

		const first = await resolveWindowsPowerShellExecutable()
		const second = await resolveWindowsPowerShellExecutable()

		first.should.equal(preferredCandidate)
		second.should.equal(preferredCandidate)
		probeCalls.should.equal(1)
	})

	it("shares a single probe across concurrent callers", async () => {
		process.env.ProgramFiles = "C:\\Program Files"
		process.env.ProgramW6432 = ""

		const preferredCandidate = getWindowsPowerShellCandidates()[0]
		let probeCalls = 0
		setPowerShellProbeForTesting(async () => {
			probeCalls += 1
			await new Promise((resolve) => setTimeout(resolve, 20))
			return true
		})

		const [a, b, c] = await Promise.all([
			resolveWindowsPowerShellExecutable(),
			resolveWindowsPowerShellExecutable(),
			resolveWindowsPowerShellExecutable(),
		])

		a.should.equal(preferredCandidate)
		b.should.equal(preferredCandidate)
		c.should.equal(preferredCandidate)
		probeCalls.should.equal(1)
	})

	it("times out probing hung candidates", async () => {
		const available = await probeWindowsExecutable("pwsh.exe", 10)
		available.should.equal(false)
	})

	it("cache reset re-runs probing", async () => {
		let probeCalls = 0
		setPowerShellProbeForTesting(async () => {
			probeCalls += 1
			return true
		})

		await resolveWindowsPowerShellExecutable()
		probeCalls.should.equal(1)

		resetPowerShellResolverCacheForTesting()
		setPowerShellProbeForTesting(async () => {
			probeCalls += 1
			return true
		})
		await resolveWindowsPowerShellExecutable()
		probeCalls.should.equal(2)
	})
})

/**
 * The defect these cover: a probe that ran out of budget was reported as
 * "unavailable", so on a cold or scanned CI runner a perfectly good PowerShell
 * was discarded and the resolver fell through to a worse shell -- which then made
 * the first hook pay an even slower start. Observed on `windows-latest` as
 * hook tests failing at 20-30s with a timeout rather than an assertion, matching
 * the earlier incident already documented in hook-factory.test.ts.
 */
describe("PowerShell resolver probe outcomes", () => {
	beforeEach(() => {
		process.env.ProgramFiles = "C:\\Program Files"
		process.env.ProgramW6432 = ""
		setPowerShellProbeForTesting(null)
		resetPowerShellResolverCacheForTesting()
	})

	afterEach(() => {
		setPowerShellProbeForTesting(null)
		resetPowerShellResolverCacheForTesting()
	})

	it("keeps a candidate that merely exceeded the probe budget", async () => {
		const candidates = getWindowsPowerShellCandidates()
		const slowCandidate = candidates[0]
		setPowerShellProbeForTesting((candidate) => (candidate === slowCandidate ? "slow" : "missing"))

		const resolved = await resolveWindowsPowerShellExecutable()
		// Previously this fell through to the legacy fallback, discarding a shell
		// that would have worked.
		resolved.should.equal(slowCandidate)
	})

	it("prefers an available candidate over an earlier slow one", async () => {
		const candidates = getWindowsPowerShellCandidates()
		const slowCandidate = candidates[0]
		const goodCandidate = candidates[1]
		setPowerShellProbeForTesting((candidate) => {
			if (candidate === slowCandidate) return "slow"
			return candidate === goodCandidate ? "available" : "missing"
		})

		const resolved = await resolveWindowsPowerShellExecutable()
		resolved.should.equal(goodCandidate)
	})

	it("still falls back when every candidate is genuinely missing", async () => {
		setPowerShellProbeForTesting(async (): Promise<PowerShellProbeResult> => "missing")
		const resolved = await resolveWindowsPowerShellExecutable()
		resolved.should.equal(getFallbackWindowsPowerShellPath())
	})

	it("treats a boolean probe hook as before", async () => {
		// Callers written against the original two-outcome contract must keep
		// working; false still means missing, not slow.
		const candidates = getWindowsPowerShellCandidates()
		const preferred = candidates[0]
		let calls = 0
		setPowerShellProbeForTesting(async (candidate) => {
			calls += 1
			return candidate === preferred
		})

		const resolved = await resolveWindowsPowerShellExecutable()
		resolved.should.equal(preferred)
		calls.should.equal(1)
	})

	it("does not spawn anything for an absolute path that does not exist", async () => {
		const absent = "C:\\Program Files\\Definitely\\Not\\Installed\\pwsh.exe"
		const result = await probeWindowsExecutableDetailed(absent, 50)
		// A stat call instead of a process launch, which is what removes most of
		// the probe cost when PowerShell 7 is not installed.
		result.should.equal("missing")
	})

	it("keeps the boolean probe meaning 'usable within the budget'", async () => {
		const result = await probeWindowsExecutable("this-command-does-not-exist-xyz", 50)
		result.should.equal(false)
	})
})
