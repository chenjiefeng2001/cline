/**
 * # CompositeDisposable — Standardized Resource Cleanup Chain
 *
 * ## Why
 *
 * Before this module, resources (BrowserSession, terminal processes, MCP
 * connections) had ad-hoc cleanup scattered across tearDown() methods with no
 * consistent guard against double-dispose or partial cleanup on error.
 *
 * ## Solution
 *
 * A `CompositeDisposable` collects multiple dispose callbacks and runs them in
 * LIFO order (reverse registration order). Each callback is guarded so a
 * failure in one does not skip later disposals. The composite itself is
 * idempotent: calling `dispose()` twice is safe.
 *
 * ## Usage
 *
 * ```typescript
 * class MyService {
 *   private readonly disposable = new CompositeDisposable()
 *
 *   constructor() {
 *     this.disposable.add(
 *       () => cleanupThing(),
 *       () => cleanupOtherThing(),
 *     )
 *   }
 *
 *   dispose(): void {
 *     this.disposable.dispose()
 *   }
 * }
 * ```
 *
 * ## Pattern: dispose guard
 *
 * Every method that accesses resources after `dispose()` should check the
 * `disposed` flag:
 *
 * ```typescript
 * if (this.disposable.disposed) return
 * ```
 */

/**
 * A single-unit disposable. Can be a no-arg callback or an object with a
 * `dispose()` method.
 */
export type DisposableUnit = (() => void) | { dispose: () => void }

/**
 * CompositeDisposable — collects multiple dispose callbacks and runs them in
 * LIFO order (reverse registration). Idempotent: calling `dispose()` twice is
 * safe. Each callback is individually try/catched so one failure never skips
 * later disposals.
 */
export class CompositeDisposable {
	private readonly _teardowns: Array<DisposableUnit> = []
	private _disposed = false

	/** Returns `true` once `dispose()` has been called. */
	get disposed(): boolean {
		return this._disposed
	}

	/**
	 * Register one or more teardown callbacks. They will run in reverse order
	 * when `dispose()` is called.
	 *
	 * @example
	 * ```typescript
	 * composite.add(() => cleanup(), { dispose: () => cleanup() })
	 * ```
	 */
	add(...units: DisposableUnit[]): void {
		if (this._disposed) {
			// If already disposed, clean up immediately to match the contract
			// of "registration = disposal guarantee."
			for (const unit of units) {
				try {
					disposeUnit(unit)
				} catch {
					// swallow — cannot throw from add()
				}
			}
			return
		}
		this._teardowns.push(...units)
	}

	/**
	 * Remove a previously registered unit so it will NOT be called during
	 * dispose. Identity comparison; must be the same reference.
	 */
	remove(unit: DisposableUnit): void {
		const idx = this._teardowns.indexOf(unit)
		if (idx !== -1) {
			this._teardowns.splice(idx, 1)
		}
	}

	/**
	 * Run all registered teardowns in LIFO order. Idempotent and guarded:
	 * each callback is individually try/catched so one failure never skips
	 * later disposals. After disposal, the internal list is cleared.
	 */
	dispose(): void {
		if (this._disposed) return
		this._disposed = true

		// Run in reverse order (LIFO)
		const units = this._teardowns.splice(0)
		for (let i = units.length - 1; i >= 0; i--) {
			try {
				disposeUnit(units[i])
			} catch {
				// swallow individual errors — one failure must not skip
				// subsequent disposals
			}
		}
	}
}

function disposeUnit(unit: DisposableUnit): void {
	if (typeof unit === "function") {
		unit()
	} else if (unit && typeof unit.dispose === "function") {
		unit.dispose()
	}
}
