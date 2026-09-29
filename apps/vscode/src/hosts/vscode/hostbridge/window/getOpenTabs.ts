import { TabInputText, window } from "vscode"
import { GetOpenTabsRequest, GetOpenTabsResponse } from "@/shared/proto/host/window"

export async function getOpenTabs(_: GetOpenTabsRequest): Promise<GetOpenTabsResponse> {
	const openTabPaths = window.tabGroups.all
		.flatMap((group) => group.tabs)
		.map((tab) => (tab.input as TabInputText)?.uri?.fsPath)
		.filter(Boolean)

	// Deduplicated, order preserved.
	//
	// This is one entry per *tab*, and VS Code can hold two tabs for the same document
	// at once - most easily while an editor is still moving between columns, which is
	// exactly what opening a second document in another ViewColumn does. The same
	// fsPath then comes back twice.
	//
	// That is wrong for a list whose purpose is "which files are open": every consumer
	// wants distinct files, and a repeated path is at best redundant and at worst makes
	// a caller process the same file twice. It also surfaced as a test failure whose
	// message was actively misleading - the caller was waiting for a count of two with
	// a poll that could never succeed, so it reported a timeout rather than the real
	// cause, which is one path too many.
	return GetOpenTabsResponse.create({ paths: [...new Set(openTabPaths)] })
}
