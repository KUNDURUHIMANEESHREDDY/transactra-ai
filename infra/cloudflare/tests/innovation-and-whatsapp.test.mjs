import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isInnovationCycleDue,
  evaluateInnovationCandidate,
  runInnovationCycle,
  verifyCandidateEvidence,
  extractRegistrableDomain,
  normalizeUrl,
  isSafePublicUrl,
  claimSimilarity,
  extractClaimKeywords
} from "../src/innovation-pipeline.mjs";
import { handleWhatsAppVerification, handleWhatsAppWebhook } from "../src/whatsapp-handler.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../migrations");

function createTestD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const migrations = readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  for (const migration of migrations) {
    sqlite.exec(readFileSync(resolve(migrationsDir, migration), "utf8"));
  }

  const DB = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let values = [];
      const wrapped = {
        bind(...nextValues) {
          values = nextValues;
          return wrapped;
        },
        async run() {
          const result = statement.run(...values);
          return {
            success: true,
            meta: {
              changes: Number(result.changes),
              last_row_id: Number(result.lastInsertRowid || 0),
            },
          };
        },
        async first() {
          return statement.get(...values) ?? null;
        },
        async all() {
          return { results: statement.all(...values) };
        },
        _statement: statement,
        _values: () => values,
      };
      return wrapped;
    },
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((item) => {
          const result = item._statement.run(...item._values());
          return {
            success: true,
            meta: {
              changes: Number(result.changes),
              last_row_id: Number(result.lastInsertRowid || 0),
            },
          };
        });
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };

  return { DB, sqlite, close: () => sqlite.close() };
}

test("domain extractor: correctly extracts multi-label ccTLD registrable domains", () => {
  assert.equal(extractRegistrableDomain("api.service.co.uk"), "service.co.uk");
  assert.equal(extractRegistrableDomain("docs.developer.gov.in"), "developer.gov.in");
  assert.equal(extractRegistrableDomain("www.cloudflare.com"), "cloudflare.com");
  assert.equal(extractRegistrableDomain("sub.deepmind.google"), "deepmind.google");
  assert.equal(extractRegistrableDomain("worker.himaneesh.workers.dev"), "himaneesh.workers.dev");
  assert.equal(extractRegistrableDomain("invalid"), null);
});

test("url normalizer & SSRF protection: strictly rejects loopback, link-local and internal hosts", () => {
  assert.equal(isSafePublicUrl("http://localhost:8080/admin"), false);
  assert.equal(isSafePublicUrl("http://127.0.0.1/secrets"), false);
  assert.equal(isSafePublicUrl("http://169.254.169.254/latest/meta-data"), false);
  assert.equal(isSafePublicUrl("http://10.0.0.1/private"), false);
  assert.equal(isSafePublicUrl("http://192.168.1.1/router"), false);
  assert.equal(isSafePublicUrl("http://172.16.0.5/internal"), false);
  assert.equal(isSafePublicUrl("https://cloudflare.com/docs"), true);
  assert.equal(normalizeUrl("https://example.com:443/docs/#section"), "https://example.com/docs");
  assert.equal(normalizeUrl("http://127.0.0.1:80/path/"), null);
});

test("near-duplicate claim detection: identifies semantic overlap using Jaccard similarity", () => {
  const claim1 = "Cloudflare Workers support zero-cost edge execution with deterministic isolation";
  const claim2 = "Cloudflare Workers offer zero-cost edge execution with deterministic isolation guarantees";
  const claim3 = "Postgres connection pooling reduces database memory overhead";
  
  assert.ok(claimSimilarity(claim1, claim2) >= 0.70, "Near identical claims should have similarity >= 0.70");
  assert.ok(claimSimilarity(claim1, claim3) < 0.20, "Different topics should have low similarity");
});

