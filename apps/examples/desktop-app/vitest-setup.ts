/**
 * Vitest setup shim for the desktop-app webview environment.
 *
 * Node ≥26 ships the experimental webstorage globals where `sessionStorage`
 * works natively but `localStorage` is unavailable without
 * `--localstorage-file` (accessing it yields undefined with a warning).
 * Because the property already exists on globalThis, vitest's jsdom
 * environment skips populating jsdom's working `localStorage` — so webview
 * tests that exercise localStorage fail on stock Node. Shim a functional
 * in-memory storage when none is reachable.
 */

if (typeof globalThis.localStorage === "undefined") {
	const backing = new Map<string, string>();
	const storage: Storage = {
		get length() {
			return backing.size;
		},
		clear: () => {
			backing.clear();
		},
		getItem: (key: string) =>
			backing.has(key) ? (backing.get(key) as string) : null,
		key: (index: number) =>
			index >= 0 && index < backing.size
				? (Array.from(backing.keys())[index] as string)
				: null,
		removeItem: (key: string) => {
			backing.delete(key);
		},
		setItem: (key: string, value: string) => {
			backing.set(String(key), String(value));
		},
	};
	Object.defineProperty(globalThis, "localStorage", {
		value: storage,
		configurable: true,
	});
	if (typeof window !== "undefined" && typeof window.localStorage === "undefined") {
		Object.defineProperty(window, "localStorage", {
			value: storage,
			configurable: true,
		});
	}
}
