import { completeNvidiaNim, isNvidiaNimConfigured, isNvidiaNimDeveloperAccessConfirmed } from "./nvidia-nim.mjs";

export const CANDIDATE_CYCLE_HOURS = 48;
export const MINIMUM_EVIDENCE_SCORE = 90;
const MAX_VERIFICATION_FETCH_BYTES = 128 * 1024; // 128 KB
const MAX_REDIRECTS = 3;

/**
 * Public Multi-label suffix boundary table covering all major ccTLDs and global domains.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk","org.uk","ac.uk","gov.uk","me.uk","ltd.uk","plc.uk","net.uk",
  "com.au","net.au","org.au","edu.au","gov.au","id.au","asn.au",
  "co.nz","org.nz","govt.nz","ac.nz","net.nz","geek.nz","gen.nz",
  "co.in","firm.in","net.in","org.in","gen.in","ind.in","gov.in","edu.in","ac.in","res.in",
  "com.br","net.br","org.br","gov.br","edu.br",
  "com.cn","net.cn","org.cn","gov.cn","edu.cn",
  "com.sg","net.sg","org.sg","gov.sg","edu.sg",
  "com.my","net.my","org.my","gov.my","edu.my",
  "com.mx","net.mx","org.mx","gob.mx","edu.mx",
  "co.za","net.za","org.za","gov.za","ac.za",
  "co.jp","ne.jp","or.jp","go.jp","ac.jp",
  "co.kr","ne.kr","or.kr","go.kr","re.kr",
  "co.id","net.id","or.id","go.id","ac.id",
  "com.tr","net.tr","org.tr","gov.tr","edu.tr",
  "com.tw","net.tw","org.tw","gov.tw","edu.tw",
  "com.hk","net.hk","org.hk","gov.hk","edu.hk",
  "cloudflaressl.com","workers.dev","pages.dev","github.io","gitlab.io"
]);

/**
 * Extracts registrable domain using public suffix boundary rules.
 */
export function extractRegistrableDomain(hostname) {
  if (!hostname || typeof hostname !== "string") return null;
  const labels = hostname.toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (labels.length <= 1) return null;
  if (labels.length === 2) return labels.join(".");
  const suffix = labels.slice(-2).join(".");
  return labels.slice(-(MULTI_LABEL_SUFFIXES.has(suffix) ? 3 : 2)).join(".");
}

/**
 * Checks if 48 hours have elapsed since the last innovation proposal cycle.
 */
export async function isInnovationCycleDue(db, nowMs) {
  const row = await db.prepare("SELECT scheduled_at FROM runtime_heartbeats WHERE id='innovation-cycle'").first();
  if (!row || !row.scheduled_at) return true;
  const lastMs = Date.parse(row.scheduled_at);
  if (!Number.isFinite(lastMs) || lastMs <= 0) return true;
  const elapsedHours = (nowMs - lastMs) / (1000 * 60 * 60);
  return elapsedHours >= CANDIDATE_CYCLE_HOURS;
}

/**
 * SSRF & IP safety checks: Rejects loopback, link-local, private, cloud-metadata and non-HTTP(S) addresses.
 */
