import type { ProviderConfig } from "../types.ts";

export type HookProviderKind = ProviderConfig["type"];

export type HookTarget = "agent" | "orchestrator";

export interface HookCommand {
	type: "command";
	command: string;
}

export interface HookEntry {
	matcher: string;
	hooks: HookCommand[];
}

export interface HookConfig {
	hooks: Record<string, HookEntry[]>;
}

export interface HookPolicyContext {
	agentName: string;
	capability: string;
	providerKind: HookProviderKind;
	target: HookTarget;
}

export interface HookPolicy {
	readonly name: string;
	apply(config: HookConfig, context: HookPolicyContext): HookConfig;
}

export interface HookAdapter {
	readonly kind: HookProviderKind;
	normalize(config: HookConfig, context: HookPolicyContext): HookConfig;
}

const HOOK_EVENT_KEYS = [
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"Stop",
	"PreCompact",
] as const;

const ENV_GUARD = '[ -z "$OVERSTORY_AGENT_NAME" ] && exit 0;';

function normalizeShellArgs(input: string): string {
	return input.trim().replace(/\s+/g, " ");
}

function normalizeLogCommand(
	command: string,
	eventName: "tool-start" | "tool-end" | "session-end",
	context: HookPolicyContext,
): string {
	const logArgsMatch = command.match(/overstory log [a-z-]+([^;]*)/);
	const logArgs = logArgsMatch?.[1] ?? "";

	const agentMatch = logArgs.match(/(?:^|\s)--agent\s+([^ ;]+)/);
	if (logArgs.includes("--agent") && !agentMatch) {
		throw new Error(
			`Unable to normalize overstory log command: unsupported --agent syntax in "${command}"`,
		);
	}
	const agentName = agentMatch?.[1] ?? context.agentName;

	const trailingArgs = normalizeShellArgs(
		logArgs
			.replace(/(?:^|\s)--agent\s+[^ ;]+/g, " ")
			.replace(/(?:^|\s)--stdin(?=\s|$)/g, " "),
	);
	const trailingArgsSuffix = trailingArgs.length > 0 ? ` ${trailingArgs}` : "";

	const needsEnvGuard =
		context.target === "agent" ||
		command.trimStart().startsWith(ENV_GUARD) ||
		command.includes("OVERSTORY_AGENT_NAME");
	const prefix = needsEnvGuard ? `${ENV_GUARD} ` : "";

	return `${prefix}overstory log ${eventName} --agent ${agentName} --stdin${trailingArgsSuffix}`;
}

function normalizeCommand(command: string, context: HookPolicyContext): string {
	if (command.includes("overstory log tool-start")) {
		return normalizeLogCommand(command, "tool-start", context);
	}

	if (command.includes("overstory log tool-end")) {
		return normalizeLogCommand(command, "tool-end", context);
	}

	if (command.includes("overstory log session-end")) {
		return normalizeLogCommand(command, "session-end", context);
	}

	return command;
}

function hasLogCommand(entries: HookEntry[], eventName: string): boolean {
	for (const entry of entries) {
		for (const hook of entry.hooks) {
			if (hook.command.includes(`overstory log ${eventName}`)) {
				return true;
			}
		}
	}
	return false;
}

function ensureBaseLogHook(
	config: HookConfig,
	hookType: string,
	eventName: "tool-start" | "tool-end" | "session-end",
	context: HookPolicyContext,
): void {
	const entries = config.hooks[hookType] ?? [];
	if (hasLogCommand(entries, eventName)) {
		config.hooks[hookType] = entries;
		return;
	}

	const prefix = context.target === "agent" ? `${ENV_GUARD} ` : "";
	const fallbackEntry: HookEntry = {
		matcher: "",
		hooks: [
			{
				type: "command",
				command: `${prefix}overstory log ${eventName} --agent ${context.agentName} --stdin`,
			},
		],
	};

	config.hooks[hookType] = [fallbackEntry, ...entries];
}

class ClaudeHookAdapter implements HookAdapter {
	readonly kind: HookProviderKind;

	constructor(kind: HookProviderKind) {
		this.kind = kind;
	}

	normalize(config: HookConfig, context: HookPolicyContext): HookConfig {
		const normalized = structuredClone(config);

		for (const hookType of HOOK_EVENT_KEYS) {
			if (!Array.isArray(normalized.hooks[hookType])) {
				normalized.hooks[hookType] = [];
			}
		}

		for (const hookEntries of Object.values(normalized.hooks)) {
			for (const entry of hookEntries) {
				entry.hooks = entry.hooks.map((hook) => {
					if (hook.type !== "command") {
						return hook;
					}
					return {
						type: "command",
						command: normalizeCommand(hook.command, context),
					};
				});
			}
		}

		ensureBaseLogHook(normalized, "PreToolUse", "tool-start", context);
		ensureBaseLogHook(normalized, "PostToolUse", "tool-end", context);
		ensureBaseLogHook(normalized, "Stop", "session-end", context);

		return normalized;
	}
}

const HOOK_ADAPTERS: Record<HookProviderKind, HookAdapter> = {
	native: new ClaudeHookAdapter("native"),
	gateway: new ClaudeHookAdapter("gateway"),
};

export function resolveHookAdapter(kind: HookProviderKind): HookAdapter {
	return HOOK_ADAPTERS[kind];
}
