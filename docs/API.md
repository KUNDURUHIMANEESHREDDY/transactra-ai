# Control plane API

## Network posture

The control plane binds to loopback (127.0.0.1) by default. It requires a random CONTROL_PLANE_API_TOKEN of at least 32 characters for every /v1/* route. Approval decisions additionally require a separate CONTROL_PLANE_APPROVAL_TOKEN in the X-Transactra-Approval-Token header. Do not expose the service directly to the public internet. Public access must terminate TLS at a trusted reverse proxy and enforce rate limits, request limits and network policy.

## Bootstrap

1. Apply schema: npm run db:migrate.
2. Set TRANSACTRA_OWNER_SUBJECT to a stable, verified owner identity and run npm run db:bootstrap-owner.
3. Copy the emitted owner UUID into TRANSACTRA_OWNER_ID.
4. Generate two independent random secrets for the API and approval tokens; inject them through the deployment secret store.
5. Start the API with npm run dev:api for local development or npm run build followed by npm run start:api for compiled runtime.

## Endpoints

All /v1/* endpoints require Authorization: Bearer <CONTROL_PLANE_API_TOKEN>.

| Method | Path | Purpose |
|---|---|---|
| GET | /health/live | Process liveness only |
| GET | /health/ready | PostgreSQL schema readiness |
| POST | /v1/tasks | Enqueue an owner-scoped task with an idempotency key and required department |
| POST | /v1/telegram/tasks | Idempotent Telegram intake; atomically creates a task in `waiting_approval` plus a pending owner approval |
| GET | /v1/tasks | List owner tasks; optional limit 1–100 |
| GET | /v1/approvals | List pending owner approval requests |
| GET | /v1/tasks/:id | Read an owner-scoped task |
| GET | /v1/tasks/:id/events | Read task event history |
| POST | /v1/memory | Store provenance-tagged memory (credential-like content rejected) |
| POST | /v1/memory/search | Owner/project-scoped full-text memory search |
| DELETE | /v1/memory/:id | Delete an owner-scoped memory item |
| POST | /v1/approvals | Create an approval request bound to an action hash |
| POST | /v1/approvals/:id/decision | Approve/reject with the separate step-up credential |
| GET | /v1/organization | Organisation score, measured 30-day metrics, open incident counts, latest cycle, recent deployments and proposals |
| GET | /v1/organization/cycles | List organisation cycles; optional limit 1–100 |
| GET | /v1/organization/audits | List persisted health audits; optional limit 1–100 |
| GET | /v1/organization/evidence | Raw audit evidence: score, named metrics and snapshot |
| GET | /v1/agents | List the durable agent registry; `includeInactive=true` includes non-enabled agents |
| GET | /v1/incidents | List incidents; optional `status=open|acknowledged|resolved` and limit 1–100 |
| POST | /v1/incidents/:id/status | Set incident status to `open`, `acknowledged` or `resolved` |
| GET | /v1/notifications | List owner notifications; optional `status=queued|sent|failed` and limit 1–100 |
| POST | /v1/notifications/ack | Mark `local`-channel notifications as read by the owner; only queued local rows are affected |
| GET | /v1/reports | List intelligence reports; optional limit 1–100 |
| GET | /v1/reports/:id | Read one intelligence report |
| GET | /v1/opportunities | List scored opportunities; `eligible=true` returns only gate-eligible records, limit 1–100 |
| GET | /v1/projects | List innovation projects; optional limit 1–100 |
| GET | /v1/projects/:id | Read one innovation project |
| GET | /v1/deployments | List deployments; optional limit 1–100 |
| GET | /v1/deployments/:id | Read one deployment |
| GET | /v1/evolution/proposals | List self-evolution proposals; optional `status=proposed|validated|validation_failed|awaiting_approval|applied|rolled_back|rejected` and limit 1–100 |
| GET | /v1/evolution/proposals/:id | Read one proposal with its change set and validation result |
| POST | /v1/evolution/proposals/:id/validate | Enqueue one deterministic `evolution` task that sandbox-validates the change set |
| POST | /v1/evolution/proposals/:id/apply | Enqueue one deterministic `evolution` task that requests an approval and then applies the validated change set |
| POST | /v1/evolution/proposals/:id/rollback | Enqueue one deterministic `evolution` task that requests an approval and then re-dispatches the previous commit |
| GET | / (or /dashboard) | The embedded control centre. It requires `Authorization: Bearer <CONTROL_PLANE_API_TOKEN>` in the browser and is served with a per-request Content-Security-Policy nonce |

List endpoints accept `limit` (1–100) and reject out-of-range values with HTTP 400 instead of silently clamping. Read routes are owner-scoped: an identifier that exists for another owner returns 404.

### Evolution and deployment mutation semantics

Applying, rolling back and validating an evolution proposal are never performed by the API. The API enqueues one idempotent `evolution` task; the worker's tool gateway requests the owner approval, runs the sandbox validation and only then writes to the repository. The repository change is therefore always attributable to an approval record, and repeating the POST is idempotent (HTTP 201 on first enqueue, HTTP 200 afterwards). `POST /v1/tasks` accepts the `evolution` department alongside the existing departments.

Approval requests expire and decisions are one-time. The separate approval token is a bootstrap-level step-up control; it is not a substitute for a stronger interactive identity provider or hardware-backed MFA in a public deployment.

## Example task

POST /v1/tasks
Authorization: Bearer <token>
Content-Type: application/json

{
  "title": "Inspect service health",
  "objective": "Review current service health and report verified issues.",
  "department": "operations",
  "risk": "low",
  "idempotencyKey": "health-review-2026-11-08-001"
}

## Current limitations

The API persists and reads the organisation state (tasks, approvals, memory, agents, incidents, notifications, reports, opportunities, projects, deployments and evolution proposals), creates approval records and reports status. Every read and write it exposes has been exercised at the unit level, but none has been exercised against a live database on this machine: no PostgreSQL instance is available here, so the authenticated dashboard view and all `/v1` responses are still unverified at runtime. There is no authenticated user/session system yet — the bearer token is a bootstrap-level shared secret, and the approval token is a separate step-up control; in a public deployment these must be replaced by a real interactive identity provider with hardware-backed MFA, behind the TLS reverse proxy documented in [OPERATIONS.md](OPERATIONS.md). Task execution, repository writes, sandbox validation and channel delivery all require the worker runtime with its external credentials, which are documented in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).
