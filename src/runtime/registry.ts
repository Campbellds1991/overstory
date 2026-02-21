import { join } from "node:path";
import { createProviderRegistry } from "../providers/registry.ts";
import type {
	BuildProviderLaunchInput,
	OverstoryConfig,
	ProviderRegistry,
	ProviderLaunchSpec,
	RuntimeAdapter,
	RuntimeMetadata,
	RuntimeName,
	RuntimeRegistry,
} from "../types.ts";

const RUNTIME_METADATA: Record<RuntimeName, RuntimeMetadata> = {
	claude: {
		sessionConfigDir: ".claude",
		overlayFile: "CLAUDE.md",
		hooksFile: "settings.local.json",
		assignmentPath: ".claude/CLAUDE.md",
		transcriptRootDir: ".claude/projects",
	},
	codex: {
		sessionConfigDir: ".codex",
		overlayFile: "AGENTS.md",
		hooksFile: "settings.local.json",
		assignmentPath: ".codex/AGENTS.md",
		transcriptRootDir: ".codex/sessions",
	},
};

function escapeForSingleQuotedShellArg(value: string): string {
	return value.replace(/'/g, "'\\''");
}

function buildCodexCommand(model: string, appendSystemPrompt?: string): string {
	let command = `codex --model ${model} --dangerously-bypass-approvals-and-sandbox`;
	if (appendSystemPrompt && appendSystemPrompt.length > 0) {
		command += ` '${escapeForSingleQuotedShellArg(appendSystemPrompt)}'`;
	}
	return command;
}

class ClaudeRuntimeAdapter implements RuntimeAdapter {
	readonly name = "claude" as const;
	readonly metadata = RUNTIME_METADATA.claude;

	constructor(private readonly providers: ProviderRegistry) {}

	buildLaunch(input: BuildProviderLaunchInput): ProviderLaunchSpec {
		return this.providers.buildLaunch(input);
	}

	buildTriageCommand(prompt: string): string[] {
		return ["claude", "--print", "-p", prompt];
	}

	resolveTranscriptProjectDir(homeDir: string, projectKey: string): string {
		return join(homeDir, this.metadata.transcriptRootDir, projectKey);
	}
}

class CodexRuntimeAdapter implements RuntimeAdapter {
	readonly name = "codex" as const;
	readonly metadata = RUNTIME_METADATA.codex;

	constructor(private readonly providers: ProviderRegistry) {}

	buildLaunch(input: BuildProviderLaunchInput): ProviderLaunchSpec {
		const launch = this.providers.buildLaunch(input);
		return {
			...launch,
			command: buildCodexCommand(launch.resolution.model, input.appendSystemPrompt),
		};
	}

	buildTriageCommand(prompt: string): string[] {
		return [
			"codex",
			"exec",
			"--skip-git-repo-check",
			"--dangerously-bypass-approvals-and-sandbox",
			prompt,
		];
	}

	resolveTranscriptProjectDir(homeDir: string, projectKey: string): string {
		return join(homeDir, this.metadata.transcriptRootDir, projectKey);
	}
}

class DefaultRuntimeRegistry implements RuntimeRegistry {
	private readonly adapters: Record<RuntimeName, RuntimeAdapter>;

	constructor(providers: ProviderRegistry) {
		this.adapters = {
			claude: new ClaudeRuntimeAdapter(providers),
			codex: new CodexRuntimeAdapter(providers),
		};
	}

	get(name: RuntimeName): RuntimeAdapter {
		return this.adapters[name];
	}

	resolve(config: OverstoryConfig): RuntimeAdapter {
		const runtimeName = config.runtime?.name ?? "claude";
		return runtimeName === "codex" ? this.adapters.codex : this.adapters.claude;
	}
}

export function createRuntimeRegistry(options: { providers?: ProviderRegistry } = {}): RuntimeRegistry {
	const providers = options.providers ?? createProviderRegistry();
	return new DefaultRuntimeRegistry(providers);
}

