import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { randomUUID } from "node:crypto";

export interface SandboxFileSet { [path: string]: string; }
export interface SandboxRunRequest {
  files: SandboxFileSet;
  command: readonly string[];
  timeoutMs?: number;
}
export interface SandboxRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  durationMs: number;
}
export interface DockerSandboxConfig {
  imageDigest: string;
  dockerBinary?: string;
  timeoutMs?: number;
  maxFiles?: number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
}

const IMAGE_DIGEST = /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/i;
const MAX_TIMEOUT_MS = 15 * 60 * 1000;

/** Return true only when Docker explicitly reports its rootless security option. */
export function isRootlessDockerSecurityOptions(output: string): boolean {
  let options: unknown;
  try {
    options = JSON.parse(output);
  } catch {
    return false;
  }
  return Array.isArray(options) && options.some((option) => option === "name=rootless");
}


export function validateSandboxFilePath(filePath: string): string[] {
  if (!filePath || filePath.length > 240 || filePath.includes("\0") || filePath.includes("\\")) {
    throw new Error("Sandbox file path is empty, too long, or contains an invalid character");
  }
  if (isAbsolute(filePath) || /^[a-z]:/i.test(filePath)) throw new Error("Sandbox file path must be relative");
  const parts = filePath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("Sandbox file path contains an unsafe path segment");
  return parts;
}

export function buildDockerRunArguments(
  imageDigest: string,
  workspacePath: string,
  cidFilePath: string,
  command: readonly string[]
): string[] {
  if (!IMAGE_DIGEST.test(imageDigest)) throw new Error("Sandbox image must be pinned to an immutable sha256 digest");
  if (!isAbsolute(workspacePath) || !isAbsolute(cidFilePath) || workspacePath.includes(",")) throw new Error("Sandbox workspace and cidfile paths must be absolute; workspace paths cannot contain commas");
  if (command.length < 1 || command.length > 64 || command.some((part) => !part || part.length > 4096 || part.includes("\0"))) {
    throw new Error("Sandbox command must contain 1 to 64 non-empty arguments");
  }
  return [
    "run", "--rm", "--pull=never", "--init",
    "--network=none", "--read-only", "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    "--pids-limit=128", "--memory=1g", "--memory-swap=1g", "--cpus=2",
    "--user=0:0", "--env", "HOME=/tmp",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m",
    "--label=transactra.sandbox=true",
    "--cidfile", cidFilePath,
    "--mount", "type=bind,src=" + workspacePath + ",dst=/workspace,readonly=false",
    "--workdir=/workspace",
    imageDigest,
    ...command
  ];
}

export function captureOutput(chunks: Buffer[], current: number, value: Buffer, limit: number): { size: number; truncated: boolean } {
  const remaining = Math.max(0,limit-current);
  if (remaining > 0) chunks.push(value.subarray(0,remaining));
  return { size: current + Math.min(value.length,remaining), truncated: value.length > remaining };
}

function execute(binary: string, args: string[], timeoutMs: number, outputLimit: number): Promise<SandboxRunResult> {
  return new Promise((resolvePromise,rejectPromise) => {
    const started = process.hrtime.bigint();
    const child = spawn(binary,args,{ stdio: ["ignore","pipe","pipe"], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let totalOutputSize = 0;
    let outputTruncated = false;
    let timedOut = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"),1500);
      forceTimer.unref();
    },timeoutMs);
    child.stdout.on("data",(chunk: Buffer) => {
      const result = captureOutput(stdout,totalOutputSize,chunk,outputLimit);
      totalOutputSize = result.size;
      outputTruncated ||= result.truncated;
    });
    child.stderr.on("data",(chunk: Buffer) => {
      const result = captureOutput(stderr,totalOutputSize,chunk,outputLimit);
      totalOutputSize = result.size;
      outputTruncated ||= result.truncated;
    });
    child.once("error",(error) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      rejectPromise(error);
    });
    child.once("close",(exitCode,signal) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      resolvePromise({
        exitCode, signal, timedOut,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        outputTruncated,
        durationMs: Number(process.hrtime.bigint()-started)/1_000_000
      });
    });
  });
}

async function requireRootlessDocker(binary: string): Promise<void> {
  let info: SandboxRunResult;
  try {
    info = await execute(binary, ["info", "--format", "{{json .SecurityOptions}}"], 10_000, 4096);
  } catch {
    throw new Error("Transactra sandbox requires a reachable rootless Docker daemon; Docker preflight failed");
  }
  if (
    info.exitCode !== 0 ||
    info.timedOut ||
    info.outputTruncated ||
    !isRootlessDockerSecurityOptions(info.stdout.trim())
  ) {
    throw new Error(
      "Transactra sandbox requires rootless Docker; refusing to run against an unavailable, rootful, or unrecognized daemon"
    );
  }
}

