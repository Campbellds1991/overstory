/**
 * CLI command: overstory mail send/check/list/read/reply
 *
 * Parses CLI args and delegates to the mail client.
 * Supports --inject for hook context injection, --json for machine output,
 * and various filters for listing messages.
 */

import { join } from "node:path";
import { resolveProjectRoot } from "../config.ts";
import { MailError, ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { isGroupAddress, resolveGroupAddress } from "../mail/broadcast.ts";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { MailMessage, MailMessageType } from "../types.ts";
import { MAIL_MESSAGE_TYPES } from "../types.ts";

/**
 * Protocol message types that require immediate recipient attention.
 * These trigger auto-nudge regardless of priority level.
 */
const AUTO_NUDGE_TYPES: ReadonlySet<MailMessageType> = new Set([
	"worker_done",
	"merge_ready",
	"error",
	"escalation",
	"merge_failed",
]);

/**
 * Parse a named flag value from an args array.
 * Returns the value after the flag, or undefined if not present.
 */
function getFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1 || idx + 1 >= args.length) {
		return undefined;
	}
	return args[idx + 1];
}

/** Check if a boolean flag is present in the args. */
function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

/** Boolean flags that do NOT consume the next arg as a value. */
const BOOLEAN_FLAGS = new Set(["--json", "--inject", "--unread", "--all", "--help", "-h"]);

/**
 * Extract positional arguments from an args array, skipping flag-value pairs.
 *
 * Iterates through args, skipping `--flag value` pairs for value-bearing flags
 * and lone boolean flags. Everything else is a positional arg.
 */
function getPositionalArgs(args: string[]): string[] {
	const positional: string[] = [];
	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (arg?.startsWith("-")) {
			// It's a flag. If it's boolean, skip just it; otherwise skip it + its value.
			if (BOOLEAN_FLAGS.has(arg)) {
				i += 1;
			} else {
				i += 2; // skip flag + its value
			}
		} else {
			if (arg !== undefined) {
				positional.push(arg);
			}
			i += 1;
		}
	}
	return positional;
}

/**
 * Resolve an agent name with fallback order:
 * 1) explicit flag(s), in the order provided
 * 2) OVERSTORY_AGENT_NAME environment variable
 * 3) fallback value (default: orchestrator)
 */
function resolveAgentName(
	args: string[],
	flags: readonly string[],
	fallback: string = "orchestrator",
): string {
	for (const flag of flags) {
		const value = getFlag(args, flag)?.trim();
		if (value && value.length > 0) {
			return value;
		}
	}
	const envAgent = process.env.OVERSTORY_AGENT_NAME?.trim();
	if (envAgent && envAgent.length > 0) {
		return envAgent;
	}
	return fallback;
}

/** Format a single message for human-readable output. */
function formatMessage(msg: MailMessage): string {
	const readMarker = msg.read ? " " : "*";
	const priorityTag = msg.priority !== "normal" ? ` [${msg.priority.toUpperCase()}]` : "";
	const lines: string[] = [
		`${readMarker} ${msg.id}  From: ${msg.from} → To: ${msg.to}${priorityTag}`,
		`  Subject: ${msg.subject}  (${msg.type})`,
		`  ${msg.body}`,
	];
	if (msg.payload !== null) {
		lines.push(`  Payload: ${msg.payload}`);
	}
	lines.push(`  ${msg.createdAt}`);
	return lines.join("\n");
}

/**
 * Open a mail store connected to the project's mail.db.
 * The cwd must already be resolved to the canonical project root.
 */
function openStore(cwd: string) {
	const dbPath = join(cwd, ".overstory", "mail.db");
	return createMailStore(dbPath);
}

// === Pending Nudge Markers ===
//
// Instead of sending tmux keys (which corrupt tool I/O), auto-nudge writes
// a JSON marker file per agent. The `mail check --inject` flow reads and
// clears these markers, prepending a priority banner to the injected output.

/** Directory where pending nudge markers are stored. */
function pendingNudgeDir(cwd: string): string {
	return join(cwd, ".overstory", "pending-nudges");
}

