export interface WebviewMessage {
	type: "grpc_request" | "grpc_request_cancel" | "webview_ready" | "webview_error"
	grpc_request?: GrpcRequest
	grpc_request_cancel?: GrpcCancel
	/**
	 * A failure inside the webview that the user cannot otherwise see. VS Code does not
	 * persist the webview console to disk, so a script that fails to evaluate, or an
	 * unhandled error during mount, otherwise leaves no trace anywhere: the panel is
	 * simply blank and the extension log ends at "Webview view resolved".
	 */
	webview_error?: WebviewErrorReport
}

export type WebviewErrorReport = {
	/** "load" = the bundle never evaluated, "runtime" = threw after mount. */
	phase: "load" | "runtime"
	message: string
	stack?: string
	source?: string
	line?: number
	column?: number
}

export type GrpcRequest = {
	service: string
	method: string
	message: any // JSON serialized protobuf message
	request_id: string // For correlating requests and responses
	is_streaming: boolean // Whether this is a streaming request
}

export type GrpcCancel = {
	request_id: string // ID of the request to cancel
}

export type ClineAskResponse = "yesButtonClicked" | "noButtonClicked" | "messageResponse"

export type ClineCheckpointRestore = "task" | "workspace" | "taskAndWorkspace"

export type TaskFeedbackType = "thumbs_up" | "thumbs_down"
