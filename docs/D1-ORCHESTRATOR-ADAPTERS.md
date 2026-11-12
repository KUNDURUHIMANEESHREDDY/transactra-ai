# D1-native autonomous workforce and tool adapters

## Runtime boundary

The production-facing Telegram Worker is intended to use the Cloudflare D1-native runtime. The Node packages remain the reference implementation for the specialist catalogue; the edge planner recognizes all ten exact Node catalogue IDs plus five edge-specialist roles and routes bounded steps through the D1 execution ledger. This is a role/capability integration, not a claim that a separate long-running Node service is currently deployed.

Planning and execution remain fail-closed. Model planning requires the configured NVIDIA NIM model, current Developer Program attestation and explicit runtime flags. Agent execution additionally requires the owner runtime switch and CloudPilot inference secret. A plan is a proposal until the owner approves it. Every high-risk or side-effect step requires a second, single-use approval bound to the exact serialized action hash.

## Specialist workforce

The D1 planner and runtime accept all ten exact Node catalogue IDs:

- `org-orchestrator`, `workforce-manager`
- `engineering-lead`, `software-engineer`, `quality-engineer`
- `product-researcher`, `innovation-architect`
- `site-reliability-engineer`, `security-officer`, `evolution-engineer`

Five edge-specialist roles extend the catalogue: `researcher`, `analyst`, `operator`, `verifier`, and `finance_officer`. Earlier underscore aliases (`engineering_lead`, `software` via `builder`, etc.) remain accepted for persisted-plan compatibility. A role-to-tool grant matrix is enforced both when validating a stored plan and again inside the agent runtime; for example, only the finance officer may prepare a payment challenge, and only engineering/evolution roles may write repository files.

The dispatcher validates the agent, tool grant, dependency graph, risk and action inputs again before execution.

## Registered integrations

### Read-only

- `web_research`: uses Tavily advanced search when `TAVILY_API_KEY` is configured; otherwise uses the fixed Wikimedia public-search endpoint and labels the reduced coverage explicitly. Results retain source URLs, excerpts and provider relevance scores where available.
- `github_issues_read`: lists issues from the fixed, installation-scoped Transactra repository. Pull requests are filtered from the issue list.
- `github_pr_read`: retrieves pull-request metadata and up to 30 changed-file summaries.
- `github_actions_read`: reads recent workflow runs, optionally for a validated workflow filename.
- `repository_read`: reads bounded UTF-8 source files from the fixed repository's `main` branch.
- `cloudflare_observe`: performs only fixed-path GET requests for Worker scripts, Queues and D1 database metadata. It requires a separate `CLOUDFLARE_READONLY_API_TOKEN`; it never reads secret values or changes resources.
- `sandbox_verify`: runs a bounded JavaScript snippet in a fresh Cloudflare Dynamic Worker. The Loader binding is `LOADER`; `globalOutbound: null` blocks network access, no credentials or bindings are passed, CPU is capped at 10 ms, subrequests at zero and wall time at five seconds. The result is a small verification check, not a general-purpose build server.
- `memory_search`: searches the authenticated owner's Mem0 memory and always includes the owner's durable D1 memory fallback. It never searches another user or tenant.
- `data_analysis`: deterministic analysis of prior persisted step evidence only.

### Owner-approved side effects

- `github_issue_create`: creates an issue in the fixed Transactra repository. The exact title/body/labels are included in the owner approval hash.
- `repository_write`: writes a bounded source file directly to `main` only after owner approval and an exact SHA preflight. Secrets, workflow files, Wrangler configuration and credential files remain excluded.
- `financial_policy_prepare`: calls the existing authenticated Node API `POST /api/payments/prepare`. It creates a transaction-bound approval challenge only; it does not create a PayPal order or move funds. The owner then uses `/pay-approve <approval-id>`, completes buyer authorization at PayPal, and only then uses `/pay-capture <order-id>`.
- `memory_write`: writes an owner-scoped key/value to D1 and queues a Mem0 sync event. It is restricted to engineering, product-research and innovation roles and always requires a separate owner step approval.
- `telegram_notify`: sends only to the configured owner chat.

The existing `cloudflare_staging` adapter remains restricted to the dedicated staging workflow and is not exposed as a general planner tool. Production deployment is never an autonomous tool.

