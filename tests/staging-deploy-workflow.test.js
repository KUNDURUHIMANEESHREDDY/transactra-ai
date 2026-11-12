import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(resolve(ROOT, '.github', 'workflows', 'deploy-staging.yml'), 'utf8');

test('staging Telegram bot credentials are validated before remote D1 or Worker changes', () => {
  const preflightStart = workflow.indexOf('      - name: Validate staging Telegram bot credential before deployment');
  const preflightEnd = workflow.indexOf('      - name: Install locked dependencies', preflightStart + 1);
  const migration = workflow.indexOf('      - name: Apply migrations to staging D1 only');
  const deployment = workflow.indexOf('      - name: Deploy staging Worker only');

  assert.ok(preflightStart >= 0, 'credential preflight step must exist');
  assert.ok(preflightEnd > preflightStart, 'credential preflight must precede dependency installation');
  assert.ok(preflightStart < migration, 'Telegram credential validation must precede staging migrations');
  assert.ok(preflightStart < deployment, 'Telegram credential validation must precede Worker deployment');
  assert.ok(workflow.includes('TELEGRAM_STAGING_BOT_ID: ${{ vars.TELEGRAM_STAGING_BOT_ID }}'), 'the expected bot ID must come from the staging environment');
  assert.ok(workflow.includes('[long]::TryParse($env:TELEGRAM_STAGING_BOT_ID'), 'the configured bot ID must be validated as a positive integer');

  const preflight = workflow.slice(preflightStart, preflightEnd);
  assert.match(preflight, /\/getMe/, 'preflight must verify the token with Telegram');
  assert.match(preflight, /result\.is_bot/, 'preflight must reject a non-bot identity');
  assert.match(preflight, /HTTP \$status/, 'preflight must report a safe HTTP diagnostic');
  assert.match(preflight, /No staging migrations or Worker deployment were attempted/);
  assert.doesNotMatch(preflight, /Write-Host[^\r\n]*botToken/i, 'the bot token must never be logged');
  assert.match(preflight, /TELEGRAM_STAGING_BOT_ID/, 'preflight must compare against the explicitly configured staging bot');
  assert.match(preflight, /result\.id/, 'preflight must verify the expected bot ID');
  assert.match(preflight, /configured dedicated staging bot/);
});


test('staging bot ID runbook uses a hidden prompt and keeps the token out of command arguments', () => {
  const runbook = readFileSync(resolve(ROOT, 'infra', 'cloudflare', 'STAGING.md'), 'utf8');

  assert.match(runbook, /Read-Host "Dedicated staging bot token" -AsSecureString/);
  assert.match(runbook, /NetworkCredential/);
  assert.match(runbook, /TELEGRAM_STAGING_BOT_ID/);
  assert.match(runbook, /→ Variables/);
  assert.match(runbook, /TELEGRAM_WEBHOOK_SECRET/);
  assert.match(runbook, /→ Secrets/);
  assert.match(runbook, /do not set it to the production bot ID/i);
});