/** Shape of a pending nudge marker file. */
interface PendingNudge {
	from: string;
	reason: string;
	subject: string;
	messageId: string;
	createdAt: string;
}

/**
 * Write a pending nudge marker for an agent.
 *
 * Creates `.overstory/pending-nudges/{agent}.json` so that the next
 * `mail check --inject` call surfaces a priority banner for this message.
 * Overwrites any existing marker (only the latest nudge matters).
 */
async function writePendingNudge(
	cwd: string,
	agentName: string,
	nudge: Omit<PendingNudge, "createdAt">,
): Promise<void> {
	const dir = pendingNudgeDir(cwd);
	const { mkdir } = await import("node:fs/promises");
	await mkdir(dir, { recursive: true });

	const marker: PendingNudge = {
		...nudge,
		createdAt: new Date().toISOString(),
	};
	const filePath = join(dir, `${agentName}.json`);
	await Bun.write(filePath, `${JSON.stringify(marker, null, "\t")}\n`);
}

/**
 * Read and clear pending nudge markers for an agent.
 *
 * Returns the pending nudge (if any) and removes the marker file.
 * Called by `mail check --inject` to prepend a priority banner.
 */
async function readAndClearPendingNudge(
	cwd: string,
	agentName: string,
): Promise<PendingNudge | null> {
	const filePath = join(pendingNudgeDir(cwd), `${agentName}.json`);
	const file = Bun.file(filePath);
	if (!(await file.exists())) {
		return null;
	}
	try {
		const text = await file.text();
		const nudge = JSON.parse(text) as PendingNudge;
		const { unlink } = await import("node:fs/promises");
		await unlink(filePath);
		return nudge;
	} catch {
		// Corrupt or race condition — clear it and move on
		try {
			const { unlink } = await import("node:fs/promises");
			await unlink(filePath);
		} catch {
			// Already gone
		}
		return null;
	}
}

// === Mail Check Debounce ===
//
// Prevents excessive mail checking by tracking the last check timestamp per agent.
// When --debounce flag is provided, mail check will skip if called within the
// debounce window.

/**
 * Path to the mail check debounce state file.
 */
function mailCheckStatePath(cwd: string): string {
	return join(cwd, ".overstory", "mail-check-state.json");
}

/**
 * Check if a mail check for this agent is within the debounce window.
 *
 * @param cwd - Project root directory
 * @param agentName - Agent name
 * @param debounceMs - Debounce interval in milliseconds
 * @returns true if the last check was within the debounce window
 */
async function isMailCheckDebounced(
	cwd: string,
	agentName: string,
	debounceMs: number,
): Promise<boolean> {
	const statePath = mailCheckStatePath(cwd);
	const file = Bun.file(statePath);
	if (!(await file.exists())) {
		return false;
	}
	try {
		const text = await file.text();
		const state = JSON.parse(text) as Record<string, number>;
		const lastCheck = state[agentName];
		if (lastCheck === undefined) {
			return false;
		}
		return Date.now() - lastCheck < debounceMs;
	} catch {
		return false;
	}
}

/**
 * Record a mail check timestamp for debounce tracking.
 *
 * @param cwd - Project root directory
 * @param agentName - Agent name
 */
async function recordMailCheck(cwd: string, agentName: string): Promise<void> {
	const statePath = mailCheckStatePath(cwd);
	let state: Record<string, number> = {};
	const file = Bun.file(statePath);
	if (await file.exists()) {
		try {
			const text = await file.text();
			state = JSON.parse(text) as Record<string, number>;
		} catch {
			// Corrupt state file — start fresh
		}
	}
	state[agentName] = Date.now();
	await Bun.write(statePath, `${JSON.stringify(state, null, "\t")}\n`);
}

/**
 * Open a mail client connected to the project's mail.db.
 * The cwd must already be resolved to the canonical project root.
 */
function openClient(cwd: string) {
	const store = openStore(cwd);
	const client = createMailClient(store);
	return client;
}

