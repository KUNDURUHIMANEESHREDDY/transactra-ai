import test from "node:test";
import assert from "node:assert/strict";
import {
  APPROVAL_DECISION_HEADER,
  createApprovalDecisionHeaders
} from "../dist/packages/channels/src/control-plane-headers.js";

test("approval decisions use the control plane's exact approval header", () => {
  assert.equal(APPROVAL_DECISION_HEADER, "x-transactra-approval-token");
  assert.deepEqual(
    createApprovalDecisionHeaders("owner-approval-secret"),
    { "x-transactra-approval-token": "owner-approval-secret" }
  );
});

test("approval decision headers reject an empty token", () => {
  assert.throws(() => createApprovalDecisionHeaders("   "), /Approval token is required/);
});
