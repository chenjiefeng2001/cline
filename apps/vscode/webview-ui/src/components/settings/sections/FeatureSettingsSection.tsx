import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { memo, type ReactNode, useEffect, useState } from "react"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { DebouncedTextField } from "../common/DebouncedTextField"
import Section from "../Section"
import { updateSetting } from "../utils/settingsHandlers"

// Reusable checkbox component for feature settings
interface FeatureCheckboxProps {
	checked: boolean | undefined
	onChange: (checked: boolean) => void
	label: string
	description: ReactNode
	disabled?: boolean
	isRemoteLocked?: boolean
	remoteTooltip?: string
	isVisible?: boolean
}

// Interface for feature toggle configuration
interface FeatureToggle {
	id: string
	label: string
	description: ReactNode
	settingKey: keyof UpdateSettingsRequest
	stateKey: string
}

const agentFeatures: FeatureToggle[] = [
	{
		id: "auto-compact",
		label: "Auto Compact",
		description: "Automatically compress conversation history.",
		stateKey: "useAutoCondense",
		settingKey: "useAutoCondense",
	},
	{
		id: "subagents",
		label: "Subagents",
		description: "Delegate independent sub-tasks to subagents running in parallel for multi-step work.",
		stateKey: "subagentsEnabled",
		settingKey: "subagentsEnabled",
	},
]

const editorFeatures: FeatureToggle[] = [
	{
		id: "show-feature-tips",
		label: "Feature Tips",
		description: "Show rotating tips during the thinking phase to help you discover Cline features.",
		stateKey: "showFeatureTips",
		settingKey: "showFeatureTips",
	},
	{
		id: "background-edit",
		label: "Background Edit",
		description: "Allow edits without stealing editor focus",
		stateKey: "backgroundEditEnabled",
		settingKey: "backgroundEditEnabled",
	},
	{
		id: "checkpoints",
		label: "Checkpoints",
		description: "Save progress at key points for easy rollback",
		stateKey: "enableCheckpointsSetting",
		settingKey: "enableCheckpointsSetting",
	},
	{
		id: "worktrees",
		label: "Worktrees",
		description: "Enables git worktree management for running parallel Cline tasks.",
		stateKey: "worktreesEnabled",
		settingKey: "worktreesEnabled",
	},
]

const experimentalFeatures: FeatureToggle[] = [
	{
		id: "yolo",
		label: "Yolo Mode",
		description:
			"Execute tasks without user's confirmation. Auto-switches from Plan to Act mode and disables the ask question tool. Use with extreme caution.",
		stateKey: "yoloModeToggled",
		settingKey: "yoloModeToggled",
	},
]

const advancedFeatures: FeatureToggle[] = [
	{
		id: "hooks",
		label: "Hooks",
		description: "Enable lifecycle and tool hooks during task execution.",
		stateKey: "hooksEnabled",
		settingKey: "hooksEnabled",
	},
]

const FeatureRow = memo(
	({
		checked = false,
		onChange,
		label,
		description,
		disabled,
		isRemoteLocked,
		isVisible = true,
		remoteTooltip,
	}: FeatureCheckboxProps) => {
		if (!isVisible) {
			return null
		}

		const checkbox = (
			<div className="flex items-center justify-between w-full">
				<div>{label}</div>
				<div>
					<Switch
						checked={checked}
						className="shrink-0"
						disabled={disabled || isRemoteLocked}
						id={label}
						onCheckedChange={onChange}
						size="lg"
					/>
					{isRemoteLocked && <i className="codicon codicon-lock text-description text-sm" />}
				</div>
			</div>
		)

		return (
			<div className="flex flex-col items-start justify-between gap-4 py-3 w-full">
				<div className="space-y-0.5 flex-1 w-full">
					{isRemoteLocked ? (
						<Tooltip>
							<TooltipTrigger asChild>{checkbox}</TooltipTrigger>
							<TooltipContent className="max-w-xs" side="top">
								{remoteTooltip}
							</TooltipContent>
						</Tooltip>
					) : (
						checkbox
					)}
				</div>
				<div className="text-xs text-description">{description}</div>
			</div>
		)
	},
)