/**
 * Refresh an agent's session heartbeat for mail activity.
 *
 * Keeps waiting/checking agents from being falsely marked stalled by watchdog.
 * Non-fatal: never throws.
 */
function refreshSessionHeartbeat(cwd: string, agentName: string): void {
	const normalized = agentName.trim();
	if (normalized.length === 0) {
		return;
	}
	try {
		const overstoryDir = join(cwd, ".overstory");
		const { store } = openSessionStore(overstoryDir);
		try {
			const session = store.getByName(normalized);
			if (!session) {
				return;
			}
			if (session.state === "completed" || session.state === "zombie") {
				return;
			}
			store.updateLastActivity(normalized);
			if (session.state === "booting" || session.state === "stalled") {
				store.updateState(normalized, "working");
			}
			if (session.stalledSince !== null || session.escalationLevel > 0) {
				store.updateEscalation(normalized, 0, null);
			}
		} finally {
			store.close();
		}
	} catch {
		// Non-fatal: activity refresh must not block mail commands
	}
}

/** overstory mail send */
async function handleSend(args: string[], cwd: string): Promise<void> {
	const to = getFlag(args, "--to");
	const subject = getFlag(args, "--subject");
	const body = getFlag(args, "--body");
	const from = resolveAgentName(args, ["--agent", "--from"]);
	const rawPayload = getFlag(args, "--payload");
	const VALID_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

	const rawType = getFlag(args, "--type") ?? "status";
	const rawPriority = getFlag(args, "--priority") ?? "normal";

	refreshSessionHeartbeat(cwd, from);

	if (!MAIL_MESSAGE_TYPES.includes(rawType as MailMessage["type"])) {
		throw new ValidationError(
			`Invalid --type "${rawType}". Must be one of: ${MAIL_MESSAGE_TYPES.join(", ")}`,
			{ field: "type", value: rawType },
		);
	}
	if (!VALID_PRIORITIES.includes(rawPriority as MailMessage["priority"])) {
		throw new ValidationError(
			`Invalid --priority "${rawPriority}". Must be one of: ${VALID_PRIORITIES.join(", ")}`,
			{ field: "priority", value: rawPriority },
		);
	}

	const type = rawType as MailMessage["type"];
	const priority = rawPriority as MailMessage["priority"];

	// Validate JSON payload if provided
	let payload: string | undefined;
	if (rawPayload !== undefined) {
		try {
			JSON.parse(rawPayload);
			payload = rawPayload;
		} catch {
			throw new ValidationError("--payload must be valid JSON", {
				field: "payload",
				value: rawPayload,
			});
		}
	}

	if (!to) {
		throw new ValidationError("--to is required for mail send", { field: "to" });
	}
	if (!subject) {
		throw new ValidationError("--subject is required for mail send", { field: "subject" });
	}
	if (!body) {
		throw new ValidationError("--body is required for mail send", { field: "body" });
	}

	// Handle broadcast messages (group addresses)
	if (isGroupAddress(to)) {
		const overstoryDir = join(cwd, ".overstory");
		const { store: sessionStore } = openSessionStore(overstoryDir);

		try {
			const activeSessions = sessionStore.getActive();
			const recipients = resolveGroupAddress(to, activeSessions, from);

			const client = openClient(cwd);
			const messageIds: string[] = [];

			try {
				// Fan out: send individual message to each recipient
				for (const recipient of recipients) {
					const id = client.send({ from, to: recipient, subject, body, type, priority, payload });
					messageIds.push(id);

					// Record mail_sent event for each individual message (fire-and-forget)
					try {
						const eventsDbPath = join(cwd, ".overstory", "events.db");
						const eventStore = createEventStore(eventsDbPath);
						try {
							let runId: string | null = null;
							const runIdPath = join(cwd, ".overstory", "current-run.txt");
							const runIdFile = Bun.file(runIdPath);
							if (await runIdFile.exists()) {
								const text = await runIdFile.text();
								const trimmed = text.trim();
								if (trimmed.length > 0) {
									runId = trimmed;
								}
							}
							eventStore.insert({
								runId,
								agentName: from,
								sessionId: null,
								eventType: "mail_sent",
								toolName: null,
								toolArgs: null,
								toolDurationMs: null,
								level: "info",
								data: JSON.stringify({
									to: recipient,
									subject,
									type,
									priority,
									messageId: id,
									broadcast: true,
								}),
							});
						} finally {
							eventStore.close();
						}
					} catch {
						// Event recording failure is non-fatal
					}

					// Auto-nudge for each individual message
					const shouldNudge =
						priority === "urgent" || priority === "high" || AUTO_NUDGE_TYPES.has(type);
					if (shouldNudge) {
						const nudgeReason = AUTO_NUDGE_TYPES.has(type) ? type : `${priority} priority`;
						await writePendingNudge(cwd, recipient, {
							from,
							reason: nudgeReason,
							subject,
							messageId: id,
						});
					}
				}
			} finally {
				client.close();
			}

			// Output broadcast summary
			if (hasFlag(args, "--json")) {
				process.stdout.write(
					`${JSON.stringify({ messageIds, recipientCount: recipients.length })}\n`,
				);
			} else {
				process.stdout.write(
					`📢 Broadcast sent to ${recipients.length} recipient${recipients.length === 1 ? "" : "s"} (${to})\n`,
				);
				for (let i = 0; i < recipients.length; i++) {
					const recipient = recipients[i];
					const msgId = messageIds[i];
					process.stdout.write(`   → ${recipient} (${msgId})\n`);
				}
			}

			return; // Early return — broadcast handled
		} finally {
			sessionStore.close();
		}
	}

	// Single-recipient message (existing logic)
	const client = openClient(cwd);
	try {
		const id = client.send({ from, to, subject, body, type, priority, payload });

		// Record mail_sent event to EventStore (fire-and-forget)
		try {
			const eventsDbPath = join(cwd, ".overstory", "events.db");
			const eventStore = createEventStore(eventsDbPath);
			try {
				let runId: string | null = null;
				const runIdPath = join(cwd, ".overstory", "current-run.txt");
				const runIdFile = Bun.file(runIdPath);
				if (await runIdFile.exists()) {
					const text = await runIdFile.text();
					const trimmed = text.trim();
					if (trimmed.length > 0) {
						runId = trimmed;
					}
				}
				eventStore.insert({
					runId,
					agentName: from,
					sessionId: null,
					eventType: "mail_sent",
					toolName: null,
					toolArgs: null,
					toolDurationMs: null,
					level: "info",
					data: JSON.stringify({ to, subject, type, priority, messageId: id }),
				});
			} finally {
				eventStore.close();
			}
		} catch {
			// Event recording failure is non-fatal
		}

		if (hasFlag(args, "--json")) {
			process.stdout.write(`${JSON.stringify({ id })}\n`);
		} else {
			process.stdout.write(`✉️  Sent message ${id} to ${to}\n`);
		}

		// Auto-nudge: write a pending nudge marker instead of sending tmux keys.
		// Direct tmux sendKeys during tool execution corrupts the agent's I/O,
		// causing SIGKILL (exit 137) and "request interrupted" errors (overstory-ii1o).
		// The message is already in the DB — the UserPromptSubmit hook's
		// `mail check --inject` will surface it on the next prompt cycle.
		// The pending nudge marker ensures the message gets a priority banner.
		const shouldNudge = priority === "urgent" || priority === "high" || AUTO_NUDGE_TYPES.has(type);
		if (shouldNudge) {
			const nudgeReason = AUTO_NUDGE_TYPES.has(type) ? type : `${priority} priority`;
			await writePendingNudge(cwd, to, {
				from,
				reason: nudgeReason,
				subject,
				messageId: id,
			});
			if (!hasFlag(args, "--json")) {
				process.stdout.write(
					`📢 Queued nudge for "${to}" (${nudgeReason}, delivered on next prompt)\n`,
				);
			}
		}

		// Reviewer coverage check for merge_ready (advisory warning)
		if (type === "merge_ready") {
			try {
				const overstoryDir = join(cwd, ".overstory");
				const { store: sessionStore } = openSessionStore(overstoryDir);
				try {
					const allSessions = sessionStore.getAll();
					const myBuilders = allSessions.filter(
						(s) => s.parentAgent === from && s.capability === "builder",
					);
					const myReviewers = allSessions.filter(
						(s) => s.parentAgent === from && s.capability === "reviewer",
					);
					if (myBuilders.length > 0 && myReviewers.length === 0) {
						process.stderr.write(
							`\n⚠️  WARNING: merge_ready sent but NO reviewer sessions found for "${from}".\n` +
								`⚠️  ${myBuilders.length} builder(s) completed without review. This violates the review-before-merge requirement.\n` +
								`⚠️  Spawn reviewers for each builder before merge. See REVIEW_SKIP in agents/lead.md.\n\n`,
						);
					} else if (myReviewers.length > 0 && myReviewers.length < myBuilders.length) {
						process.stderr.write(
							`\n⚠️  NOTE: Only ${myReviewers.length} reviewer(s) for ${myBuilders.length} builder(s). Ensure all builder work is review-verified.\n\n`,
						);
					}
				} finally {
					sessionStore.close();
				}
			} catch {
				// Reviewer check failure is non-fatal — do not block mail send
			}
		}
	} finally {
		client.close();
	}
}

