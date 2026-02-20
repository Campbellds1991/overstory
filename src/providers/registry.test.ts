import { describe, expect, test } from "bun:test";
import type { AgentManifest, OverstoryConfig } from "../types.ts";
import {
	createProviderRegistry,
	parseProviderModelRef,
	resolveGatewayProviderEnv,
} from "./registry.ts";

const BASE_MANIFEST: AgentManifest = {
	version: "1.0",
	agents: {
		coordinator: {
			file: "coordinator.md",
			model: "opus",
			tools: ["Read"],
			capabilities: ["coordinate"],
			canSpawn: true,
			constraints: [],
		},
		monitor: {
			file: "monitor.md",
			model: "sonnet",
			tools: ["Read"],
			capabilities: ["monitor"],
			canSpawn: false,
			constraints: [],
		},
	},
	capabilityIndex: {
		coordinate: ["coordinator"],
		monitor: ["monitor"],
	},
};

function makeConfig(
	models: OverstoryConfig["models"] = {},
	providers: OverstoryConfig["providers"] = { anthropic: { type: "native" } },
): OverstoryConfig {
	return {
		project: { name: "test", root: "/tmp/test", canonicalBranch: "main" },
		agents: {
			manifestPath: ".overstory/agent-manifest.json",
			baseDir: ".overstory/agent-defs",
			maxConcurrent: 5,
			staggerDelayMs: 1000,
			maxDepth: 2,
		},
		worktrees: { baseDir: ".overstory/worktrees" },
		beads: { enabled: false },
		mulch: { enabled: false, domains: [], primeFormat: "markdown" },
		merge: { aiResolveEnabled: false, reimagineEnabled: false },
		providers,
		watchdog: {
			tier0Enabled: false,
			tier0IntervalMs: 30000,
			tier1Enabled: false,
			tier2Enabled: false,
			staleThresholdMs: 300000,
			zombieThresholdMs: 600000,
			nudgeIntervalMs: 60000,
		},
		models,
		logging: { verbose: false, redactSecrets: true },
	};
}

describe("parseProviderModelRef", () => {
	test("parses provider/model-id format", () => {
		expect(parseProviderModelRef("openrouter/openai/gpt-5.3")).toEqual({
			providerName: "openrouter",
			modelId: "openai/gpt-5.3",
		});
	});

	test("returns null for non-prefixed model alias", () => {
		expect(parseProviderModelRef("sonnet")).toBeNull();
	});
});

describe("resolveGatewayProviderEnv", () => {
	test("returns gateway env including auth token when configured and present", () => {
		const env = resolveGatewayProviderEnv(
			"openrouter",
			"openai/gpt-5.3",
			{
				openrouter: {
					type: "gateway",
					baseUrl: "https://openrouter.ai/api/v1",
					authTokenEnv: "OPENROUTER_API_KEY",
				},
			},
			{ OPENROUTER_API_KEY: "token-123" },
		);
		expect(env).toEqual({
			ANTHROPIC_BASE_URL: "https://openrouter.ai/api/v1",
			ANTHROPIC_API_KEY: "",
			ANTHROPIC_DEFAULT_SONNET_MODEL: "openai/gpt-5.3",
			ANTHROPIC_AUTH_TOKEN: "token-123",
		});
	});
});

describe("ProviderRegistry", () => {
	test("selects native adapter for non-prefixed model ref", () => {
		const registry = createProviderRegistry();
		const config = makeConfig({ coordinator: "opus" });
		const result = registry.resolveModel({
			config,
			manifest: BASE_MANIFEST,
			role: "coordinator",
			fallback: "haiku",
		});
		expect(result.adapterKind).toBe("native");
		expect(result.model).toBe("opus");
		expect(result.providerName).toBeNull();
	});

	test("selects gateway adapter and rewrites launch model/env", () => {
		const registry = createProviderRegistry();
		const config = makeConfig(
			{ coordinator: "openrouter/openai/gpt-5.3" },
			{
				openrouter: {
					type: "gateway",
					baseUrl: "https://openrouter.ai/api/v1",
				},
			},
		);
		const result = registry.resolveModel({
			config,
			manifest: BASE_MANIFEST,
			role: "coordinator",
			fallback: "haiku",
		});
		expect(result.adapterKind).toBe("gateway");
		expect(result.model).toBe("sonnet");
		expect(result.providerName).toBe("openrouter");
		expect(result.env).toEqual({
			ANTHROPIC_BASE_URL: "https://openrouter.ai/api/v1",
			ANTHROPIC_API_KEY: "",
			ANTHROPIC_DEFAULT_SONNET_MODEL: "openai/gpt-5.3",
		});
	});

	test("falls back to native adapter for unknown provider names", () => {
		const registry = createProviderRegistry();
		const config = makeConfig({ coordinator: "unknown-provider/custom-model" });
		const result = registry.resolveModel({
			config,
			manifest: BASE_MANIFEST,
			role: "coordinator",
			fallback: "haiku",
		});
		expect(result.adapterKind).toBe("native");
		expect(result.providerName).toBe("unknown-provider");
		expect(result.model).toBe("unknown-provider/custom-model");
	});

	test("buildLaunch returns command + startup semantics for worker profile", () => {
		const registry = createProviderRegistry();
		const config = makeConfig({ coordinator: "opus" });
		const launch = registry.buildLaunch({
			config,
			manifest: BASE_MANIFEST,
			role: "coordinator",
			fallback: "haiku",
			startupProfile: "worker",
		});
		expect(launch.command).toContain("claude --model opus --dangerously-skip-permissions");
		expect(launch.startup).toEqual({
			waitForTuiReady: true,
			initialDelayMs: 1000,
			followupEnterDelaysMs: [1000, 2000],
		});
	});

	test("buildLaunch applies append-system-prompt escaping and monitor startup semantics", () => {
		const registry = createProviderRegistry();
		const config = makeConfig({ monitor: "sonnet" });
		const launch = registry.buildLaunch({
			config,
			manifest: BASE_MANIFEST,
			role: "monitor",
			fallback: "haiku",
			startupProfile: "monitor",
			appendSystemPrompt: "it's monitor time",
		});
		expect(launch.command).toContain("--append-system-prompt 'it'\\''s monitor time'");
		expect(launch.startup).toEqual({
			waitForTuiReady: false,
			initialDelayMs: 3000,
			followupEnterDelaysMs: [500],
		});
	});
});