async function stopContainer(binary: string,cidFilePath: string): Promise<void> {
  const id = (await readFile(cidFilePath,"utf8").catch(() => "")).trim();
  if (!id || !/^[a-f0-9]{12,64}$/i.test(id)) return;
  for (const args of [["kill",id],["rm","-f",id]]) {
    await new Promise<void>((resolvePromise) => {
      const child = spawn(binary,args,{ stdio:"ignore",windowsHide:true });
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolvePromise(); },5000);
      child.once("error",() => { clearTimeout(timer); resolvePromise(); });
      child.once("close",() => { clearTimeout(timer); resolvePromise(); });
    });
  }
}

export class DockerSandboxRunner {
  readonly #config: Required<DockerSandboxConfig>;
  constructor(config: DockerSandboxConfig) {
    if (!IMAGE_DIGEST.test(config.imageDigest)) throw new Error("TRANSACTRA_SANDBOX_IMAGE must be pinned to an immutable sha256 digest");
    this.#config = {
      imageDigest: config.imageDigest,
      dockerBinary: config.dockerBinary ?? "docker",
      timeoutMs: config.timeoutMs ?? 120000,
      maxFiles: config.maxFiles ?? 500,
      maxInputBytes: config.maxInputBytes ?? 10 * 1024 * 1024,
      maxOutputBytes: config.maxOutputBytes ?? 1024 * 1024
    };
    if (!Number.isInteger(this.#config.timeoutMs) || this.#config.timeoutMs < 1000 || this.#config.timeoutMs > MAX_TIMEOUT_MS) throw new Error("Sandbox timeout must be between 1000 ms and 15 minutes");
    if (!Number.isInteger(this.#config.maxFiles) || this.#config.maxFiles < 1 || this.#config.maxFiles > 2000) throw new Error("Sandbox maxFiles must be between 1 and 2000");
    if (!Number.isSafeInteger(this.#config.maxInputBytes) || this.#config.maxInputBytes < 1 || this.#config.maxInputBytes > 50 * 1024 * 1024) throw new Error("Sandbox maxInputBytes must be between 1 byte and 50 MB");
    if (!Number.isSafeInteger(this.#config.maxOutputBytes) || this.#config.maxOutputBytes < 1024 || this.#config.maxOutputBytes > 10 * 1024 * 1024) throw new Error("Sandbox maxOutputBytes must be between 1 KB and 10 MB");
  }

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    if (!request.files || typeof request.files !== "object" || Array.isArray(request.files)) throw new Error("Sandbox files must be a path-to-content object");
    const entries = Object.entries(request.files);
    if (entries.length < 1 || entries.length > this.#config.maxFiles) throw new Error("Sandbox file count is outside the configured limit");
    let totalBytes = 0;
    for (const [filePath,content] of entries) {
      validateSandboxFilePath(filePath);
      if (typeof content !== "string") throw new Error("Sandbox file contents must be UTF-8 strings");
      totalBytes += Buffer.byteLength(content,"utf8");
      if (totalBytes > this.#config.maxInputBytes) throw new Error("Sandbox input exceeds the configured byte limit");
    }
    const timeoutMs = request.timeoutMs ?? this.#config.timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) throw new Error("Sandbox timeout must be between 1000 ms and 15 minutes");
    // Container UID 0 is mapped to the unprivileged daemon owner only in rootless Docker.
    // Refuse rootful or unknown daemon configurations before creating a workspace.
    await requireRootlessDocker(this.#config.dockerBinary);
    const workspace = await mkdtemp(join(tmpdir(),"transactra-sandbox-"));
    const cidFile = join(tmpdir(),"transactra-sandbox-" + randomUUID() + ".cid");
    try {
      await chmod(workspace,0o700);
      for (const [filePath,content] of entries) {
        const parts = validateSandboxFilePath(filePath);
        const target = resolve(workspace,...parts);
        const rel = relative(workspace,target);
        if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) throw new Error("Sandbox path escaped its workspace");
        const directory = join(target,"..");
        await mkdir(directory,{ recursive:true,mode:0o700 });
        await chmod(directory,0o700);
        await writeFile(target,content,{ encoding:"utf8",mode:0o644,flag:"wx" });
      }
      const args = buildDockerRunArguments(this.#config.imageDigest,workspace,cidFile,request.command);
      const result = await execute(this.#config.dockerBinary,args,timeoutMs,this.#config.maxOutputBytes);
      if (result.timedOut) await stopContainer(this.#config.dockerBinary,cidFile);
      return result;
    } finally {
      await rm(workspace,{ recursive:true,force:true });
      await rm(cidFile,{ force:true });
    }
  }
}