/** overstory mail check */
async function handleCheck(args: string[], cwd: string): Promise<void> {
	const agent = resolveAgentName(args, ["--agent"]);
	const inject = hasFlag(args, "--inject");
	const json = hasFlag(args, "--json");
	const debounceFlag = getFlag(args, "--debounce");

	refreshSessionHeartbeat(cwd, agent);

	// Parse debounce interval if provided
	let debounceMs: number | undefined;
	if (debounceFlag !== undefined) {
		const parsed = Number.parseInt(debounceFlag, 10);
		if (Number.isNaN(parsed) || parsed < 0) {
			throw new ValidationError(
				`--debounce must be a non-negative integer (milliseconds), got: ${debounceFlag}`,
				{ field: "debounce", value: debounceFlag },
			);
		}
		debounceMs = parsed;
	}

	// Check debounce if enabled
	if (debounceMs !== undefined) {
		const debounced = await isMailCheckDebounced(cwd, agent, debounceMs);
		if (debounced) {
			// Silent skip — no output when debounced
			return;
		}
	}

	const client = openClient(cwd);
	try {
		if (inject) {
			// Check for pending nudge markers (written by auto-nudge instead of tmux keys)
			const pendingNudge = await readAndClearPendingNudge(cwd, agent);
			const output = client.checkInject(agent);

			// Prepend a priority banner if there's a pending nudge
			if (pendingNudge) {
				const banner = `🚨 PRIORITY: ${pendingNudge.reason} message from ${pendingNudge.from} — "${pendingNudge.subject}"\n\n`;
				process.stdout.write(banner);
			}

			if (output.length > 0) {
				process.stdout.write(output);
			}
		} else {
			const messages = client.check(agent);

			if (json) {
				process.stdout.write(`${JSON.stringify(messages)}\n`);
			} else if (messages.length === 0) {
				process.stdout.write("No new messages.\n");
			} else {
				process.stdout.write(
					`📬 ${messages.length} new message${messages.length === 1 ? "" : "s"}:\n\n`,
				);
				for (const msg of messages) {
					process.stdout.write(`${formatMessage(msg)}\n\n`);
				}
			}
		}

		// Record this check for debounce tracking (only if debounce is enabled)
		if (debounceMs !== undefined) {
			await recordMailCheck(cwd, agent);
		}
	} finally {
		client.close();
	}
}

