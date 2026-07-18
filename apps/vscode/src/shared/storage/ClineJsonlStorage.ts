/**
 * # ClineJsonlStorage — Append-only JSONL-backed Key-Value Store
 *
 * Append new values as individual JSON lines to a `.jsonl` file. Reads
 * reconstruct state by replaying lines (last writer wins per key). A periodic
 * `compact()` rewrites the full state into a fresh file.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { Logger } from "../services/Logger"

export interface ClineJsonlStorageOptions {
	fileMode?: number
	compactThreshold?: number
}

interface JsonlEntry {
	k: string
	v: unknown
	ts: number
}

const DEFAULT_COMPACT_THRESHOLD = 10_000

export class ClineJsonlStorage {
	private readonly fsPath: string
	private readonly fileMode?: number
	private readonly compactThreshold: number
	private entryCount = 0
	private compacting = false

	constructor(filePath: string, options?: ClineJsonlStorageOptions) {
		this.fsPath = filePath
		this.fileMode = options?.fileMode
		this.compactThreshold = options?.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD
		this.entryCount = this.countEntries()
	}

	get(key: string): unknown | undefined {
		const all = this.readAll()
		return all[key]
	}

	set(key: string, value: unknown): void {
		this.appendEntry(key, value)
	}

	setBatch(entries: Record<string, unknown | undefined>): void {
		const now = Date.now()
		const lines: string[] = []
		for (const [key, value] of Object.entries(entries)) {
			if (value !== undefined) {
				lines.push(JSON.stringify({ k: key, v: value, ts: now }))
			}
		}
		if (lines.length === 0) return
		this.appendLines(lines)
	}

	delete(key: string): void {
		this.appendEntry(key, null)
	}

	readAll(): Record<string, unknown> {
		if (!fs.existsSync(this.fsPath)) return {}
		try {
			const content = fs.readFileSync(this.fsPath, "utf-8")
			if (!content) return {}
			return replay(content)
		} catch (error) {
			Logger.error(`[ClineJsonlStorage] failed to read from ${this.fsPath}:`, error)
			return {}
		}
	}

	compact(): void {
		if (this.compacting) return
		this.compacting = true
		try {
			const state = this.readAll()
			if (Object.keys(state).length === 0) return
			const now = Date.now()
			const lines = Object.entries(state)
				.map(([k, v]) => JSON.stringify({ k, v, ts: now }))
				.join("\n") + "\n"
			const tmpPath = `${this.fsPath}.tmp.${Date.now()}.${Math.random().toString(36).substring(7)}.jsonl`
			try {
				fs.writeFileSync(tmpPath, lines, { flag: "wx", encoding: "utf-8", mode: this.fileMode })
				fs.renameSync(tmpPath, this.fsPath)
				this.entryCount = Object.keys(state).length
			} catch (writeError) {
				try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
				throw writeError
			}
		} catch (error) {
			Logger.error(`[ClineJsonlStorage] compact failed for ${this.fsPath}:`, error)
		} finally {
			this.compacting = false
		}
	}

	getEntryCount(): number { return this.entryCount }

	private appendEntry(key: string, value: unknown): void {
		this.appendLines([JSON.stringify({ k: key, v: value, ts: Date.now() })])
	}

	private appendLines(lines: string[]): void {
		if (lines.length === 0) return
		try {
			const dir = path.dirname(this.fsPath)
			fs.mkdirSync(dir, { recursive: true })
			fs.appendFileSync(this.fsPath, lines.join("\n") + "\n", { encoding: "utf-8", mode: this.fileMode })
			this.entryCount += lines.length
			if (this.entryCount >= this.compactThreshold) {
				queueMicrotask(() => this.compact())
			}
		} catch (error) {
			Logger.error(`[ClineJsonlStorage] failed to append to ${this.fsPath}:`, error)
		}
	}

	private countEntries(): number {
		if (!fs.existsSync(this.fsPath)) return 0
		try {
			const content = fs.readFileSync(this.fsPath, "utf-8")
			if (!content) return 0
			return content.trim().split("\n").filter(Boolean).length
		} catch { return 0 }
	}
}

function replay(content: string): Record<string, unknown> {
	const state: Record<string, unknown> = {}
	for (const line of content.trim().split("\n")) {
		if (!line.trim()) continue
		try {
			const entry = JSON.parse(line) as JsonlEntry
			if (entry && typeof entry.k === "string") {
				entry.v === null ? delete state[entry.k] : (state[entry.k] = entry.v)
			}
		} catch { continue }
	}
	return state
}
