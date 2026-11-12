import test from "node:test";
import assert from "node:assert/strict";
import { authorizeAction } from "../dist/packages/policy/src/index.js";

test("zero-cost inference is permitted under the zero-spend ceiling", () => {
  const result = authorizeAction({ kind: "model_inference", estimatedCostInr: 0 }, "low");
  assert.equal(result.allowed, true);
  assert.equal(result.requiresApproval, false);
});
test("positive-cost inference is denied", () => {
  const result = authorizeAction({ kind: "model_inference", estimatedCostInr: 0.01 }, "low");
  assert.equal(result.allowed, false);
  assert.match(result.reason, /INR 0/);
});
test("invalid inference cost estimates fail closed", () => {
  for (const estimatedCostInr of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assert.equal(authorizeAction({ kind: "model_inference", estimatedCostInr }, "low").allowed, false);
  }
});
test("repository visibility changes require approval", () => {
  const result = authorizeAction({ kind: "repository_write", visibilityChange: true }, "low");
  assert.equal(result.allowed, true);
  assert.equal(result.requiresApproval, true);
});
test("unallowlisted external messages are denied", () => {
  assert.equal(authorizeAction({ kind: "external_message", recipientAllowlisted: false }, "low").allowed, false);
});
test("sensitive operations require approval", () => {
  for (const kind of ["production_deploy", "destructive_operation", "permission_change"]) {
    const result = authorizeAction({ kind }, "low");
    assert.equal(result.allowed, true);
    assert.equal(result.requiresApproval, true);
  }
});
test("high-risk work requires approval", () => {
  assert.equal(authorizeAction({ kind: "repository_read" }, "high").requiresApproval, true);
});

test("free basic web search is permitted at zero INR", () => {
  assert.equal(authorizeAction({ kind: "external_search", estimatedCostInr: 0 }, "low").allowed, true);
});
test("paid external search is denied by the zero-spend policy", () => {
  assert.equal(authorizeAction({ kind: "external_search", estimatedCostInr: 0.01 }, "low").allowed, false);
});

test("agent creation and permission changes are always approval-gated", () => {
  for (const kind of ["agent_creation", "permission_change", "system_change"]) {
    const result = authorizeAction({ kind }, "low");
    assert.equal(result.allowed, true);
    assert.equal(result.requiresApproval, true);
  }
});