/**
 * Parse a non-negative integer flag value with validation.
 */
function parseNonNegativeIntFlag(args: string[], flag: string, defaultValue: number): number {
	const raw = getFlag(args, flag);
	if (raw === undefined) {
		return defaultValue;
	}
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed) || parsed < 0) {
		throw new ValidationError(`${flag} must be a non-negative integer, got: ${raw}`, {
			field: flag.replace(/^--/, ""),
			value: raw,
		});
	}
	return parsed;
}

/**
 * Parse a positive integer flag value with validation.
 */
function parsePositiveIntFlag(args: string[], flag: string, defaultValue: number): number {
	const raw = getFlag(args, flag);
	if (raw === undefined) {
		return defaultValue;
	}
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed) || parsed <= 0) {
		throw new ValidationError(`${flag} must be a positive integer, got: ${raw}`, {
			field: flag.replace(/^--/, ""),
			value: raw,
		});
	}
	return parsed;
}

/**
 * Parse a backoff factor flag value with validation.
 */
function parseBackoffFlag(args: string[], defaultValue: number): number {
	const raw = getFlag(args, "--backoff");
	if (raw === undefined) {
		return defaultValue;
	}
	const parsed = Number.parseFloat(raw);
	if (!Number.isFinite(parsed) || parsed < 1) {
		throw new ValidationError(`--backoff must be a number >= 1, got: ${raw}`, {
			field: "backoff",
			value: raw,
		});
	}
	return parsed;
}

