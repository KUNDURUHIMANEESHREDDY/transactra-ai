export const APPROVAL_DECISION_HEADER = "x-transactra-approval-token";

export function createApprovalDecisionHeaders(token: string): Record<string,string> {
  if (!token.trim()) throw new Error("Approval token is required");
  return { [APPROVAL_DECISION_HEADER]: token };
}
