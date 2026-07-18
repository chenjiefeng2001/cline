/**
 * # FileLockManager — Pure-JS Lock Manager
 *
 * Pure-JS replacement for `SqliteLockManager` (which depended on the native
 * `better-sqlite3` addon). Stores lock metadata in a JSON file with
 * cross-process serialization via `fs.openSync("wx")`.
 */

import * as fs from "node:fs"
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { Logger } from "@/shared/services/Logger"
import type { LockRow } from "./types"

export interface FileLockManagerOptions {
	filePath: string
	instanceAddress: string
}

interface StoredLock {
	held_by: string
	lock_type: "file" | "instance" | "folder"
	lock_target: string
	locked_at: number
}

export class FileLockManager {
	private readonly filePath: string
	private readonly instanceAddress: string
	private static readonly STALE_LOCK_TIMEOUT = 60_000

	constructor(options: FileLockManagerOptions) {
		this.filePath = options.filePath
		this.instanceAddress = options.instanceAddress
		const dir = path.dirname(this.filePath)
		mkdirSync(dir, { recursive: true })
		if (!existsSync(this.filePath)) {
			this.writeLocksSync([])
		}
	}

	registerInstance(hostAddress: string): void {
		this.withLockSync((locks) => {
			const filtered = locks.filter(
				(l) => !(l.lock_type === "instance" && l.held_by === this.instanceAddress),
			)
			filtered.push({
				held_by: this.instanceAddress,
				lock_type: "instance",
				lock_target: hostAddress,
				locked_at: Date.now(),
			})
			return filtered
		})
	}

	removeInstanceByAddress(instanceAddress: string): void {
		this.withLockSync((locks) =>
			locks.filter(
				(l) => !(l.lock_type === "instance" && l.held_by === instanceAddress),
			),
		)
	}

	unregisterInstance(): void {
		this.removeInstanceByAddress(this.instanceAddress)
	}

	getInstanceByPort(port: number): { instanceAddress: string; hostAddress: string } | null {
		const locks = this.readLocksSync()
		const result = locks.find(
			(l) =>
				l.lock_type === "instance" &&
				(l.held_by.endsWith(`:${port}`) || l.lock_target.endsWith(`:${port}`)),
		)
		return result
			? { instanceAddress: result.held_by, hostAddress: result.lock_target }
			: null
	}

	async getFolderLockByTarget(lockTarget: string): Promise<LockRow | null> {
		const locks = this.readLocksSync()
		const lock = locks.find(
			(l) => l.lock_type === "folder" && l.lock_target === lockTarget,
		)
		return lock ? this.toLockRow(lock) : null
	}

	async registerFolderLock(heldBy: string, lockTarget: string): Promise<LockRow | null> {
		heldBy = this.instanceAddress
		let conflicting: LockRow | null = null
		this.withLockSync((locks) => {
			const existing = locks.find(
				(l) => l.lock_type === "folder" && l.lock_target === lockTarget,
			)
			if (existing) {
				if (existing.held_by === heldBy) {
					return locks
				}
				conflicting = this.toLockRow(existing)
				return locks
			}
			locks.push({
				held_by: heldBy,
				lock_type: "folder",
				lock_target: lockTarget,
				locked_at: Date.now(),
			})
			return locks
		})
		return conflicting
	}

	async releaseFolderLockByTarget(heldBy: string, lockTarget: string): Promise<void> {
		heldBy = this.instanceAddress
		this.withLockSync((locks) =>
			locks.filter(
				(l) =>
					!(
						l.lock_type === "folder" &&
						l.held_by === heldBy &&
						l.lock_target === lockTarget
					),
			),
		)
	}

	cleanupOrphanedFolderLocks(): void {
		this.withLockSync((locks) => {
			const activeInstances = new Set(
				locks.filter((l) => l.lock_type === "instance").map((l) => l.held_by),
			)
			const before = locks.length
			const filtered = locks.filter(
				(l) => l.lock_type !== "folder" || activeInstances.has(l.held_by),
			)
			const removed = before - filtered.length
			if (removed > 0) {
				Logger.log(`[FileLockManager] Cleaned up ${removed} orphaned folder lock(s)`)
			}
			return filtered
		})
	}

	close(): void {
		// No-op — file persists on disk for other processes
	}

	// -----------------------------------------------------------------------
	// Private helpers
	// -----------------------------------------------------------------------

	private readLocksSync(): StoredLock[] {
		try {
			if (!existsSync(this.filePath)) return []
			const raw = readFileSync(this.filePath, "utf-8").trim()
			if (!raw) return []
			const locks: StoredLock[] = JSON.parse(raw)
			const now = Date.now()
			return locks.filter(
				(l) => now - l.locked_at < FileLockManager.STALE_LOCK_TIMEOUT,
			)
		} catch (error) {
			Logger.error(`[FileLockManager] Failed to read lock file: ${error}`)
			return []
		}
	}

	private writeLocksSync(locks: StoredLock[]): void {
		writeFileSync(this.filePath, JSON.stringify(locks, null, 2), "utf-8")
	}

	private withLockSync(mutate: (locks: StoredLock[]) => StoredLock[]): void {
		const lockFilePath = `${this.filePath}.lock`
		let fd: number | null = null
		try {
			this.cleanupStaleLockSync(lockFilePath)
			fd = fs.openSync(lockFilePath, "wx")
			fs.writeFileSync(fd, `${Date.now()}`)
			const current = this.readLocksSync()
			const next = mutate(current)
			this.writeLocksSync(next)
		} catch (error: any) {
			if (error.code === "EEXIST") {
				const delay = 100 + Math.random() * 100
				this.sleepSync(delay)
				this.withLockSync(mutate)
				return
			}
			Logger.error(`[FileLockManager] Lock acquisition failed: ${error}`)
		} finally {
			if (fd !== null) { try { fs.closeSync(fd) } catch { /* ok */ } }
			try {
				if (existsSync(lockFilePath)) { unlinkSync(lockFilePath) }
			} catch { /* ok */ }
		}
	}

	private cleanupStaleLockSync(lockFilePath: string): void {
		try {
			if (!existsSync(lockFilePath)) return
			const raw = readFileSync(lockFilePath, "utf-8").trim()
			const ts = Number.parseInt(raw, 10)
			if (isNaN(ts) || Date.now() - ts > FileLockManager.STALE_LOCK_TIMEOUT) {
				unlinkSync(lockFilePath)
				Logger.warn(`[FileLockManager] Removed stale lock file: ${lockFilePath}`)
			}
		} catch { /* best-effort */ }
	}

	private sleepSync(ms: number): void {
		const sab = new SharedArrayBuffer(4)
		const ia = new Int32Array(sab)
		Atomics.wait(ia, 0, 0, Math.max(0, Math.floor(ms)))
	}

	private toLockRow(lock: StoredLock, id?: number): LockRow {
		return { id: id ?? 0, ...lock, locked_at: lock.locked_at }
	}
}