/** overstory mail wait */
async function handleWait(args: string[], cwd: string): Promise<void> {
	const json = hasFlag(args, "--json");
	const agent = resolveAgentName(args, ["--agent"]);
	const timeoutMs = parseNonNegativeIntFlag(args, "--timeout", 300_000);
	const initialPollMs = parsePositiveIntFlag(args, "--poll", 250);
	const maxPollMs = parsePositiveIntFlag(args, "--max-poll", 5_000);
	const statusEveryMs = parsePositiveIntFlag(args, "--status-every", 5_000);
	const backoff = parseBackoffFlag(args, 1.5);

	if (maxPollMs < initialPollMs) {
		throw new ValidationError("--max-poll must be greater than or equal to --poll", {
			field: "max-poll",
			value: String(maxPollMs),
		});
	}

	let cancelled = false;
	const onCancel = (): void => {
		cancelled = true;
	};
	process.on("SIGINT", onCancel);
	process.on("SIGTERM", onCancel);

	const startedAt = Date.now();
	let nextStatusAt = startedAt;
	let pollMs = initialPollMs;

	const client = openClient(cwd);
	try {
		refreshSessionHeartbeat(cwd, agent);

		if (!json) {
			process.stdout.write(
				`⏳ Waiting for mail for "${agent}" (timeout=${timeoutMs}ms, poll=${initialPollMs}ms→${maxPollMs}ms, backoff=${backoff}x). Press Ctrl-C to cancel.\n`,
			);
		}

		while (true) {
			const elapsedMs = Date.now() - startedAt;
			if (cancelled) {
				if (json) {
					process.stdout.write(
						`${JSON.stringify({
							status: "cancelled",
							agent,
							waitedMs: elapsedMs,
							messageCount: 0,
						})}\n`,
					);
				} else {
					process.stdout.write(`🛑 Mail wait cancelled after ${elapsedMs}ms.\n`);
				}
				return;
			}

			const pendingNudge = await readAndClearPendingNudge(cwd, agent);
			const messages = client.check(agent);
			if (messages.length > 0 || pendingNudge !== null) {
				refreshSessionHeartbeat(cwd, agent);

				if (json) {
					process.stdout.write(
						`${JSON.stringify({
							status: "received",
							agent,
							waitedMs: Date.now() - startedAt,
							messageCount: messages.length,
							wake: pendingNudge,
							messages,
						})}\n`,
					);
				} else {
					process.stdout.write(`✅ Mail wait woke after ${Date.now() - startedAt}ms.\n`);
					if (pendingNudge) {
						process.stdout.write(
							`🚨 Wake nudge: ${pendingNudge.reason} from ${pendingNudge.from} — "${pendingNudge.subject}"\n`,
						);
					}
					if (messages.length === 0) {
						process.stdout.write("No unread messages were found after wake signal.\n");
					} else {
						process.stdout.write(
							`📬 ${messages.length} new message${messages.length === 1 ? "" : "s"}:\n\n`,
						);
						for (const msg of messages) {
							process.stdout.write(`${formatMessage(msg)}\n\n`);
						}
					}
				}
				return;
			}

			if (elapsedMs >= timeoutMs) {
				if (json) {
					process.stdout.write(
						`${JSON.stringify({
							status: "timeout",
							agent,
							waitedMs: elapsedMs,
							messageCount: 0,
						})}\n`,
					);
				} else {
					process.stdout.write(
						`⌛ Timed out waiting for mail for "${agent}" after ${elapsedMs}ms.\n`,
					);
				}
				return;
			}

			const now = Date.now();
			if (!json && now >= nextStatusAt) {
				const remainingMs = Math.max(timeoutMs - (now - startedAt), 0);
				process.stdout.write(
					`… still waiting (elapsed=${now - startedAt}ms, remaining=${remainingMs}ms, next-poll=${pollMs}ms)\n`,
				);
				nextStatusAt = now + statusEveryMs;
			}

			const remainingMs = Math.max(timeoutMs - (Date.now() - startedAt), 0);
			const sleepMs = Math.min(pollMs, remainingMs);
			if (sleepMs > 0) {
				await Bun.sleep(sleepMs);
			}
			refreshSessionHeartbeat(cwd, agent);
			pollMs = Math.min(maxPollMs, Math.max(1, Math.round(pollMs * backoff)));
		}
	} finally {
		client.close();
		process.off("SIGINT", onCancel);
		process.off("SIGTERM", onCancel);
	}
}

