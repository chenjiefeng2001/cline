import { LoadHistoryBatchRequest, LoadHistoryBatchResponse } from "@shared/proto/cline/task"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."

/**
 * Loads a batch of older messages for a task (pagination).
 * Delegates to the SDK-backed controller which reads from the session host
 * or falls back to legacy on-disk storage.
 */
export async function loadHistoryBatch(
	controller: Controller,
	request: LoadHistoryBatchRequest,
): Promise<LoadHistoryBatchResponse> {
	try {
		return await controller.loadHistoryBatch(request)
	} catch (error) {
		Logger.error("[loadHistoryBatch] Error loading history batch:", error)
		throw error
	}
}
