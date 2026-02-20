import { describe, expect, test } from "bun:test";
import { resolveCoordinatorLaunch } from "./coordinator.ts";
import { resolveMonitorLaunch } from "./monitor.ts";
import { resolveSlingLaunch } from "./sling.ts";
import { resolveSupervisorLaunch } from "./supervisor.ts";
import type {
	AgentManifest,
	BuildProviderLaunchInput,
	OverstoryConfig,
	ProviderLaunchSpec,
	ProviderModelResolution,
	ProviderRegistry,
	ResolveProviderModelInput,
} from "../types.ts";

const BASE_MANIFEST: AgentManifest = {
	version: "1.0",
	agents: {
		builder: {
			file: "builder.md",
			model: "sonnet",
			tools: ["Read"],
			capabilities: ["implement"],
			canSpawn: false,
			constraints: [],
		},
		coordinator: {
			file: "coordinator.md",
			model: "opus",
			tools: ["Read"],
			capabilities: ["coordinate"],
			canSpawn: true,
			constraints: [],
		},
		supervisor: {
			file: "supervisor.md",
			model: "opus",
			tools: ["Read"],
			capabilities: ["supervise"],
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
		implement: ["builder"],
		coordinate: ["coordinator"],
		supervise: ["supervisor"],
		monitor: ["monitor"],
	},
};

const BASE_CONFIG: OverstoryConfig = {
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
	providers: { anthropic: { type: "native" } },
	watchdog: {
		tier0Enabled: false,
		tier0IntervalMs: 30000,
		tier1Enabled: false,
		tier2Enabled: true,
		staleThresholdMs: 300000,
		zombieThresholdMs: 600000,
		nudgeIntervalMs: 60000,
	},
	models: {},
	logging: { verbose: false, redactSecrets: true },
};

function makeRegistrySpy(options: {
	resolution: ProviderModelResolution;
	launch: ProviderLaunchSpec;
}) {
	const calls: BuildProviderLaunchInput[] = [];
	const { resolution, launch } = options;

	const registry: ProviderRegistry = {
		resolveModel(_input: ResolveProviderModelInput): ProviderModelResolution {
			return resolution;
		},
		buildLaunch(input: BuildProviderLaunchInput): ProviderLaunchSpec {
			calls.push(input);
			return launch;
		},
	};

	return { registry, calls, launch };
}

describe("provider-command integration regression matrix", () => {
	const providerMatrix: Array<{
		name: string;
		resolution: ProviderModelResolution;
	}> = [
		{
			name: "native",
			resolution: {
				modelRef: "sonnet",
				model: "sonnet",
				providerName: null,
				adapterKind: "native",
			},
		},
		{
			name: "gateway",
			resolution: {
				modelRef: "anthropic/claude-3-7-sonnet",
				model: "sonnet",
				providerName: "openrouter",
				adapterKind: "gateway",
			},
		},
	];

	const pathMatrix: Array<{
		path: "sling" | "coordinator" | "supervisor" | "monitor";
		expectedRole: string;
		expectedFallback: string;
		expectedStartup: "worker" | "persistent" | "monitor";
		supportsPrompt: boolean;
		invoke: (registry: ProviderRegistry, prompt: string) => ProviderLaunchSpec;
	}> = [
		{
			path: "sling",
			expectedRole: "builder",
			expectedFallback: "sonnet",
			expectedStartup: "worker",
			supportsPrompt: false,
			invoke: (registry) =>
				resolveSlingLaunch(registry, BASE_CONFIG, BASE_MANIFEST, "builder", "sonnet"),
		},
		{
			path: "coordinator",
			expectedRole: "coordinator",
			expectedFallback: "opus",
			expectedStartup: "persistent",
			supportsPrompt: true,
			invoke: (registry, prompt) =>
				resolveCoordinatorLaunch(registry, BASE_CONFIG, BASE_MANIFEST, prompt),
		},
		{
			path: "supervisor",
			expectedRole: "supervisor",
			expectedFallback: "opus",
			expectedStartup: "persistent",
			supportsPrompt: true,
			invoke: (registry, prompt) =>
				resolveSupervisorLaunch(registry, BASE_CONFIG, BASE_MANIFEST, prompt),
		},
		{
			path: "monitor",
			expectedRole: "monitor",
			expectedFallback: "sonnet",
			expectedStartup: "monitor",
			supportsPrompt: true,
			invoke: (registry, prompt) =>
				resolveMonitorLaunch(registry, BASE_CONFIG, BASE_MANIFEST, prompt),
		},
	];

	test("provider x orchestration-path matrix preserves launch wiring parity", () => {
		for (const providerCase of providerMatrix) {
			for (const pathCase of pathMatrix) {
				const appendSystemPrompt = `${pathCase.path} regression prompt`;
				const launch: ProviderLaunchSpec = {
					command: `${providerCase.name}-${pathCase.path}-launch`,
					env: { PROVIDER_KIND: providerCase.name.toUpperCase() },
					startup: {
						waitForTuiReady: true,
						initialDelayMs: 111,
						followupEnterDelaysMs: [222, 333],
					},
					resolution: providerCase.resolution,
				};
				const { registry, calls } = makeRegistrySpy({
					resolution: providerCase.resolution,
					launch,
				});

				const result = pathCase.invoke(registry, appendSystemPrompt);
				expect(result).toBe(launch);
				expect(calls).toHaveLength(1);

				const call = calls[0];
				expect(call).toBeDefined();
				expect(call?.config).toBe(BASE_CONFIG);
				expect(call?.manifest).toBe(BASE_MANIFEST);
				expect(call?.role).toBe(pathCase.expectedRole);
				expect(call?.fallback).toBe(pathCase.expectedFallback);
				expect(call?.startupProfile).toBe(pathCase.expectedStartup);

				if (pathCase.supportsPrompt) {
					expect(call?.appendSystemPrompt).toBe(appendSystemPrompt);
				} else {
					expect(call?.appendSystemPrompt).toBeUndefined();
				}
			}
		}
	});
});