## Durable dispatch, reports and recovery

- An owner-approved task or step writes its decision to D1 first, then sends an `orchestrator.dispatch` message to the Cloudflare Queue. The 15-minute Cron remains the reconciliation/recovery backstop.
- Queue delivery is at-least-once. D1 task/job leases, immutable action hashes and single-use approvals prevent concurrent execution and replay of external side effects.
- Agent step results and evaluator decisions are persisted in `orchestrator_step_runs`. A task is completed only when every planned step has a non-empty result and an accepted evaluator decision.
- The finalizer writes an evidence-backed report to `task_events` and the Telegram reply outbox. `/report <task-id>` retrieves the stored report.
- Telegram outbox delivery now uses a D1 lease token and lease expiry. Migration `0017_telegram_outbox_delivery_leases.sql` adds those fields. This prevents concurrent consumers from sending the same pending row at once. Telegram's sendMessage API has no idempotency key, so an ambiguous timeout after provider acceptance can still result in an at-least-once duplicate after lease expiry; the outbox is never silently marked sent before Telegram confirms success.

## Runtime configuration

Install secrets out of band; never put them in Wrangler TOML, source, task memory or logs.

| Worker secret | Purpose |
|---|---|
| `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY` | Short-lived, repository-scoped GitHub App installation tokens |
| `TAVILY_API_KEY` | Optional general web research; Wikimedia fallback remains available |
| `CLOUDFLARE_READONLY_API_TOKEN` | Optional account-scoped read-only Worker/Queue/D1 inspection |
| `TRANSACTRA_API_BASE_URL`, `BACKEND_SHARED_SECRET` | Optional authenticated connection to the existing Financial Policy API |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` | Telegram webhook and owner replies |
| `CLOUDPILOT_INFERENCE_SECRET`, `NVIDIA_NIM_API_KEY` | Inference providers; still subject to the independent zero-cost and owner-runtime gates |

The GitHub App installation must grant Contents read/write, Issues read/write, Pull requests read, and Actions read/write on only `KUNDURUHIMANEESHREDDY/transactra`. The adapter requests only the permission subset required for each operation. The staging workflow's short-lived token must be able to request the same scopes.

The financial API URL must be HTTPS. The backend shared secret must match the API's `BACKEND_SHARED_SECRET`, and its `TELEGRAM_OWNER_ID` must match the Telegram Worker owner. Until both are configured, payment preparation fails closed.

The Cloudflare account ID is a non-secret Worker variable. The read-only API token must be separately scoped to Workers Scripts Read, Queues Read and D1 Read. Do not reuse the deploy or migration token as a runtime credential.

## Deployment gates

1. Apply migrations 0001–0017 to the isolated staging D1 only (including model registry/task routing migration 0016 and Telegram outbox lease migration 0017).
2. Confirm the Cloudflare account supports Worker Loader/Dynamic Workers. Do not upgrade or add billing to satisfy this requirement.
3. Configure the dedicated staging bot and only staging credentials.
4. Update the GitHub App's repository permissions and verify the scoped token exchange.
5. Configure optional Tavily, Cloudflare read-only and financial API credentials as available.
6. Run the full CI, D1 migration tests, staging health/readiness checks, queue retry tests, outbox lease tests, tool adapter tests and Telegram acceptance suite.
7. Verify that staging inference remains disabled unless the exact zero-cost entitlement has been independently verified.
8. Only after all gates pass may an owner use the separately protected production workflow. A main-branch commit does not itself deploy production.

## Known limitations

- The code and tests are source-level until the staging deployment and live Telegram acceptance workflow succeeds.
- The Cloudflare account's current Worker inventory and runtime secret bindings must be rechecked before release. A source configuration is not proof that a production Worker is deployed or has the required secrets.
- The Dynamic Worker sandbox is deliberately tiny (10 ms CPU, zero subrequests). Use it for pure computation and syntax-level checks, not package installation, networked builds or arbitrary repository execution.
- The Node workforce catalogue is mirrored in the edge planner; no independent long-running Node worker host is claimed as deployed.
- Financial preparation requires a reachable, PostgreSQL-backed Node API. If the API is unavailable, payment tool execution fails closed; the edge Worker does not fall back to direct PayPal access.
