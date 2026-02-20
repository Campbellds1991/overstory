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

function makeRegistrySpy() {
	const calls: BuildProviderLaunchInput[] = [];
	const resolution: ProviderModelResolution = {
		modelRef: "sonnet",
		model: "sonnet",
		providerName: null,
		adapterKind: "native",
	};
	const launch: ProviderLaunchSpec = {
		command: "claude --model sonnet --dangerously-skip-permissions",
		env: {},
		startup: {
			waitForTuiReady: true,
			initialDelayMs: 1000,
			followupEnterDelaysMs: [1000, 2000],
		},
		resolution,
	};

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

describe("provider-command integration helpers", () => {
	test("resolveSlingLaunch wires capability role + worker startup profile", () => {
		const { registry, calls, launch } = makeRegistrySpy();
		const result = resolveSlingLaunch(registry, BASE_CONFIG, BASE_MANIFEST, "builder", "sonnet");
		expect(result).toBe(launch);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.role).toBe("builder");
		expect(calls[0]?.fallback).toBe("sonnet");
		expect(calls[0]?.startupProfile).toBe("worker");
	});

	test("resolveCoordinatorLaunch wires coordinator role + persistent startup profile", () => {
		const { registry, calls, launch } = makeRegistrySpy();
		const result = resolveCoordinatorLaunch(registry, BASE_CONFIG, BASE_MANIFEST, "coord prompt");
		expect(result).toBe(launch);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.role).toBe("coordinator");
		expect(calls[0]?.fallback).toBe("opus");
		expect(calls[0]?.startupProfile).toBe("persistent");
		expect(calls[0]?.appendSystemPrompt).toBe("coord prompt");
	});

	test("resolveSupervisorLaunch wires supervisor role + persistent startup profile", () => {
		const { registry, calls, launch } = makeRegistrySpy();
		const result = resolveSupervisorLaunch(registry, BASE_CONFIG, BASE_MANIFEST, "sup prompt");
		expect(result).toBe(launch);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.role).toBe("supervisor");
		expect(calls[0]?.fallback).toBe("opus");
		expect(calls[0]?.startupProfile).toBe("persistent");
		expect(calls[0]?.appendSystemPrompt).toBe("sup prompt");
	});

	test("resolveMonitorLaunch wires monitor role + monitor startup profile", () => {
		const { registry, calls, launch } = makeRegistrySpy();
		const result = resolveMonitorLaunch(registry, BASE_CONFIG, BASE_MANIFEST, "monitor prompt");
		expect(result).toBe(launch);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.role).toBe("monitor");
		expect(calls[0]?.fallback).toBe("sonnet");
		expect(calls[0]?.startupProfile).toBe("monitor");
		expect(calls[0]?.appendSystemPrompt).toBe("monitor prompt");
	});
});