interface FeatureSettingsSectionProps {
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

/**
 * Number input with local draft state that commits on blur/Enter.
 * Mirrors the pattern used by TerminalSettingsSection to avoid mid-typing
 * resets when the backend round-trips the confirmed value.
 */
const NumberSettingField = memo(
	({
		id,
		label,
		description,
		value,
		onCommit,
		placeholder,
		min = 0,
		max,
	}: {
		id: string
		label: string
		description: string
		value: number | undefined
		onCommit: (value: number | undefined) => void
		placeholder?: string
		min?: number
		max?: number
	}) => {
		const [text, setText] = useState(value === undefined ? "" : String(value))
		const [error, setError] = useState<string | null>(null)

		useEffect(() => {
			setText(value === undefined ? "" : String(value))
		}, [value])

		const commit = () => {
			if (text.trim() === "") {
				setError(null)
				onCommit(undefined)
				return
			}
			const parsed = Number.parseInt(text, 10)
			if (Number.isNaN(parsed) || parsed < min || (max !== undefined && parsed > max)) {
				setError(
					max !== undefined
						? `Enter a whole number between ${min} and ${max}`
						: `Enter a whole number of at least ${min}`,
				)
				return
			}
			setError(null)
			onCommit(parsed)
		}

		return (
			<div className="space-y-2">
				<Label className="text-sm font-medium text-foreground">{label}</Label>
				<p className="text-xs text-muted-foreground">{description}</p>
				<VSCodeTextField
					className="w-full"
					id={id}
					onBlur={commit}
					onInput={(event) => setText((event.target as HTMLInputElement).value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							commit()
						}
					}}
					placeholder={placeholder}
					value={text}
				/>
				{error && <p className="text-xs text-error">{error}</p>}
			</div>
		)
	},
)

