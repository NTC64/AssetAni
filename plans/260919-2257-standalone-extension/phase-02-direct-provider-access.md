# Phase 02 — Direct provider access

Depends on: nothing. Blocks: 03.

## Problem

The extension reaches PixelLab through three hops: `ApiClient` → Fastify → BullMQ → worker → provider. Every hop exists to serve a hosted model. With the user's own key in the editor, the extension can call PixelLab directly.

## What the key changes

`packages/ai/src/pixellab-provider.ts` already takes a token and an injectable `fetcher`, and is covered by 11 tests. It was written provider-agnostic enough to run anywhere Node runs. The extension main process is such a place — it already imports `undici`.

So this phase is mostly deletion and rewiring, not new provider code.

## Approach

### 2.1 Credential storage

`key-storage.ts` currently stores a `spr_live_…` key. It now stores a PixelLab token.

Decide and document explicitly:

- Where it is written. The current profile location is the natural choice.
- That it is never logged, never included in diagnostics, never sent anywhere except `api.pixellab.ai`.
- What the user sees: masked after entry, with a way to replace it.

This is the user's own paid credential. Losing or leaking it costs them money directly. `docs/phase-5.md` already warns that a compromised developer machine exposes a stored key; that warning now applies to a credential we do not control and cannot revoke.

### 2.2 Validate the key on entry

Call a cheap PixelLab endpoint when the user saves the key, and report plainly whether it works. Without this, an invalid key surfaces as a failed generation minutes later, and the user cannot tell whether the problem is the key, the prompt, or the tool.

If PixelLab exposes remaining quota, show it. A user about to spend their own quota should see what they have.

### 2.3 Progress without polling

Today the panel polls the backend at 2/4/8 seconds because status lives in PostgreSQL. Now the main process owns the operation in memory and already maintains a snapshot the panel reads.

`pollJob` inside the provider still polls PixelLab — that is PixelLab's own async job API and stays. What goes is the second polling layer between panel and backend.

Keep the operation in the main process so closing the panel does not cancel work. That property is already true and worth preserving.

### 2.4 Errors become the user's problem, honestly

With no credits, there is no refund. A failed generation spends the user's PixelLab quota. Two consequences:

- Error messages must distinguish "your key is wrong", "PixelLab is down", "your quota is exhausted", and "the output failed quality checks". The current sanitised messages exist to avoid leaking server internals to untrusted clients — that constraint is gone, and detail is now helpful rather than dangerous.
- The billing-aware retry rule fixed on 2026-09-19 matters more, not less: a retry after job acceptance now spends the _user's_ money.

### 2.5 Drop fal.ai

Delete `fal-provider.ts` and `pose-guide.ts` (used only by fal). `AIOrchestrator` loses its concept-provider fallback and collapses to a thin wrapper over one provider — consider whether it still earns its existence or should fold into the provider.

## Files

- Modify `apps/cocos-plugin/src/main/key-storage.ts` — PixelLab token.
- Delete `apps/cocos-plugin/src/main/api-client.ts` (Phase 04).
- Modify `apps/cocos-plugin/src/panel/index.ts` — token entry and validation; remove backend URL.
- Modify `apps/cocos-plugin/package.json` — depend on `@sprite/ai`.
- Modify `packages/ai/src/orchestrator.ts` — remove fal paths.
- Modify `packages/ai/src/index.ts` — stop exporting fal and pose-guide.

## Validation

1. A valid token is accepted and reported as working; an invalid one is rejected immediately with a clear reason.
2. The token never appears in logs, snapshots, or error text — assert this, do not assume it.
3. No request goes anywhere except `api.pixellab.ai`.
4. The four failure classes produce four distinguishable messages.
5. Existing `tests/pixellab-provider.test.ts` passes unmodified.
6. Manual in Creator 3.8: enter a key, see it validated, close and reopen the editor, confirm it persists.

## Risks

| Risk                                                        | Mitigation                                                                   |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| User's paid key leaked through logs or diagnostics          | Explicit assertion in tests; single storage location.                        |
| Silent quota exhaustion mid-batch                           | Validate on entry; surface quota when available; stop batch on quota errors. |
| Orchestrator left as an empty indirection after fal is gone | Decide deliberately whether to keep or inline it.                            |
| Editor UI blocked during a multi-minute call                | Work stays in the main process, as today.                                    |

## Phase acceptance

- The extension talks to PixelLab with the user's key and nothing else.
- Key validity is known at entry, not at first failure.
- fal.ai is fully removed from the code path.
- Failures are explained in terms the user can act on.