test("evidence validator: rejects duplicate URLs and near-duplicate claims", async () => {
  const candidate = {
    title: "Duplicate URLs Candidate",
    quality_score: 95,
    cost_estimate_inr: 0,
    acceptance_criteria: [
      "Criterion 1: Concrete measurable behavior specification",
      "Criterion 2: Zero-cost sandbox execution with no leaks",
      "Criterion 3: Verified cleanup and rollback on failure"
    ],
    metrics: ["Metric 1: 99.9% uptime", "Metric 2: 0 ms delay"],
    evidence: [
      { url: "https://example.com/path#1", publisher: "Example A", claim: "Zero-cost edge execution with deterministic isolation", kind: "official" },
      { url: "https://example.com/path#2", publisher: "Example A", claim: "Zero-cost edge execution with deterministic isolation guarantees", kind: "official" },
      { url: "https://example.com/path/", publisher: "Example A", claim: "Zero-cost edge execution with deterministic isolation", kind: "official" }
    ]
  };

  const audit = await verifyCandidateEvidence(candidate);
  assert.equal(audit.valid, false, "Must fail because deduplication collapses to 1 URL");
  assert.equal(audit.uniqueCount, 1);
  assert.ok(audit.adjustedScore <= 84);
});

test("evidence validator: rejects candidate when evidence claims do not match retrieved content", async () => {
  const candidate = {
    title: "Unmatched Content Claims Project",
    quality_score: 95,
    cost_estimate_inr: 0,
    acceptance_criteria: [
      "Criterion 1: Concrete measurable behavior specification",
      "Criterion 2: Zero-cost sandbox execution with no leaks",
      "Criterion 3: Verified cleanup and rollback on failure"
    ],
    metrics: ["Metric 1: 99.9% uptime", "Metric 2: 0 ms delay"],
    evidence: [
      { url: "https://cloudflare.com/docs", publisher: "Cloudflare", claim: "Quantum teleportation cryptographic entanglement", kind: "official" },
      { url: "https://developer.nvidia.com/nim", publisher: "NVIDIA", claim: "Submarine geothermal propulsion energy", kind: "research" },
      { url: "https://github.com/blog", publisher: "GitHub", claim: "Interstellar atmospheric plasma generation", kind: "market_data" }
    ]
  };

  // Mock server returning ordinary web content that does not mention these fake claims
  const mockFetch = async () => new Response("Cloudflare edge computing and serverless worker documentation.", { status: 200 });

  const audit = await verifyCandidateEvidence(candidate, mockFetch);
  assert.equal(audit.valid, false);
  assert.equal(audit.claimMatchedSources, 0);
  assert.ok(audit.reasons.some(r => r.includes("substantively support their cited claims in retrieved content")));
});

test("evidence validator: rejects candidate when evidence sources are unreachable or return HTTP errors", async () => {
  const candidate = {
    title: "Unreachable Sources Project",
    quality_score: 95,
    cost_estimate_inr: 0,
    acceptance_criteria: [
      "Criterion 1: Concrete measurable behavior specification",
      "Criterion 2: Zero-cost sandbox execution with no leaks",
      "Criterion 3: Verified cleanup and rollback on failure"
    ],
    metrics: ["Metric 1: 99.9% uptime", "Metric 2: 0 ms delay"],
    evidence: [
      { url: "https://dead-server.example.org/one", publisher: "Pub One", claim: "Unique claim 1 with sufficient length", kind: "official" },
      { url: "https://offline-host.example.com/two", publisher: "Pub Two", claim: "Unique claim 2 with sufficient length", kind: "research" },
      { url: "https://unreachable.example.net/three", publisher: "Pub Three", claim: "Unique claim 3 with sufficient length", kind: "market_data" }
    ]
  };

  const mockFailingFetch = async () => {
    throw new Error("DNS resolution failed");
  };

  const audit = await verifyCandidateEvidence(candidate, mockFailingFetch);
  assert.equal(audit.valid, false);
  assert.equal(audit.reachableSources, 0);
  assert.ok(audit.reasons.some(r => r.includes("must be reachable")));
});