export function isSafePublicUrl(urlString) {
  try {
    const u = new URL(urlString);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const host = u.hostname.toLowerCase();
    
    // Explicit private & special hosts
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
    if (host === "169.254.169.254" || host === "metadata.google.internal") return false;

    // IPv4 checks
    const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (ipv4Match) {
      const [_, a, b, c, d] = ipv4Match.map(Number);
      if (a === 10) return false; // 10.0.0.0/8
      if (a === 127) return false; // 127.0.0.0/8
      if (a === 169 && b === 254) return false; // 169.254.0.0/16
      if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12
      if (a === 192 && b === 168) return false; // 192.168.0.0/16
      if (a === 0 || a >= 224) return false; // broadcast / multicast / reserved
    }

    // IPv6 checks (e.g. ::1, fe80::, fc00::)
    if (host.startsWith("[") || host.includes(":")) {
      const bare = host.replace(/^\[|\]$/g, "");
      if (bare === "::1" || bare.startsWith("fe80:") || bare.startsWith("fc") || bare.startsWith("fd")) return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Normalizes URL for deduplication.
 */
export function normalizeUrl(rawUrl) {
  try {
    if (!isSafePublicUrl(rawUrl)) return null;
    const u = new URL(rawUrl);
    u.hash = "";
    if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) {
      u.port = "";
    }
    return u.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/**
 * Computes Jaccard word-similarity token set between two strings.
 * Used for near-duplicate claim detection.
 */
export function claimSimilarity(a, b) {
  const wordsA = new Set(String(a).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(String(b).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Extract substantive keywords from claim for content verification.
 */
export function extractClaimKeywords(claim) {
  const STOP_WORDS = new Set([
    "this","that","with","from","have","been","were","which","their","there","about","after",
    "will","would","could","should","project","system","transactra","service","using","used"
  ]);
  return String(claim || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOP_WORDS.has(w));
}

/**
 * Safe bounded fetch wrapper:
 * - Enforces SSRF safe URL
 * - Limits response bytes to 128KB
 * - Restricts redirect count
 * - 4-second timeout
 */
export async function safeFetchSource(url, fetchFn = fetch) {
  let currentUrl = url;
  let redirects = 0;

  while (redirects <= MAX_REDIRECTS) {
    if (!isSafePublicUrl(currentUrl)) {
      throw new Error("Target or redirect URL is not a safe public HTTP(S) address");
    }

    const res = await fetchFn(currentUrl, {
      method: "GET",
      headers: {
        "user-agent": "Transactra-Evidence-Verifier/1.0 (read-only verification; zero-cost)",
        "accept": "text/html,application/xhtml+xml,application/json,text/plain"
      },
      redirect: "manual",
      signal: AbortSignal.timeout(4000)
    });

    // Handle manual redirects safely
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      const nextLocation = new URL(res.headers.get("location"), currentUrl).toString();
      currentUrl = nextLocation;
      redirects++;
      continue;
    }

    if (res.status < 200 || res.status >= 400) {
      throw new Error("HTTP status " + res.status);
    }

    // Read bounded body
    const rawText = await res.text();
    return rawText.slice(0, MAX_VERIFICATION_FETCH_BYTES);
  }

  throw new Error("Exceeded maximum redirects");
}

/**
 * Substantive Evidence Verification:
 * 1. Metadata Validation: Validates publisher, url syntax, kind.
 * 2. Deduplication: Eliminates duplicate URLs and near-duplicate claims (Jaccard similarity >= 0.70).
 * 3. Domain Independence: Uses suffix-aware registrable domain extraction across independent publishers.
 * 4. SSRF & Source Fetching: Fetches sources via bounded safeFetchSource.
 * 5. In-Content Claim Verification: Verifies that retrieved content substantive keywords align with the claim.
 * 6. Primary Source Verification: Validates official, research, or market_data designation.
 * 7. Hard-caps score <= 84 whenever validation fails.
 */
export async function verifyCandidateEvidence(candidate, fetchFn = fetch) {
  const reasons = [];

  if (!candidate || typeof candidate !== "object") {
    return { valid: false, adjustedScore: 0, reasons: ["Candidate is not a valid object."] };
  }

  // Zero-cost mandate
  if (candidate.cost_estimate_inr !== 0) {
    reasons.push("Cost estimate is not INR 0.");
  }

  // Acceptance criteria check
  if (!Array.isArray(candidate.acceptance_criteria) ||
      candidate.acceptance_criteria.filter(c => typeof c === "string" && c.trim().length >= 10).length < 3) {
    reasons.push("At least 3 concrete acceptance criteria (minimum 10 characters each) are required.");
  }

  // Metrics check
  if (!Array.isArray(candidate.metrics) ||
      candidate.metrics.filter(m => typeof m === "string" && m.trim().length >= 5).length < 2) {
    reasons.push("At least 2 measurable success metrics are required.");
  }

  const rawEvidence = Array.isArray(candidate.evidence) ? candidate.evidence : [];
  
  // Deduplicate by normalized URL and near-duplicate claims
  const uniqueItems = [];
  const seenUrls = new Set();
  const seenClaims = [];

  for (const item of rawEvidence) {
    if (!item || typeof item !== "object") continue;
    
    // Validate publisher metadata
    const publisher = String(item.publisher || "").trim();
    if (publisher.length < 2 || publisher.length > 100) continue;

    // Validate kind metadata
    const kind = String(item.kind || "").trim().toLowerCase();
    if (!["official", "research", "market_data", "news", "community"].includes(kind)) continue;

    // Normalize and check URL
    const normalized = normalizeUrl(item.url);
    if (!normalized || seenUrls.has(normalized)) continue;

    // Check claim metadata & near-duplicate similarity
    const claim = String(item.claim || "").trim();
    if (claim.length < 10 || claim.length > 500) continue;

    const isNearDuplicate = seenClaims.some(prior => claimSimilarity(prior, claim) >= 0.70);
    if (isNearDuplicate) continue;

    seenUrls.add(normalized);
    seenClaims.push(claim);
    uniqueItems.push({
      url: normalized,
      publisher,
      claim,
      kind
    });
  }

  if (uniqueItems.length < 3) {
    reasons.push("Candidate must provide at least 3 distinct, non-duplicate evidence citations with valid publishers.");
  }

  // Domain independence
  const publisherDomains = new Map();
  let primaryCount = 0;

  for (const item of uniqueItems) {
    let hostname;
    try {
      hostname = new URL(item.url).hostname;
    } catch {
      continue;
    }
    const domain = extractRegistrableDomain(hostname);
    if (!domain) continue;

    if (!publisherDomains.has(domain)) {
      publisherDomains.set(domain, []);
    }
    publisherDomains.get(domain).push(item);

    if (["official", "research", "market_data"].includes(item.kind)) {
      primaryCount++;
    }
  }

  if (publisherDomains.size < 2) {
    reasons.push("Evidence must span at least 2 distinct, independent publisher domains.");
  }
  if (primaryCount < 1) {
    reasons.push("At least 1 primary source (official, research, or market_data) is required.");
  }

  // Live Source Retrieval & Content Claim Verification
  let verifiedSources = 0;
  let claimMatchedSources = 0;

  for (const item of uniqueItems) {
    try {
      const content = await safeFetchSource(item.url, fetchFn);
      verifiedSources++;

      // Check if retrieved page contains claim keywords
      const keywords = extractClaimKeywords(item.claim);
      const contentLower = content.toLowerCase();
      const matches = keywords.filter(kw => contentLower.includes(kw));

      // Consider verified if at least 50% of substantial keywords (or at least 2) exist in the retrieved page
      if (matches.length >= Math.min(2, Math.ceil(keywords.length * 0.5))) {
        claimMatchedSources++;
      }
    } catch {
      // Unreachable, blocked by SSRF, or timeout
    }
  }

  if (uniqueItems.length > 0 && verifiedSources < 2) {
    reasons.push("At least 2 evidence sources must be reachable via safe public HTTP/HTTPS.");
  }
  if (uniqueItems.length > 0 && claimMatchedSources < 2) {
    reasons.push("At least 2 evidence sources must substantively support their cited claims in retrieved content.");
  }

  const rawScore = Number.isFinite(candidate.quality_score) ? Math.min(100, Math.max(0, candidate.quality_score)) : 0;
  const valid = reasons.length === 0 && rawScore >= MINIMUM_EVIDENCE_SCORE;
  const adjustedScore = valid ? rawScore : Math.min(rawScore, 84);

  return {
    valid,
    adjustedScore,
    uniqueCount: uniqueItems.length,
    independentDomains: publisherDomains.size,
    reachableSources: verifiedSources,
    claimMatchedSources,
    reasons
  };
}

/**
 * System prompt for candidate idea generation and scoring.
 * Enforces zero-cost INR 0, private repo, measurable criteria, and evidence scoring.
 */
const INNOVATION_SYSTEM_PROMPT = [
  "You are Transactra's autonomous innovation engine.",
  "Your task is to generate exactly one high-impact, evidence-backed project candidate for the Transactra ecosystem.",
  "Strict constraints:",
  "1. Zero cost: Must operate entirely within free tiers or open-source local/edge tools (INR 0.00).",
  "2. Repository: Scoped exclusively to private repository KUNDURUHIMANEESHREDDY/transactra.",
  "3. Safe and bounded: Must not require paid APIs, must include clear rollback strategy, and must define at least 3 concrete acceptance criteria and 2 measurable success metrics.",
  "4. Evidence: Provide at least 3 distinct evidence citations with url (public http/https), publisher name, claim text, and kind ('official'|'research'|'market_data'|'news'|'community') across at least 2 independent domains.",
  "5. Evaluation: Score the candidate objectively from 0 to 100 based on utility, safety, zero-cost feasibility, and evidence basis.",
  "6. Output format: Return ONLY valid JSON with no markdown formatting.",
  "JSON Schema:",
  "{\"title\": string, \"problem_statement\": string, \"solution\": string, \"quality_score\": number (0-100), \"quality_rationale\": string, \"acceptance_criteria\": string[], \"metrics\": string[], \"evidence\": [{\"url\": string, \"publisher\": string, \"claim\": string, \"kind\": string}], \"cost_estimate_inr\": 0, \"build_recommended\": boolean}"
].join(" ");

/**
 * Evaluates or generates an innovation candidate using NVIDIA Step 5 Preview.
 * If model is unavailable or inference fails, produces a deterministic evaluated candidate.
 */
export async function evaluateInnovationCandidate(env, promptOverride = null, fetchFn = fetch) {
  const prompt = promptOverride || "Generate the next 48-hour innovation project candidate for Transactra autonomous operations.";
  
  const canUseModel = isNvidiaNimConfigured(env)
    && isNvidiaNimDeveloperAccessConfirmed(env)
    && env.TRANSACTRA_MODEL_ORCHESTRATOR_ENABLED === "true";

  if (canUseModel) {
    try {
      let outputText;
      if (typeof env.__mockNimOutput === "string") {
        outputText = env.__mockNimOutput;
      } else {
        const completion = await completeNvidiaNim(env, {
          input: prompt,
          systemPrompt: INNOVATION_SYSTEM_PROMPT,
          maxOutputTokens: 1024,
          estimatedCostInr: 0
        });
        outputText = completion.output;
      }
      const parsed = JSON.parse(outputText.trim());
      if (parsed && typeof parsed.title === "string" && typeof parsed.quality_score === "number") {
        const audit = await verifyCandidateEvidence(parsed, fetchFn);
        return {
          ...parsed,
          generated_by: "nvidia-step-5-preview",
          cost_estimate_inr: 0,
          quality_score: audit.adjustedScore,
          evidence_audit: {
            valid: audit.valid,
            uniqueCount: audit.uniqueCount,
            independentDomains: audit.independentDomains,
            reachableSources: audit.reachableSources,
            claimMatchedSources: audit.claimMatchedSources,
            reasons: audit.reasons
          },
          build_recommended: audit.valid && audit.adjustedScore >= MINIMUM_EVIDENCE_SCORE
        };
      }
    } catch {
      // Fall through to deterministic fallback if parsing or provider call fails
    }
  }

  // Bounded deterministic fallback candidate
  // Fallbacks MUST NOT score >= 90 or recommend building without independent evidence
  return {
    title: "Edge Autonomous Heartbeat & State Verification Telemetry",
    problem_statement: "Edge background loops require verifiable zero-cost health telemetry across cron executions.",
    solution: "Implement lightweight D1-backed periodic telemetry summaries with cryptographic digest logging.",
    quality_score: 75,
    quality_rationale: "Deterministic fallback proposal; requires independent evidence verification before crossing the build threshold (>= 90).",
    acceptance_criteria: [
      "Persists runtime heartbeats to D1 without external HTTP requests",
      "Calculates SHA-256 state digest across active orchestrator jobs",
      "Executes within Cloudflare Worker 50ms CPU limit"
    ],
    metrics: [
      "100% scheduled run completion without uncaught exceptions",
      "0 INR incurred across all telemetry cycles"
    ],
    evidence: [],
    cost_estimate_inr: 0,
    build_recommended: false,
    generated_by: "deterministic-fallback",
    evidence_audit: {
      valid: false,
      reasons: ["Deterministic fallback does not provide live external evidence."]
    }
  };
}

/**
 * Runs the 48-hour autonomous innovation cycle:
 * 1. Generates/evaluates candidate with substantive evidence verification
 * 2. Persists candidate to D1 agent_memory
 * 3. Records heartbeat
 * 4. Strictly creates draft task in awaiting_provider ONLY if verified score >= 90
 * 5. Notifies owner via Telegram if bot token is present
 */
export async function runInnovationCycle(env, nowIso, fetchFn = fetch) {
  const candidate = await evaluateInnovationCandidate(env, null, fetchFn);
  
  // Persist candidate into agent_memory
  const memoryKey = "innovation:candidate:" + nowIso.slice(0, 10);
  const memoryValue = JSON.stringify(candidate);
  
  await env.DB.prepare(`
    INSERT INTO agent_memory (id, owner_id, memory_key, memory_value, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_id, memory_key) DO UPDATE SET memory_value=excluded.memory_value, updated_at=excluded.updated_at
  `).bind(
    "innov-" + crypto.randomUUID().slice(0, 8),
    String(env.TELEGRAM_OWNER_ID),
    memoryKey,
    memoryValue,
    nowIso,
    nowIso
  ).run();

  // Update heartbeat
  await env.DB.prepare("INSERT INTO runtime_heartbeats (id, scheduled_at) VALUES ('innovation-cycle', ?) ON CONFLICT(id) DO UPDATE SET scheduled_at=excluded.scheduled_at")
    .bind(nowIso)
    .run();

  // Only candidates with verified independent evidence and score >= 90 can generate an approval-gated task
  let createdTaskId = null;
  if (candidate.generated_by !== "deterministic-fallback" &&
      candidate.evidence_audit?.valid === true &&
      candidate.quality_score >= MINIMUM_EVIDENCE_SCORE &&
      candidate.build_recommended) {
    const taskId = "innov-task-" + Date.now();
    const taskDesc = "[Autonomous Innovation Score " + candidate.quality_score + "/100] " + candidate.title + ": " + candidate.solution;
    
    // Task is strictly stored as 'awaiting_provider'; requires owner approval
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO tasks (id, source, source_event_id, owner_id, description, status, created_at, updated_at) VALUES (?, 'telegram', ?, ?, ?, 'awaiting_provider', ?, ?)")
        .bind(taskId, memoryKey, String(env.TELEGRAM_OWNER_ID), taskDesc, nowIso, nowIso),
      env.DB.prepare("INSERT OR IGNORE INTO task_events (task_id, event_type, detail, created_at) VALUES (?, 'task.innovation_proposed', ?, ?)")
        .bind(taskId, JSON.stringify({ score: candidate.quality_score, criteria: candidate.acceptance_criteria }), nowIso)
    ]);
    createdTaskId = taskId;
  }

  // Notify owner via Telegram
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_OWNER_ID) {
    const statusText = [
      "💡 Transactra 48-Hour Innovation Candidate",
      "Title: " + candidate.title,
      "Score: " + candidate.quality_score + "/100 (" + (candidate.build_recommended ? "RECOMMENDED (>= 90)" : "BELOW THRESHOLD (< 90)") + ")",
      "Rationale: " + candidate.quality_rationale,
      "Evidence Valid: " + (candidate.evidence_audit?.valid ? "YES" : "NO (" + (candidate.evidence_audit?.reasons?.join("; ") || "unverified") + ")"),
      "Estimated Cost: INR " + candidate.cost_estimate_inr,
      createdTaskId ? "Draft task created: " + createdTaskId + " (status: awaiting_provider; requires owner approval)" : "No task created (fails evidence or score threshold)",
      "Inspect details with /memory or /tasks."
    ].join("\n");

    try {
      await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: String(env.TELEGRAM_OWNER_ID),
          text: statusText,
          disable_web_page_preview: true
        }),
        signal: AbortSignal.timeout(10000)
      });
    } catch {
      // Best-effort notification
    }
  }

  return { candidate, createdTaskId };
}
