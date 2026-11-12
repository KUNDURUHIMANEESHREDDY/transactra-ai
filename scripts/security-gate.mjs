import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const rules = [
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g],
  ["Cloudflare API token assignment", /(?:CLOUDFLARE_API_TOKEN|CF_API_TOKEN)\s*[:=]\s*["']?[A-Za-z0-9_-]{30,}/gi],
  ["NVIDIA API key", /\bnvapi-[A-Za-z0-9_-]{20,}\b/g],
  ["Telegram bot token", /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["Private key material", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ["Generic secret assignment", /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|webhook[_-]?secret)\s*[:=]\s*["'][^"']{24,}["']/gi]
];

const textExtensions = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json", ".yml", ".yaml",
  ".toml", ".md", ".txt", ".sh", ".ps1", ".sql", ".env", ".example", ".xml", ".html"
]);
const findings = [];

for (const file of files) {
  if (file.startsWith(".git/") || file.includes("/node_modules/")) continue;
  let content;
  try {
    const buffer = readFileSync(file);
    if (buffer.includes(0)) continue;
    content = buffer.toString("utf8");
  } catch {
    continue;
  }
  const extension = extname(file).toLowerCase();
  if (extension && !textExtensions.has(extension) && !file.endsWith(".env.example")) continue;
  for (const [label, pattern] of rules) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) findings.push({ file, label });
  }
}

if (findings.length) {
  console.error("Potential credentials found in tracked files (values intentionally not printed):");
  for (const finding of findings) console.error(`- ${finding.file}: ${finding.label}`);
  process.exitCode = 1;
} else {
  console.log(`Secret scan passed: ${files.length} tracked files inspected; no credential patterns found.`);
}
