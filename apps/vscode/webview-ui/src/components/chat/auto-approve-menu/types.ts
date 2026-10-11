import { AutoApprovalSettings } from "@shared/AutoApprovalSettings"

export interface ActionMetadata {
	id: keyof AutoApprovalSettings["actions"] | "enableNotifications"
	label: string
	shortName: string
	icon: string
	/**
	 * Shown under the label. Used where the toggle's scope is narrower than its
	 * name suggests, so the user can tell what will and will not be skipped.
	 */
	description?: string
	subAction?: ActionMetadata
	sub?: boolean
	parentActionId?: string
}