/** overstory mail list */
function handleList(args: string[], cwd: string): void {
	refreshSessionHeartbeat(cwd, resolveAgentName(args, []));

	const from = getFlag(args, "--from");
	// --agent is an alias for --to, providing agent-scoped perspective (like mail check)
	const to = getFlag(args, "--to") ?? getFlag(args, "--agent");
	const unread = hasFlag(args, "--unread") ? true : undefined;
	const json = hasFlag(args, "--json");

	const client = openClient(cwd);
	try {
		const messages = client.list({ from, to, unread });

		if (json) {
			process.stdout.write(`${JSON.stringify(messages)}\n`);
		} else if (messages.length === 0) {
			process.stdout.write("No messages found.\n");
		} else {
			for (const msg of messages) {
				process.stdout.write(`${formatMessage(msg)}\n\n`);
			}
			process.stdout.write(
				`Total: ${messages.length} message${messages.length === 1 ? "" : "s"}\n`,
			);
		}
	} finally {
		client.close();
	}
}

/** overstory mail read */
function handleRead(args: string[], cwd: string): void {
	refreshSessionHeartbeat(cwd, resolveAgentName(args, ["--agent"]));

	const positional = getPositionalArgs(args);
	const id = positional[0];
	if (!id) {
		throw new ValidationError("Message ID is required for mail read", { field: "id" });
	}

	const client = openClient(cwd);
	try {
		const { alreadyRead } = client.markRead(id);
		if (alreadyRead) {
			process.stdout.write(`Message ${id} was already read.\n`);
		} else {
			process.stdout.write(`Marked ${id} as read.\n`);
		}
	} finally {
		client.close();
	}
}

/** overstory mail reply */
function handleReply(args: string[], cwd: string): void {
	const positional = getPositionalArgs(args);
	const id = positional[0];
	const body = getFlag(args, "--body");
	const from = resolveAgentName(args, ["--agent", "--from"]);

	refreshSessionHeartbeat(cwd, from);

	if (!id) {
		throw new ValidationError("Message ID is required for mail reply", { field: "id" });
	}
	if (!body) {
		throw new ValidationError("--body is required for mail reply", { field: "body" });
	}

	const client = openClient(cwd);
	try {
		const replyId = client.reply(id, body, from);

		if (hasFlag(args, "--json")) {
			process.stdout.write(`${JSON.stringify({ id: replyId })}\n`);
		} else {
			process.stdout.write(`✉️  Reply sent: ${replyId}\n`);
		}
	} finally {
		client.close();
	}
}

