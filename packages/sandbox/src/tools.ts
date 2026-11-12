import type { Action } from "../../policy/src/index.js";
import type { RiskLevel } from "../../contracts/src/index.js";
import type { ToolGateway } from "../../security/src/tool-gateway.js";
import type { SandboxRunResult } from "./docker-runner.js";
import { VERIFY_HARNESS_FILENAME, VERIFY_HARNESS_SOURCE, VERIFY_PRESET } from "./verify.js";

export interface SandboxExecutor {
  run(request: { files: Record<string, string>; command: readonly string[]; timeoutMs?: number }): Promise<SandboxRunResult>;
}

export interface SandboxPreset {
  readonly description: string;
  readonly command: readonly string[];
  readonly requiresHarness: boolean;
}

export const SANDBOX_PRESETS: Readonly<Record<string, SandboxPreset>> = Object.freeze({
  [VERIFY_PRESET]: {
    description: "TypeScript/JavaScript syntax and JSON parse verification of the supplied workspace",
    command: ["node", VERIFY_HARNESS_FILENAME],
    requiresHarness: true
  },
  "node-test": {
    description: "Node.js built-in test runner over the supplied workspace",
    command: ["node", "--test"],
    requiresHarness: false
  },
  "node-version": {
    description: "Sandbox image identity check",
    command: ["node", "--version"],
    requiresHarness: false
  }
});

export interface SandboxVerification {
  preset: string;
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

export function presetForFiles(preset: string, files: Record<string, string>): { files: Record<string, string>; command: readonly string[] } {
  const definition = SANDBOX_PRESETS[preset];
  if (!definition) throw new Error("Unknown sandbox preset: " + preset);
  if (!definition.requiresHarness) return { files, command: definition.command };
  if (Object.keys(files).length === 0) throw new Error("Sandbox verification requires at least one file");
  if (Object.keys(files).some((path) => path === VERIFY_HARNESS_FILENAME)) throw new Error("Sandbox verification harness path is reserved");
  return { files: { ...files, [VERIFY_HARNESS_FILENAME]: VERIFY_HARNESS_SOURCE }, command: definition.command };
}

export async function verifyWorkspace(executor: SandboxExecutor, input: { files: Record<string, string>; preset?: string; timeoutMs?: number }): Promise<SandboxVerification> {
  const preset = input.preset ?? VERIFY_PRESET;
  const prepared = presetForFiles(preset, input.files);
  const result = await executor.run({
    files: prepared.files,
    command: prepared.command,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {})
  });
  return {
    preset,
    passed: result.exitCode === 0 && !result.timedOut,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: Math.round(result.durationMs),
    stdout: result.stdout,
    stderr: result.stderr,
    outputTruncated: result.outputTruncated
  };
}

export function registerSandboxTools(gateway: ToolGateway, executor: SandboxExecutor): void {
  gateway.register<{ files: Record<string, string>; preset?: string; timeoutMs?: number }, SandboxVerification>({
    capability: "sandbox.verify",
    resource: (input) => "sandbox:" + (input.preset ?? VERIFY_PRESET),
    action: (): Action => ({ kind: "local_computation", estimatedCostInr: 0 }),
    risk: (): RiskLevel => "low",
    execute: (input) => verifyWorkspace(executor, input)
  });
}
