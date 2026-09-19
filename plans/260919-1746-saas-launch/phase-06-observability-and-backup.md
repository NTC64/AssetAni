# Phase 06 — Observability, backup, runbook

Depends on: 03. Blocks: 08.
Do not point a public domain at the service before this phase is done.

## Problem

Nothing reports state. If the worker dies, generations sit queued until a customer complains. If PixelLab starts failing or raises prices, the first signal is the bill. If the VPS disk fills or the database is lost, there is no recovery path — a single self-managed host with no backup is one incident away from losing every account, balance, and ledger row.

## Approach

### 6.1 Structured logs

Fastify uses Pino already. Make it consistent and safe:

- JSON in production, request id on every line.
- **Never log**: raw API keys, key hashes, `API_KEY_PEPPER`, Paddle secrets, provider tokens, full provider response bodies. `docs/api.md` already promises none of these are returned to clients; the same must hold for logs.
- Worker logs every state transition with generation id and duration.
- Ship to a log service or persist with rotation. Logs only inside a container are lost on redeploy.

### 6.2 Metrics that map to failure modes

Instrument what actually breaks:

| Metric                                 | Why                                                          |
| -------------------------------------- | ------------------------------------------------------------ |
| Queue depth and oldest job age         | Worker death or backlog, before customers notice.            |
| Generation duration percentiles        | Provider slowdown; feeds the reconciler threshold.           |
| Failure rate by `error_code`           | Separates provider faults from processing faults.            |
| QA FAIL / WARN rate                    | Output quality regression, including provider model changes. |
| Provider cost per generation           | Directly determines whether credit price is above cost.      |
| Reconciler actions (re-enqueue/refund) | Non-zero means the crash window is being hit for real.       |
| Refund count and reason                | Spike means systemic failure.                                |
| Credit balance vs ledger sum drift     | Must always be zero. Non-zero is a money bug.                |
| Signup-to-first-generation ratio       | Free-credit farming signal from Phase 04.                    |

### 6.3 Alerts

Alert only on things a human must act on, or alerts get ignored:

- API `/ready` failing.
- Worker heartbeat absent.
- Oldest queued job beyond a threshold.
- Failure rate above baseline over a window.
- Disk or memory above threshold.
- Any ledger-versus-balance drift — page immediately.
- Paddle reconciliation mismatch.

### 6.4 Backup and restore

- Nightly `pg_dump` to R2, encrypted, with generational retention.
- `API_KEY_PEPPER` backed up separately from the database. It is not in the dump, and without it every API key is unverifiable — restoring the database alone does not restore the service.
- R2 bucket versioning or lifecycle for result data, though results are expendable by design after Phase 01 retention.

**A backup that has never been restored is not a backup.** Restore into a scratch environment and confirm: users, balances, ledger, and that an existing API key still authenticates. Schedule this as a recurring drill, not a one-off.

### 6.5 Runbook

`docs/runbook.md`, written for the person on call at 2am, who may be the same person who wrote it six months ago:

- Worker down, queue backing up.
- Provider outage or auth failure.
- Customer says "I paid and got no credits" — check ledger, check Paddle, reconcile.
- Customer says "generation stuck" — check reconciler, check job state.
- Database restore, step by step, including the pepper.
- Key compromise: revoke, notify, rotate.
- Rollback to previous image tag.

## Files

- Create `docs/runbook.md`, `docs/observability.md`.
- Create `scripts/backup-database.mjs`, `scripts/restore-database.mjs`.
- Modify `apps/api/src/app.ts`, `apps/worker/src/worker.ts` — metrics and structured logging.
- Modify `infra/docker-compose.prod.yml` — log driver, backup scheduling.
- Modify `docs/deployment.md`.

## Validation

- Kill the worker; confirm an alert fires within the stated window.
- Stop Redis; confirm `/ready` returns 503 and alerts.
- Fill a disk in staging; confirm the alert precedes failure.
- Restore a backup into a scratch database; confirm balances, ledger, and that a pre-backup API key still authenticates.
- Deliberately introduce a ledger drift in staging; confirm it is detected.
- Grep logs for secret patterns after a full generation; expect zero hits.

## Risks

| Risk                                                    | Mitigation                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| Secrets leaked into logs                                | Explicit deny list, automated grep in CI against a captured log.   |
| Alert fatigue causing real alerts to be ignored         | Alert only on actionable conditions; review and prune monthly.     |
| Backup silently failing for weeks                       | Alert on backup age, not just on backup failure.                   |
| Restore procedure wrong and only discovered in a crisis | Scheduled restore drill.                                           |
| Observability stack cost exceeding hosting cost         | Start with self-hosted or free tier; metrics volume here is small. |

## Open questions

1. Self-host the monitoring stack on the same VPS (cheap, dies with the host) or use a hosted service (survives the host, costs money)? Hosted is the safer default for alerting, since an alert system that dies with the thing it monitors is not an alert system.
2. Uptime monitoring from outside the VPS — required, since internal checks cannot report that the host is down.

## Phase acceptance

- Worker death is detected and alerted without a customer reporting it.
- A database backup has been restored successfully and verified, at least once.
- Ledger-versus-balance drift is monitored and alerts.
- No secret appears in logs, verified by automated check.
- The runbook has been walked through by someone following it literally.
