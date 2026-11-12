import test from "node:test";
import assert from "node:assert/strict";
import { buildFinalReport } from "../src/final-report.mjs";

const accepted = (sequence_no, agent, tool, result_text) => ({
  sequence_no, agent, tool, status: "succeeded", result_text,
  evaluation_json: JSON.stringify({ decision: "accepted", accepted: true, rationale: "Acceptance criteria met by persisted evidence." }),
});

test("final report includes objective, per-agent evidence, evaluator rationale and source links", () => {
  const report = buildFinalReport({
    taskId: "tg-demo",
    objective: "Research and verify the release",
    steps: [accepted(1, "researcher", "web_research", "Found release notes https://example.com/release")],
  });
  assert.match(report, /COMPLETED/);
  assert.match(report, /researcher — web_research/);
  assert.match(report, /https:\/\/example.com\/release/);
  assert.match(report, /independent evaluator decision of accepted/);
});

test("final report refuses missing or non-accepted step evidence", () => {
  assert.throws(() => buildFinalReport({ taskId: "tg-demo", objective: "x", steps: [] }), /requires persisted/);
  assert.throws(() => buildFinalReport({
    taskId: "tg-demo", objective: "x",
    steps: [{ ...accepted(1, "builder", "none", "done"), evaluation_json: null }],
  }), /lacks accepted evaluator evidence/);
});
