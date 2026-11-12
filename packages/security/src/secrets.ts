const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|nvapi-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{24,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/,
  /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/
];

/** Conservative guard for common credential formats; never a substitute for secret scanning. */
export function assertNoLikelySecrets(value: string, context = "Persisted content"): void {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new Error(context + " appears to contain a credential or private key; persistence was refused");
  }
}