const FeatureSettingsSection = ({ renderSectionHeader }: FeatureSettingsSectionProps) => {
	const {
		enableCheckpointsSetting,
		hooksEnabled,
		mcpDisplayMode,
		yoloModeToggled,
		useAutoCondense,
		compactionStrategy,
		autoCompactThreshold,
		subagentsEnabled,
		worktreesEnabled,
		remoteConfigSettings,
		backgroundEditEnabled,
		showFeatureTips,
		maxConsecutiveMistakes,
		maxIterationsSetting,
		maxParallelToolCalls,
		runBudgetMaxTotalCost,
		fileBoundaryEnabled,
		fileBoundaryAdditionalRoots,
		agentTeamsEnabled,
		memoryEnabled,
		memoryRecallEnabled,
		memoryWriteEnabled,
		memoryAutoCaptureEnabled,
		webSearchEnabled,
		requestTimeoutMs,
	} = useExtensionState()

	const isYoloRemoteLocked = remoteConfigSettings?.yoloModeToggled !== undefined

	// State lookup for mapped features
	const featureState: Record<string, boolean | undefined> = {
		showFeatureTips,
		enableCheckpointsSetting,
		hooksEnabled,
		useAutoCondense,
		subagentsEnabled,
		worktreesEnabled: worktreesEnabled?.user,
		backgroundEditEnabled,
		yoloModeToggled: isYoloRemoteLocked ? remoteConfigSettings?.yoloModeToggled : yoloModeToggled,
	}

	// Visibility lookup for features with feature flags
	const featureVisibility: Record<string, boolean | undefined> = {
		worktreesEnabled: worktreesEnabled?.featureFlag,
	}

	return (
		<div className="mb-2">
			{renderSectionHeader("features")}
			<Section>
				<div className="mb-5 flex flex-col gap-3">
					{/* Core features */}
					<div>
						<div className="text-xs font-medium text-foreground/80 uppercase tracking-wider mb-3">Agent</div>
						<div
							className="relative p-3 pt-0 my-3 rounded-md border border-editor-widget-border/50"
							id="agent-features">
							{agentFeatures.map((feature) => (
								<FeatureRow
									checked={featureState[feature.stateKey]}
									description={feature.description}
									isVisible={featureVisibility[feature.stateKey] ?? true}
									key={feature.id}
									label={feature.label}
									onChange={(checked) => updateSetting(feature.settingKey, checked)}
								/>
							))}
							<div className="space-y-2 py-3">
								<Label className="text-sm font-medium text-foreground">Auto Compact Strategy</Label>
								<p className="text-xs text-muted-foreground">Controls how auto compaction rewrites context.</p>
								<Select
									disabled={!useAutoCondense}
									onValueChange={(value) => updateSetting("compactionStrategy", value)}
									value={compactionStrategy ?? "basic"}>
									<SelectTrigger className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="basic">Basic</SelectItem>
										<SelectItem value="agentic">Agentic</SelectItem>
									</SelectContent>
								</Select>
							</div>
							<div className="pt-3">
								<NumberSettingField
									description="Percentage of the usable input budget at which Cline auto-compacts the conversation (50-100)."
									id="auto-compact-threshold"
									label="Auto Compact Threshold"
									max={100}
									min={50}
									onCommit={(value) => updateSetting("autoCompactThreshold", value)}
									placeholder="90"
									value={autoCompactThreshold ?? 90}
								/>
							</div>
							<div className="pt-3">
								<NumberSettingField
									description="Maximum number of consecutive failed tool attempts before Cline stops and asks for guidance."
									id="max-consecutive-mistakes"
									label="Max Consecutive Mistakes"
									onCommit={(value) => updateSetting("maxConsecutiveMistakes", value ?? 0)}
									value={maxConsecutiveMistakes ?? 3}
								/>
							</div>
							<div className="pt-3">
								<NumberSettingField
									description="Maximum model round-trips per turn. Set to 0 for no limit — useful for long autonomous runs, where a hard stop can truncate real work. Leave a value as a guardrail against a runaway loop."
									id="max-iterations"
									label="Max Iterations"
									min={0}
									onCommit={(value) => updateSetting("maxIterationsSetting", value ?? 0)}
									placeholder="0"
									value={maxIterationsSetting ?? 0}
								/>
							</div>
							<div className="pt-3">
								<NumberSettingField
									description="Spend ceiling in USD for a single agent run. 0 removes the ceiling. Reaching it ends the turn as budget_exhausted rather than crashing."
									id="run-budget-max-total-cost"
									label="Run Budget (USD)"
									min={0}
									onCommit={(value) => updateSetting("runBudgetMaxTotalCost", value ?? 0)}
									placeholder="0"
									value={runBudgetMaxTotalCost ?? 5}
								/>
							</div>
							<div className="pt-3">
								<NumberSettingField
									description="Tool calls run concurrently within one assistant turn. Only tools that declare themselves concurrency-safe batch together; everything else still runs alone. Set to 1 for fully serial execution."
									id="max-parallel-tool-calls"
									label="Max Parallel Tool Calls"
									min={1}
									onCommit={(value) => updateSetting("maxParallelToolCalls", value ?? 1)}
									placeholder="6"
									value={maxParallelToolCalls ?? 6}
								/>
							</div>
							<div className="space-y-2 py-3">
								<FeatureRow
									checked={agentTeamsEnabled}
									description="Enables the multi-agent team tool surface. This changes the model's tool set substantially, so it is separate from the subagent toggle above."
									label="Agent Teams"
									onChange={(checked) => updateSetting("agentTeamsEnabled", checked)}
								/>
							</div>
						</div>
					</div>

					{/* File-tool workspace boundary */}
					<div>
						<div className="text-xs font-medium text-foreground/80 uppercase tracking-wider mb-3">Files</div>
						<div
							className="relative p-3 pt-0 my-3 rounded-md border border-editor-widget-border/50"
							id="file-boundary">
							<div className="space-y-2 py-3">
								<FeatureRow
									checked={fileBoundaryEnabled ?? true}
									description="Restricts the file tools to the session workspace. Turning this off lets the agent reach any path on disk — prefer adding directories below instead."
									label="Restrict Files To Workspace"
									onChange={(checked) => updateSetting("fileBoundaryEnabled", checked)}
								/>
							</div>
							<div className="pt-3">
								<div className="space-y-2">
									<Label className="text-sm font-medium text-foreground">Additional Roots</Label>
									<p className="text-xs text-muted-foreground">
										Extra directories the file tools may touch, in addition to the workspace. Accepts a JSON
										array or a comma/newline separated list.
									</p>
									<DebouncedTextField
										id="file-boundary-additional-roots"
										initialValue={fileBoundaryAdditionalRoots ?? ""}
										onChange={(value) => updateSetting("fileBoundaryAdditionalRoots", value)}
										placeholder="/path/to/one, /path/to/two"
									/>
								</div>
							</div>
						</div>
					</div>

					{/* Memory */}
					<div>
						<div className="text-xs font-medium text-foreground/80 uppercase tracking-wider mb-3">Memory</div>
						<div
							className="relative p-3 pt-0 my-3 rounded-md border border-editor-widget-border/50"
							id="memory-features">
							<div className="space-y-2 py-3">
								<FeatureRow
									checked={memoryEnabled}
									description="Master switch for cross-session project memory. Off opens no store and exposes no tool."
									label="Memory"
									onChange={(checked) => updateSetting("memoryEnabled", checked)}
								/>
								<FeatureRow
									checked={memoryRecallEnabled}
									description="Exposes the recall_memory tool, which only reads stored memories."
									label="Memory Recall"
									onChange={(checked) => updateSetting("memoryRecallEnabled", checked)}
								/>
								<FeatureRow
									checked={memoryWriteEnabled}
									description="Exposes the remember tool. This is the agent-initiated write path and retains data outside the conversation, so it is opt-in."
									label="Memory Write"
									onChange={(checked) => updateSetting("memoryWriteEnabled", checked)}
								/>
								<FeatureRow
									checked={memoryAutoCaptureEnabled}
									description="Extracts memories from completed turns automatically, instead of only when the agent chooses to write one."
									label="Auto Capture"
									onChange={(checked) => updateSetting("memoryAutoCaptureEnabled", checked)}
								/>
							</div>
						</div>
					</div>

					{/* Web search */}
					<div>
						<div className="text-xs font-medium text-foreground/80 uppercase tracking-wider mb-3">Web Search</div>
						<div
							className="relative p-3 pt-0 my-3 rounded-md border border-editor-widget-border/50"
							id="web-search-features">
							<div className="space-y-2 py-3">
								<FeatureRow
									checked={webSearchEnabled}
									description="Enables live web search. A search sends the model's query text to a third-party provider — a different kind of data egress than reading a file."
									label="Web Search"
									onChange={(checked) => updateSetting("webSearchEnabled", checked)}
								/>
							</div>
						</div>
					</div>

					{/* Editor features */}
					<div>
						<div className="text-xs font-medium text-foreground/80 uppercase tracking-wider mb-3">Editor</div>
						<div
							className="relative p-3 pt-0 my-3 rounded-md border border-editor-widget-border/50"
							id="optional-features">
							{editorFeatures.map((feature) => (
								<FeatureRow
									checked={featureState[feature.stateKey]}
									description={feature.description}
									isVisible={featureVisibility[feature.stateKey] ?? true}
									key={feature.id}
									label={feature.label}
									onChange={(checked) => updateSetting(feature.settingKey, checked)}
								/>
							))}
						</div>
					</div>

					{/* Experimental features */}
					<div>
						<div className="text-xs font-medium uppercase tracking-wider mb-3 text-warning/80">Experimental</div>
						<div
							className="relative p-3 pt-0 my-3 rounded-md border border-editor-widget-border/50 w-full"
							id="experimental-features">
							{experimentalFeatures.map((feature) => (
								<FeatureRow
									checked={featureState[feature.stateKey]}
									description={feature.description}
									disabled={feature.id === "yolo" && isYoloRemoteLocked}
									isRemoteLocked={feature.id === "yolo" && isYoloRemoteLocked}
									isVisible={featureVisibility[feature.stateKey] ?? true}
									key={feature.id}
									label={feature.label}
									onChange={(checked) => updateSetting(feature.settingKey, checked)}
									remoteTooltip="This setting is managed by your organization's remote configuration"
								/>
							))}
						</div>
					</div>
				</div>

				{/* Advanced */}
				<div>
					<div className="text-xs font-medium text-foreground/80 uppercase tracking-wider mb-3">Advanced</div>
					<div className="relative p-3 my-3 rounded-md border border-editor-widget-border/50" id="advanced-features">
						<div className="space-y-3">
							{advancedFeatures.map((feature) => (
								<FeatureRow
									checked={featureState[feature.stateKey]}
									description={feature.description}
									isVisible={featureVisibility[feature.stateKey] ?? true}
									key={feature.id}
									label={feature.label}
									onChange={(checked) => updateSetting(feature.settingKey, checked)}
								/>
							))}

							{/* MCP Display Mode */}
							<div className="space-y-2">
								<Label className="text-sm font-medium text-foreground">MCP Display Mode</Label>
								<p className="text-xs text-muted-foreground">Controls how MCP responses are displayed</p>
								<Select onValueChange={(v) => updateSetting("mcpDisplayMode", v)} value={mcpDisplayMode}>
									<SelectTrigger className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="plain">Plain Text</SelectItem>
										<SelectItem value="rich">Rich Display</SelectItem>
										<SelectItem value="markdown">Markdown</SelectItem>
									</SelectContent>
								</Select>
							</div>

							{/* Network request timeout */}
							<NumberSettingField
								description="Network request timeout in milliseconds. Leave empty to use the provider default."
								id="request-timeout-ms"
								label="Request Timeout (ms)"
								onCommit={(value) => updateSetting("requestTimeoutMs", value ?? 0)}
								placeholder="Provider default"
								value={requestTimeoutMs}
							/>
						</div>
					</div>
				</div>
			</Section>
		</div>
	)
}
export default memo(FeatureSettingsSection)
