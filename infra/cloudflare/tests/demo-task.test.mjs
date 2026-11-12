import test from "node:test";
import assert from "node:assert/strict";
import { DEMO_TASK_PROMPT, isDemoTaskPrompt, buildDemoTaskEvents, runDemoTask } from "../src/demo-task.mjs";

test("demo trigger matches the selected task independent of case and punctuation", () => {
  assert.equal(isDemoTaskPrompt(DEMO_TASK_PROMPT), true);
  assert.equal(isDemoTaskPrompt("  RESEARCH THE LATEST DEVELOPMENTS IN ARTIFICIAL INTELLIGENCE; ANALYZE THE MOST IMPORTANT TRENDS, COMPARE THEIR BUSINESS IMPACT, AND PREPARE A CONCISE EXECUTIVE REPORT WITH RECOMMENDATIONS! "), true);
  assert.equal(isDemoTaskPrompt("Research the latest developments in robotics"), false);
});

test("demo event plan records each agent assignment, handoff and verification once", () => {
  const rows = buildDemoTaskEvents("demo-tg-123", DEMO_TASK_PROMPT, 100000);
  assert.equal(rows.length, 18);
  assert.equal(new Set(rows.map((row) => row.event_type)).size, rows.length);
  assert.ok(rows.some((row) => row.event_type === "demo.agent_assigned.research" && row.detail.includes("approved model catalogue")));
  assert.ok(rows.some((row) => row.event_type === "demo.handoff.writing_verification"));
  assert.ok(rows.some((row) => row.event_type === "demo.orchestrator_verified"));
  assert.ok(rows.every((row, index) => index === 0 || Date.parse(row.created_at) > Date.parse(rows[index - 1].created_at)));
});

test("demo task persists isolated demo task events and returns a disclosed scripted reply", async () => {
  const calls = [];
  const db = {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            run: async () => { calls.push({ sql, params }); return { success: true }; }
          };
        }
      };
    },
    batch: async (statements) => {
      for (const statement of statements) await statement.run();
      return [];
    }
  };
  const reply = await runDemoTask({ DB: db, TELEGRAM_OWNER_ID: "8593447241" }, { update_id: 123 }, DEMO_TASK_PROMPT);
  assert.equal(calls.length, 19);
  assert.ok(calls[0].sql.includes("INSERT OR IGNORE INTO tasks"));
  assert.equal(calls[0].params[0], "demo-tg-123");
  assert.equal(calls[0].params[1], "demo:123");
  assert.ok(calls.slice(1).every((call) => call.sql.includes("INSERT OR IGNORE INTO task_events")));
  assert.match(reply, /DEMO MODE — SCRIPTED EXECUTION/);
  assert.match(reply, /pending your approved model catalogue/);
  assert.match(reply, /No live research, model inference, or external action was performed/);
});
