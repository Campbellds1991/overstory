# Contributor Checklist and PR Slicing Guide

Use this checklist before opening a PR. It is designed for Overstory’s architecture and command
ownership boundaries.

## 1) PR Slicing Guidance

Prefer one abstraction change per PR. Good slices:

1. Provider contract changes
   - `src/types.ts`, `src/config.ts`, `src/agents/manifest.ts`, docs
2. Hook behavior changes
   - `templates/hooks.json.tmpl`, `src/agents/hooks-deployer.ts`, related command consumers
3. Command orchestration changes
   - specific `src/commands/*.ts` plus affected adapters
4. Documentation-only changes
   - `docs/*`, `README.md`, `CONTRIBUTING.md`

Avoid mixed PRs that combine unrelated domains (for example, provider routing + merge resolver +
dashboard UI in one change).

## 2) Contributor Checklist

- [ ] Scope is clear and limited to one concern.
- [ ] Changed files match command/subsystem ownership boundaries.
- [ ] Safety guardrails are preserved (especially hook guards and path boundaries).
- [ ] User-facing docs are updated for any changed behavior.
- [ ] PR description explains what changed, why, and operational impact.

## 3) Acceptance-Criteria Template

Copy this into your PR description and fill it in:

```markdown
## Acceptance Criteria

### Behavior
- [ ] The targeted command(s) implement the described behavior.
- [ ] Existing command contracts remain backward compatible, or a migration note is included.

### Safety and Guardrails
- [ ] Hook/path-boundary protections remain intact (if applicable).
- [ ] No new unsafe defaults were introduced.

### Data and State
- [ ] Runtime state ownership is unchanged or intentionally migrated (sessions, events, metrics, mail).
- [ ] Migration steps are documented when state/config formats changed.

### Documentation
- [ ] Updated docs in `docs/*` and linked from `README.md` / `CONTRIBUTING.md` where relevant.
- [ ] Architecture/migration docs reflect new ownership or contracts.
```

## 4) Suggested PR Description Structure

1. Problem statement (one paragraph).
2. What changed (bulleted, by file area).
3. Why this design (tradeoffs, rejected alternatives).
4. Migration/rollout notes (if providers/hooks/state changed).
5. Acceptance criteria checklist (completed).
