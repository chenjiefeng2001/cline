import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
	PathOutsideBoundaryError,
	resolveBoundedPath,
} from "../extensions/tools/executors/file-boundary"

/**
 * A workspace boundary for the primary file tools.
 *
 * Both executors previously accepted any absolute path - the read executor with no
 * check at all, and the editor executor with a `..` test that only applied to
 * relative inputs. The symlink-safe primitive {@link resolveContainedPath} already
 * existed in @cline/shared but had a single production consumer (remote userFiles),
 * so a `sk-...` in ~/.ssh/id_rsa or a .env outside the repo was one tool call away.
 *
 * The boundary is opt-out by configuration rather than unconditional: a jail with no
 * way out would break the legitimate case of working on a file outside the
 * repository, and a silently-broken edit is worse than a documented one.
 */
describe("resolveBoundedPath", () => {
	function workspace() {
		const base = mkdtempSync(join(tmpdir(), "boundary-"));
		const root = join(base, "repo");
		const outside = join(base, "outside");
		mkdirSync(root, { recursive: true });
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(root, "inside.txt"), "in");
		writeFileSync(join(outside, "secret.env"), "TOKEN=abc");
		return { base, root, outside };
	}

	it("resolves a relative path inside the boundary", async () => {
		const { root } = workspace()
		const resolved = await resolveBoundedPath(root, "inside.txt", { root })
		expect(resolved.replace(/\\/g, "/")).toContain("inside.txt")
	})

	it("rejects a relative path that escapes with ..", async () => {
		const { root, outside } = workspace()
		await expect(
			resolveBoundedPath(root, join("..", "outside", "secret.env"), { root }),
		).rejects.toBeInstanceOf(PathOutsideBoundaryError)
	})

	it("rejects an absolute path outside the boundary", async () => {
		// This is the case neither executor previously stopped: an absolute path was
		// accepted unconditionally, so the workspace was never a boundary at all.
		const { root, outside } = workspace()
		await expect(
			resolveBoundedPath(root, join(outside, "secret.env"), { root }),
		).rejects.toBeInstanceOf(PathOutsideBoundaryError)
	})

	it("rejects a symlink inside the boundary that points out of it", async () => {
		// The lexical pass alone is not enough: the link itself is inside the root, so
		// only resolving symlinks on both sides catches this.
		const { root, outside } = workspace()
		let linkCreated = true
		try {
			symlinkSync(join(outside, "secret.env"), join(root, "sneaky.env"), "file")
		} catch {
			linkCreated = false // Windows without developer mode
		}
		if (!linkCreated) {
			return
		}
		await expect(resolveBoundedPath(root, "sneaky.env", { root })).rejects.toBeInstanceOf(
			PathOutsideBoundaryError,
		)
	})

	it("permits an additional root when one is configured", async () => {
		const { root, outside } = workspace()
		const target = join(outside, "secret.env")
		await expect(resolveBoundedPath(root, target, { root })).rejects.toBeInstanceOf(
			PathOutsideBoundaryError,
		)
		const allowed = await resolveBoundedPath(root, target, {
			root,
			additionalRoots: [outside],
		})
		expect(allowed).toContain("secret.env")
	})

	it("leaves behaviour unchanged when no boundary is configured", async () => {
		// The escape hatch has to be a real no-op, not a stricter default wearing a
		// different name, or adopting the boundary would silently break existing setups.
		const { root, outside } = workspace()
		const target = join(outside, "secret.env")
		await expect(resolveBoundedPath(root, target, undefined)).resolves.toBe(target)
	})

	it("says in the error that nothing happened and how to widen the boundary", async () => {
		// A bare "path not allowed" reads to the model like a transient failure, and it
		// invites a retry loop. The message has to state the effect and the remedy.
		const { root, outside } = workspace()
		const error = await resolveBoundedPath(root, join(outside, "secret.env"), { root }).catch(
			(e: unknown) => e,
		)
		expect(error).toBeInstanceOf(PathOutsideBoundaryError)
		const message = (error as Error).message
		expect(message).toContain("Nothing was read or written")
		expect(message).toContain("allowed roots")
	})
})
