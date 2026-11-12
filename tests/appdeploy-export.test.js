import test from "node:test";
import assert from "node:assert/strict";
import { SOURCE_TABLES, verifyBundle } from "../infra/deploy/verify-appdeploy-export.mjs";

function fixture() {
  return {
    schemaVersion: 1,
    source: "appdeploy",
    exportedAt: "2026-11-09T04:30:00.000Z",
    tables: Object.fromEntries(SOURCE_TABLES.map((name) => [name, []])),
  };
}

test("accepts all seven tables and computes deterministic table hashes", () => {
  const bundle = fixture();
  bundle.tables.cp_tasks = [
    { id: "b", status: "queued", title: "Second" },
    { id: "a", title: "First", status: "done" },
  ];
  const first = verifyBundle(bundle);
  const reordered = fixture();
  reordered.tables.cp_tasks = [
    { status: "done", title: "First", id: "a" },
    { title: "Second", id: "b", status: "queued" },
  ];
  const second = verifyBundle(reordered);
  assert.equal(first.totalRecords, 2);
  assert.equal(first.tables.cp_tasks.recordCount, 2);
  assert.equal(first.tables.cp_tasks.sha256, second.tables.cp_tasks.sha256);
});

test("rejects a partial export", () => {
  const bundle = fixture();
  delete bundle.tables.cp_events;
  assert.throws(() => verifyBundle(bundle), /exactly these seven tables/);
});

test("rejects duplicate physical IDs", () => {
  const bundle = fixture();
  bundle.tables.cp_tasks = [{ id: "same" }, { id: "same" }];
  assert.throws(() => verifyBundle(bundle), /duplicate source id/);
});

test("rejects records without their source IDs", () => {
  const bundle = fixture();
  bundle.tables.cp_agents = [{ name: "Agent" }];
  assert.throws(() => verifyBundle(bundle), /physical source id/);
});

test("rejects secret-bearing fields at any nesting depth", () => {
  const bundle = fixture();
  bundle.tables.cp_state = [{ id: "state-1", settings: { telegramBotToken: "must-not-export" } }];
  assert.throws(() => verifyBundle(bundle), /Possible secret-bearing field/);
});

test("rejects private keys and client secrets", () => {
  for (const field of ["private_key", "clientSecret", "api_key", "webhook_secret"]) {
    const bundle = fixture();
    bundle.tables.cp_state = [{ id: "state-1", [field]: "must-not-export" }];
    assert.throws(() => verifyBundle(bundle), /Possible secret-bearing field/);
  }
});

test("does not reject non-secret token usage counters", () => {
  const bundle = fixture();
  bundle.tables.cp_events = [{ id: "event-1", tokenUsage: 1200, status: "complete" }];
  assert.equal(verifyBundle(bundle).totalRecords, 1);
});

test("rejects an unknown source schema", () => {
  const bundle = fixture();
  bundle.schemaVersion = 2;
  assert.throws(() => verifyBundle(bundle), /Unsupported export schemaVersion/);
});
