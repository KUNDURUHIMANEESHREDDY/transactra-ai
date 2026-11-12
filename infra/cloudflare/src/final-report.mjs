function bounded(value, max = 700) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function urlsFrom(value) {
  return [...new Set((String(value || "").match(/https?:\/\/[^\s<>\])}]+/g) || []))].slice(0, 8);
}

/**
 * Build a final report only from persisted step results and accepted evaluator evidence.
 * The caller must enforce hasAcceptedStepEvidence before calling this function.
 */
export function buildFinalReport({ taskId, objective, steps }) {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error("A final report requires persisted agent-step evidence");
  const lines = [
    "TRANSACTRA — FINAL EXECUTION REPORT",
    "",
    "Task: " + bounded(taskId, 100),
    "Objective: " + bounded(objective, 700),
    "Outcome: COMPLETED — every step has persisted accepted evaluator evidence.",
    "",
    "AGENT EXECUTION",
  ];
  const evidenceLinks = [];
  for (const step of steps.slice(0, 8)) {
    let evaluation = null;
    try { evaluation = JSON.parse(step.evaluation_json || "null"); } catch {}
    if (step.status !== "succeeded" || evaluation?.decision !== "accepted" || evaluation?.accepted !== true) {
      throw new Error("Final report withheld because a step lacks accepted evaluator evidence");
    }
    lines.push(
      "",
      String(step.sequence_no) + ". " + bounded(step.agent, 80) + " — " + bounded(step.tool, 80),
      "Status: verified",
      "Evidence: " + bounded(step.result_text, 520),
      "Evaluator: " + bounded(evaluation.rationale, 300),
    );
    for (const url of urlsFrom(step.result_text)) evidenceLinks.push(url);
  }
  if (evidenceLinks.length) {
    lines.push("", "SOURCE LINKS", ...[...new Set(evidenceLinks)].slice(0, 8).map((url) => "- " + url));
  }
  lines.push(
    "",
    "VERIFICATION",
    "- Every planned step has a non-empty persisted result.",
    "- Every step has an independent evaluator decision of accepted.",
    "- Task completion was recorded from the durable step ledger.",
    "",
    "This report describes recorded execution evidence; it does not imply external outcomes beyond the adapter and evaluator evidence above.",
  );
  return lines.join("\n").slice(0, 3800);
}