test("evidence validator: accepts fully evidenced, multi-domain, retrieved and claim-verified candidate", async () => {
  const candidate = {
    title: "Legitimate Verified Project",
    quality_score: 94,
    cost_estimate_inr: 0,
    acceptance_criteria: [
      "Criterion 1: Zero-cost edge execution in under 20ms",
      "Criterion 2: Persistent D1 state updates with strict FK integrity",
      "Criterion 3: Verified fail-closed recovery on network timeout"
    ],
    metrics: [
      "Metric 1: 100% deterministic reproducibility across tests",
      "Metric 2: INR 0.00 incurred per 10,000 requests"
    ],
    evidence: [
      { url: "https://cloudflare.com/workers", publisher: "Cloudflare", claim: "Workers edge runtime computing platform", kind: "official" },
      { url: "https://developer.nvidia.com/nim", publisher: "NVIDIA", claim: "NVIDIA inference microservices container platform", kind: "research" },
      { url: "https://github.blog/news", publisher: "GitHub", claim: "Automated verification workflows with security gates", kind: "news" }
    ]
  };

  const mockSuccessfulFetch = async (url) => {
    if (url.includes("cloudflare")) return new Response("Cloudflare Workers edge runtime computing platform for distributed apps", { status: 200 });
    if (url.includes("nvidia")) return new Response("NVIDIA inference microservices container platform for high-throughput AI", { status: 200 });
    return new Response("GitHub Actions automated verification workflows with security gates and compliance", { status: 200 });
  };

  const audit = await verifyCandidateEvidence(candidate, mockSuccessfulFetch);
  assert.equal(audit.valid, true);
  assert.equal(audit.adjustedScore, 94);
  assert.equal(audit.independentDomains, 3);
  assert.equal(audit.reachableSources, 3);
  assert.equal(audit.claimMatchedSources, 3);
  assert.equal(audit.reasons.length, 0);
});

test("actual end-to-end innovation pipeline: runInnovationCycle processes candidate through verification and creates approval-gated task", async () => {
  const { DB, sqlite, close } = createTestD1();
  try {
    const mockModelCandidate = {
      title: "Edge Cryptographic Audit Ledger",
      problem_statement: "Need autonomous zero-cost verification of cron runs.",
      solution: "Persist SHA-256 chain of state digests into local D1.",
      quality_score: 93,
      quality_rationale: "Zero-cost local D1 execution, multi-domain research backing.",
      acceptance_criteria: [
        "Criterion 1: Computes state digests in under 10ms",
        "Criterion 2: Persists audit block to D1 with foreign key integrity",
        "Criterion 3: Verified rollback if database write encounters lock"
      ],
      metrics: ["100% digest verification success", "INR 0.00 operational cost"],
      evidence: [
        { url: "https://developers.cloudflare.com/d1", publisher: "Cloudflare", claim: "Cloudflare D1 edge database transactions", kind: "official" },
        { url: "https://csrc.nist.gov/publications/fips-180", publisher: "NIST", claim: "Secure hash standard specification algorithms", kind: "research" },
        { url: "https://github.blog/engineering", publisher: "GitHub", claim: "Cryptographic commit attestation signatures", kind: "news" }
      ],
      cost_estimate_inr: 0,
      build_recommended: true
    };

    const mockFetch = async (url) => {
      if (url.includes("cloudflare")) return new Response("Cloudflare D1 edge database transactions and read replicas", { status: 200 });
      if (url.includes("nist")) return new Response("Secure hash standard specification algorithms including SHA-256", { status: 200 });
      return new Response("Cryptographic commit attestation signatures in Git and GitHub workflows", { status: 200 });
    };

    const env = {
      DB,
      TELEGRAM_OWNER_ID: "8593447241",
      TRANSACTRA_MODEL_ORCHESTRATOR_ENABLED: "true",
      NVIDIA_NIM_PLANNING_ENABLED: "true",
      NVIDIA_NIM_FREE_TIER_VERIFIED_AT: new Date().toISOString(),
      NVIDIA_NIM_ZERO_COST_LIMIT_INR: "0",
      NVIDIA_NIM_API_KEY: "nvapi-test-key",
      NVIDIA_NIM_MODEL: "stepfun-ai/step-5-preview",
      // Inject deterministic model output for complete end-to-end pipeline execution
      __mockNimOutput: JSON.stringify(mockModelCandidate)
    };

    const nowIso = new Date().toISOString();
    
    // Execute actual runInnovationCycle with our mock fetch
    const { candidate, createdTaskId } = await runInnovationCycle(env, nowIso, mockFetch);

    // Verify candidate was substantive-evidence checked
    assert.ok(candidate);
    assert.equal(candidate.cost_estimate_inr, 0);

    // Verify task state in database: strictly awaiting_provider (never automatically executing)
    assert.ok(createdTaskId, "Task should be created for verified score >= 90");
    const taskRow = sqlite.prepare("SELECT id, status, description FROM tasks WHERE id=?").get(createdTaskId);
    assert.ok(taskRow);
    assert.equal(taskRow.status, "awaiting_provider");
    assert.ok(taskRow.description.includes("Score 93/100"));

    const eventRow = sqlite.prepare("SELECT event_type, detail FROM task_events WHERE task_id=?").get(createdTaskId);
    assert.equal(eventRow.event_type, "task.innovation_proposed");
    assert.ok(eventRow.detail.includes('"score":93'));
  } finally {
    close();
  }
});

