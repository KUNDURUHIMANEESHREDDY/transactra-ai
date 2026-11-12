export interface AgentPerformanceRow {
  agent_id: string;
  finalized_steps: string;
  completed_steps: string;
  failed_steps: string;
  approval_waits: string;
  open_attempts: string;
  avg_latency_ms: string | null;
}
export interface AgentPerformanceSummary {
  agentId: string;
  sampleSize: number;
  completedSteps: number;
  failedSteps: number;
  approvalWaits: number;
  openAttempts: number;
  successRate: number | null;
  averageSuccessfulLatencyMs: number | null;
  confidence: "low" | "medium" | "high";
}

function count(value: string,name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Invalid agent performance count: " + name);
  return parsed;
}

export function summarizeAgentPerformance(rows: readonly AgentPerformanceRow[]): AgentPerformanceSummary[] {
  return rows.map((row) => {
    if (!row.agent_id.trim()) throw new Error("Agent performance row requires an agent ID");
    const sampleSize = count(row.finalized_steps,"finalized_steps");
    const completedSteps = count(row.completed_steps,"completed_steps");
    const failedSteps = count(row.failed_steps,"failed_steps");
    const approvalWaits = count(row.approval_waits,"approval_waits");
    const openAttempts = count(row.open_attempts,"open_attempts");
    if (completedSteps + failedSteps !== sampleSize) throw new Error("Agent performance sample counts do not reconcile");
    const averageSuccessfulLatencyMs = row.avg_latency_ms === null ? null : Number(row.avg_latency_ms);
    if (averageSuccessfulLatencyMs !== null && (!Number.isFinite(averageSuccessfulLatencyMs) || averageSuccessfulLatencyMs < 0)) {
      throw new Error("Invalid average agent latency");
    }
    return {
      agentId:row.agent_id,
      sampleSize,
      completedSteps,
      failedSteps,
      approvalWaits,
      openAttempts,
      successRate:sampleSize === 0 ? null : Math.round((completedSteps/sampleSize)*1000)/10,
      averageSuccessfulLatencyMs,
      confidence:sampleSize >= 20 ? "high" : sampleSize >= 5 ? "medium" : "low"
    };
  });
}