/** overstory mail purge */
function handlePurge(args: string[], cwd: string): void {
	refreshSessionHeartbeat(cwd, resolveAgentName(args, []));

	const all = hasFlag(args, "--all");
	const daysStr = getFlag(args, "--days");
	const agent = getFlag(args, "--agent");
	const json = hasFlag(args, "--json");

	if (!all && daysStr === undefined && agent === undefined) {
		throw new ValidationError(
			"mail purge requires at least one filter: --all, --days <n>, or --agent <name>",
			{ field: "purge" },
		);
	}

	let olderThanMs: number | undefined;
	if (daysStr !== undefined) {
		const days = Number.parseInt(daysStr, 10);
		if (Number.isNaN(days) || days <= 0) {
			throw new ValidationError("--days must be a positive integer", {
				field: "days",
				value: daysStr,
			});
		}
		olderThanMs = days * 24 * 60 * 60 * 1000;
	}

	const store = openStore(cwd);
	try {
		const purged = store.purge({ all, olderThanMs, agent });

		if (json) {
			process.stdout.write(`${JSON.stringify({ purged })}\n`);
		} else {
			process.stdout.write(`Purged ${purged} message${purged === 1 ? "" : "s"}.\n`);
		}
	} finally {
		store.close();
	}
}

/**
 * Entry point for `overstory mail <subcommand> [args...]`.
 *
 * Subcommands: send, check, list, read, reply, purge.
 */
const MAIL_HELP = `overstory mail — Agent messaging system

Usage: overstory mail <subcommand> [args...]

Subcommands:
  send     Send a message
             --to <agent>  --subject <text>  --body <text>
             [--from <name>] [--agent <name> (alias for --from)]
             [--type <type>] [--priority <low|normal|high|urgent>]
             [--payload <json>] [--json]
           Types: status, question, result, error (semantic)
                  worker_done, merge_ready, merged, merge_failed,
                  escalation, health_check, dispatch, assign (protocol)
  check    Check inbox (unread messages)
             [--agent <name>] [--inject] [--json]
  wait     Wait for new messages with polling/backoff
             [--agent <name>] [--timeout <ms>] [--poll <ms>]
             [--max-poll <ms>] [--backoff <factor>] [--status-every <ms>] [--json]
  list     List messages with filters
             [--from <name>] [--to <name>] [--agent <name> (alias for --to)]
             [--unread] [--json]
  read     Mark a message as read
             <message-id>
  reply    Reply to a message
             <message-id> --body <text> [--from <name>]
             [--agent <name> (alias for --from)] [--json]
  purge    Delete old messages
             --all | --days <n> | --agent <name>
             [--json]

Options:
  --help, -h   Show this help`;

export async function mailCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${MAIL_HELP}\n`);
		return;
	}

	const subcommand = args[0];
	const subArgs = args.slice(1);

	// Resolve the actual project root (handles git worktrees).
	// Mail commands may run from agent worktrees via hooks, so we must
	// resolve up to the main project root where .overstory/mail.db lives.
	const root = await resolveProjectRoot(process.cwd());

	switch (subcommand) {
		case "send":
			await handleSend(subArgs, root);
			break;
		case "check":
			await handleCheck(subArgs, root);
			break;
		case "wait":
			await handleWait(subArgs, root);
			break;
		case "list":
			handleList(subArgs, root);
			break;
		case "read":
			handleRead(subArgs, root);
			break;
		case "reply":
			handleReply(subArgs, root);
			break;
		case "purge":
			handlePurge(subArgs, root);
			break;
		default:
			throw new MailError(
				`Unknown mail subcommand: ${subcommand ?? "(none)"}. Use: send, check, wait, list, read, reply, purge`,
			);
	}
}