test("48-hour innovation cycle: detects due time correctly based on heartbeats", async () => {
  const { DB, close } = createTestD1();
  try {
    const nowMs = Date.now();
    assert.equal(await isInnovationCycleDue(DB, nowMs), true);

    const tenHoursAgo = new Date(nowMs - 10 * 3600 * 1000).toISOString();
    await DB.prepare("INSERT INTO runtime_heartbeats (id, scheduled_at) VALUES ('innovation-cycle', ?)").bind(tenHoursAgo).run();
    assert.equal(await isInnovationCycleDue(DB, nowMs), false);

    const fortyNineHoursAgo = new Date(nowMs - 49 * 3600 * 1000).toISOString();
    await DB.prepare("UPDATE runtime_heartbeats SET scheduled_at=? WHERE id='innovation-cycle'").bind(fortyNineHoursAgo).run();
    assert.equal(await isInnovationCycleDue(DB, nowMs), true);
  } finally {
    close();
  }
});

test("WhatsApp webhook: GET verification succeeds with valid verify_token and fails on invalid", async () => {
  const env = { WHATSAPP_VERIFY_TOKEN: "secure_wa_token_123" };

  const validUrl = new URL("https://edge.test/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=secure_wa_token_123&hub.challenge=test_challenge_code");
  const validRes = handleWhatsAppVerification(validUrl, env);
  assert.equal(validRes.status, 200);
  assert.equal(await validRes.text(), "test_challenge_code");

  const invalidUrl = new URL("https://edge.test/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong_token&hub.challenge=test_challenge_code");
  const invalidRes = handleWhatsAppVerification(invalidUrl, env);
  assert.equal(invalidRes.status, 403);
});

test("WhatsApp webhook: POST payload ingests messages into D1 inbound_events table", async () => {
  const { DB, sqlite, close } = createTestD1();
  try {
    const env = { DB };
    const payload = {
      object: "whatsapp_business_account",
      entry: [{
        id: "WHATSAPP_ID",
        changes: [{
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "1555000", phone_number_id: "12345" },
            messages: [{
              from: "919999999999",
              id: "wamid.HBgLMTE=",
              timestamp: "1700000000",
              text: { body: "Hello Transactra" },
              type: "text"
            }]
          },
          field: "messages"
        }]
      }]
    };

    const req = new Request("https://edge.test/whatsapp/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });

    const res = await handleWhatsAppWebhook(req, env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.ingested, 1);

    const eventRow = sqlite.prepare("SELECT source, source_event_id, event_type, payload_json FROM inbound_events WHERE source='whatsapp'").get();
    assert.ok(eventRow);
    assert.equal(eventRow.source, "whatsapp");
    assert.equal(eventRow.source_event_id, "wamid.HBgLMTE=");
    assert.equal(eventRow.event_type, "whatsapp.message");
    assert.ok(eventRow.payload_json.includes("Hello Transactra"));
  } finally {
    close();
  }
});
