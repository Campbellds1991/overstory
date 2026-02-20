import type {
	BuildProviderLaunchInput,
	ProviderAdapter,
	ProviderConfig,
	ProviderLaunchSpec,
	ProviderModelResolution,
	ProviderRegistry,
	ProviderStartupProfileName,
	ProviderStartupSemantics,
	ResolveProviderModelInput,
	ResolvedModel,
} from "../types.ts";

const DEFAULT_GATEWAY_ALIAS = "sonnet";

const STARTUP_PROFILES: Record<ProviderStartupProfileName, ProviderStartupSemantics> = {
	worker: {
		waitForTuiReady: true,
		initialDelayMs: 1_000,
		followupEnterDelaysMs: [1_000, 2_000],
	},
	persistent: {
		waitForTuiReady: true,
		initialDelayMs: 1_000,
		followupEnterDelaysMs: [1_000, 2_000],
	},
	monitor: {
		waitForTuiReady: false,
		initialDelayMs: 3_000,
		followupEnterDelaysMs: [500],
	},
};

function escapeForSingleQuotedShellArg(value: string): string {
	return value.replace(/'/g, "'\\''");
}

/**
 * Parse provider-prefixed model refs (provider/model-id).
 * Returns null for non-prefixed values.
 */
export function parseProviderModelRef(
	modelRef: string,
): { providerName: string; modelId: string } | null {
	const slashIdx = modelRef.indexOf("/");
	if (slashIdx <= 0 || slashIdx === modelRef.length - 1) {
		return null;
	}
	return {
		providerName: modelRef.slice(0, slashIdx),
		modelId: modelRef.slice(slashIdx + 1),
	};
}

/**
 * Resolve Anthropic-compatible gateway env for a provider/model pair.
 */
export function resolveGatewayProviderEnv(
	providerName: string,
	modelId: string,
	providers: Record<string, ProviderConfig>,
	env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Record<string, string> | null {
	const provider = providers[providerName];
	if (!provider || provider.type !== "gateway") return null;
	if (!provider.baseUrl) return null;

	const result: Record<string, string> = {
		ANTHROPIC_BASE_URL: provider.baseUrl,
		ANTHROPIC_API_KEY: "",
		ANTHROPIC_DEFAULT_SONNET_MODEL: modelId,
	};

	if (provider.authTokenEnv) {
		const token = env[provider.authTokenEnv];
		if (token) {
			result.ANTHROPIC_AUTH_TOKEN = token;
		}
	}

	return result;
}

function buildClaudeCommand(model: string, appendSystemPrompt?: string): string {
	let command = `claude --model ${model} --dangerously-skip-permissions`;
	if (appendSystemPrompt && appendSystemPrompt.length > 0) {
		command += ` --append-system-prompt '${escapeForSingleQuotedShellArg(appendSystemPrompt)}'`;
	}
	return command;
}

class NativeProviderAdapter implements ProviderAdapter {
	readonly kind = "native" as const;

	resolveModel(modelRef: string): ResolvedModel {
		return { model: modelRef };
	}

	buildCommand(model: string, appendSystemPrompt?: string): string {
		return buildClaudeCommand(model, appendSystemPrompt);
	}
}

class GatewayProviderAdapter implements ProviderAdapter {
	readonly kind = "gateway" as const;

	resolveModel(
		modelRef: string,
		providerName: string | null,
		providers: Record<string, ProviderConfig>,
		env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
	): ResolvedModel {
		if (!providerName) {
			return { model: modelRef };
		}

		const parsed = parseProviderModelRef(modelRef);
		if (!parsed || parsed.providerName !== providerName) {
			return { model: modelRef };
		}

		const providerEnv = resolveGatewayProviderEnv(providerName, parsed.modelId, providers, env);
		if (!providerEnv) {
			return { model: modelRef };
		}

		return {
			model: DEFAULT_GATEWAY_ALIAS,
			env: providerEnv,
		};
	}

	buildCommand(model: string, appendSystemPrompt?: string): string {
		return buildClaudeCommand(model, appendSystemPrompt);
	}
}

function pickAdapter(
	modelRef: string,
	providers: Record<string, ProviderConfig>,
	adapters: { native: ProviderAdapter; gateway: ProviderAdapter },
): { providerName: string | null; adapter: ProviderAdapter } {
	const parsed = parseProviderModelRef(modelRef);
	if (!parsed) {
		return { providerName: null, adapter: adapters.native };
	}

	const provider = providers[parsed.providerName];
	if (!provider) {
		return { providerName: parsed.providerName, adapter: adapters.native };
	}

	return {
		providerName: parsed.providerName,
		adapter: provider.type === "gateway" ? adapters.gateway : adapters.native,
	};
}

export class DefaultProviderRegistry implements ProviderRegistry {
	private readonly adapters: { native: ProviderAdapter; gateway: ProviderAdapter };

	constructor(adapters?: { native?: ProviderAdapter; gateway?: ProviderAdapter }) {
		this.adapters = {
			native: adapters?.native ?? new NativeProviderAdapter(),
			gateway: adapters?.gateway ?? new GatewayProviderAdapter(),
		};
	}

	resolveModel(input: ResolveProviderModelInput): ProviderModelResolution {
		const modelRef = String(input.config.models[input.role] ?? input.manifest.agents[input.role]?.model ?? input.fallback);
		const { providerName, adapter } = pickAdapter(modelRef, input.config.providers, this.adapters);
		const resolved = adapter.resolveModel(modelRef, providerName, input.config.providers);
		return {
			modelRef,
			model: resolved.model,
			env: resolved.env,
			providerName,
			adapterKind: adapter.kind,
		};
	}

	buildLaunch(input: BuildProviderLaunchInput): ProviderLaunchSpec {
		const resolution = this.resolveModel(input);
		const startup = STARTUP_PROFILES[input.startupProfile];
		const adapter = resolution.adapterKind === "gateway" ? this.adapters.gateway : this.adapters.native;
		return {
			command: adapter.buildCommand(resolution.model, input.appendSystemPrompt),
			env: resolution.env ?? {},
			startup,
			resolution,
		};
	}
}

export function createProviderRegistry(): ProviderRegistry {
	return new DefaultProviderRegistry();
}
