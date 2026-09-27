import { useEffect, useState } from "react"
import { RemoteConfigServiceClient } from "@/services/grpc-client"

export interface RemoteConfigSetting {
	type: "rule" | "workflow" | "skill"
	name: string
	content: string
	enabled: boolean
	locked: boolean
	toggle: () => void
}

function toggleRemoteConfigSetting(settingName: string) {
	// TODO(ENG): The backend handler is not implemented yet and currently
	// rejects, so the rejection is intentionally swallowed to avoid an
	// unhandled promise rejection. It is still logged: the toggle is wired to a
	// real button, so a silent catch here is indistinguishable from a dead
	// control, and this is the only trace that the RPC was even attempted.
	RemoteConfigServiceClient.toggleRemoteConfigSetting({ value: settingName }).catch((error) => {
		console.error(`[RemoteConfig] toggleRemoteConfigSetting("${settingName}") failed:`, error)
	})
}

export default function useRemoteConfigSettings(isVisible: boolean): RemoteConfigSetting[] {
	const [remoteConfigSettings, setRemoteConfigSettings] = useState<RemoteConfigSetting[]>([])

	useEffect(() => {
		if (!isVisible) {
			return
		}

		let isCancelled = false

		RemoteConfigServiceClient.getRemoteConfigSettings({}).then((response) => {
			if (isCancelled) {
				return
			}

			const settings = response.settings.map(
				(setting) =>
					({
						type: setting.type === 0 ? "rule" : setting.type === 1 ? "workflow" : "skill",
						name: setting.name,
						content: setting.content,
						enabled: setting.enabled,
						locked: setting.locked,
						toggle: () => {
							toggleRemoteConfigSetting(setting.name)
						},
					}) as RemoteConfigSetting,
			)
			setRemoteConfigSettings(settings)
		})

		return () => {
			isCancelled = true
		}
	}, [isVisible])

	return remoteConfigSettings
}
