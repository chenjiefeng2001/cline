import { GlobalFileNames } from "@core/storage/disk"
import { EmptyRequest } from "@shared/proto/cline/common"
import { OpenRouterCompatibleModelInfo, OpenRouterModelInfo } from "@shared/proto/cline/models"
import axios from "axios"
import fs from "fs/promises"
import path from "path"
import { getAxiosSettings } from "@/shared/net"
import { Controller } from ".."

/**
 * The raw model information returned by the Hicap API to list models
 */
interface HicapRawModelInfo {
	id: string
	object: string
}

/**
 * Refreshes the Hicap models and returns the updated model list
 * @param controller The controller instance
 * @param request Empty request object
 * @returns Response containing the OpenRouter models
 */
// Consolidation with the SDK is supported via modelsSourceUrl and the
// mergeKnownModels merge-mode. The SDK's generic models-URL fetcher now
// layers live IDs on top of the curated catalog for cloud providers.
// Hicap is a local provider and is excluded from the merge behavior.
// This handler remains for backward compatibility with the extension-only
// RPC until the CLI/other clients are fully migrated.
export async function refreshHicapModels(controller: Controller, _request: EmptyRequest): Promise<OpenRouterCompatibleModelInfo> {
	const hicapModelsFilePath = path.join(await ensureCacheDirectoryExists(controller), GlobalFileNames.hicapModels)

	const models: Record<string, OpenRouterModelInfo> = {}
	try {
		// Get the Hicap API key from the controller's state
		const hicapApiKey = controller.stateManager.getSecretKey("hicapApiKey")

		const response = await axios.get("https://api.hicap.ai/v2/openai/models", {
			headers: {
				"api-key": hicapApiKey,
			},
			...getAxiosSettings(),
		})

		if (response.data?.data) {
			const rawModels = response.data.data

			for (const rawModel of rawModels as HicapRawModelInfo[]) {
				models[rawModel.id] = {
					maxTokens: -1,
					contextWindow: 128_000,
					supportsImages: true,
					supportsPromptCache: true,
					inputPrice: 0,
					outputPrice: 0,
					cacheWritesPrice: 0,
					cacheReadsPrice: 0,
					tiers: [],
					description: "",
				}
			}
		}
		await fs.writeFile(hicapModelsFilePath, JSON.stringify(models))
	} catch (_error) {
		// If we failed to fetch models, keep whatever we have.
	}

	return OpenRouterCompatibleModelInfo.create({ models })
}

/**
 * Ensures the cache directory exists and returns its path
 */
async function ensureCacheDirectoryExists(controller: Controller): Promise<string> {
	const cacheDir = path.join(controller.context.globalStorageUri.fsPath, "cache")
	await fs.mkdir(cacheDir, { recursive: true })
	return cacheDir
}
