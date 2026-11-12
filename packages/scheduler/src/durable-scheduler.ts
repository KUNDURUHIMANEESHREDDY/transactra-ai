import { Pool } from "pg";
import type { TaskDepartment } from "../../contracts/src/index.js";
import { PostgresTaskStore } from "../../storage/src/postgres.js";

interface ScheduleRow {
  id: string; owner_id: string; job_key: string; department: TaskDepartment;
  title: string; objective: string; interval_seconds: number;
  priority: number; next_run_at: Date;
}

export class DurableScheduler {
  readonly #pool: Pool;
  readonly #tasks: PostgresTaskStore;
  readonly #ownerId: string;
  readonly #pollMs: number;

  constructor(input: { connectionString: string; taskStore: PostgresTaskStore; ownerId: string; pollMs?: number }) {
    if (!input.connectionString.trim()) throw new Error("DATABASE_URL is required");
    if (!input.ownerId.trim()) throw new Error("ownerId is required");
    this.#pool = new Pool({ connectionString: input.connectionString, max: 2, application_name: "transactra-scheduler" });
    this.#tasks = input.taskStore;
    this.#ownerId = input.ownerId;
    this.#pollMs = input.pollMs ?? 5000;
    if (!Number.isInteger(this.#pollMs) || this.#pollMs < 500 || this.#pollMs > 60000) throw new Error("pollMs must be between 500 and 60000");
  }

  async close(): Promise<void> { await this.#pool.end(); }

  async ensureDefaultSchedules(): Promise<void> {
    await this.#pool.query(
      "INSERT INTO scheduled_jobs(owner_id,job_key,department,title,objective,interval_seconds,priority,next_run_at) VALUES ($1,'daily-intelligence','intelligence','Daily product intelligence','Discover current technology and product trends, competitor changes, underserved users, and evidence-backed product opportunities. Return source citations, confidence, and daily recommendations.',86400,20,now()),($1,'innovation-48h','innovation','48-hour innovation cycle','Run evidence-based opportunity discovery, score project candidates against the 90/100 quality gate, and prepare a new private project only when the threshold and zero-spend policy are satisfied.',172800,10,now()) ON CONFLICT(owner_id,job_key) DO NOTHING",
      [this.#ownerId]
    );
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.ensureDefaultSchedules();
    while (!signal.aborted) {
      const processed = await this.#enqueueOneDueJob();
      if (!processed) await this.#delay(this.#pollMs, signal);
    }
  }

  async #enqueueOneDueJob(): Promise<boolean> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<ScheduleRow>(
        "SELECT * FROM scheduled_jobs WHERE owner_id=$1 AND enabled=true AND next_run_at<=now() ORDER BY next_run_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED",
        [this.#ownerId]
      );
      const job = result.rows[0];
      if (!job) { await client.query("COMMIT"); return false; }
      const scheduledFor = job.next_run_at.toISOString();
      const idempotencyKey = "schedule:" + job.job_key + ":" + scheduledFor;
      await this.#tasks.enqueue({
        ownerId: this.#ownerId,
        title: job.title,
        objective: job.objective,
        department: job.department,
        risk: job.department === "innovation" ? "medium" : "low",
        priority: job.priority,
        idempotencyKey,
        requestedBy: { id: "system:scheduler", kind: "system" }
      });
      await client.query(
        "UPDATE scheduled_jobs SET next_run_at=CASE WHEN next_run_at+(interval_seconds * interval '1 second')<=now() THEN now()+(interval_seconds * interval '1 second') ELSE next_run_at+(interval_seconds * interval '1 second') END,last_enqueued_at=now(),updated_at=now() WHERE id=$1",
        [job.id]
      );
      await client.query("COMMIT");
      process.stdout.write(JSON.stringify({ event: "scheduled_task_enqueued", jobKey: job.job_key, department: job.department, scheduledFor }) + "\n");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async #delay(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done(): void { signal.removeEventListener("abort", abort); resolve(); }
      function abort(): void { clearTimeout(timer); done(); }
      signal.addEventListener("abort", abort, { once: true });
    });
  }
}
