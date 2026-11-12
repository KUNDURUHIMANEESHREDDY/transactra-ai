import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDockerRunArguments,
  captureOutput,
  isRootlessDockerSecurityOptions,
  validateSandboxFilePath
} from "../dist/packages/sandbox/src/docker-runner.js";

const image = "ghcr.io/transactra/sandbox@sha256:" + "a".repeat(64);

test("sandbox stdout and stderr share one aggregate output budget", () => {
  const stdout = [];
  const stderr = [];
  const first = captureOutput(stdout, 0, Buffer.from("123456"), 8);
  const second = captureOutput(stderr, first.size, Buffer.from("abcd"), 8);

  assert.equal(first.size, 6);
  assert.equal(second.size, 8);
  assert.equal(second.truncated, true);
  assert.equal(Buffer.concat(stdout).toString("utf8"), "123456");
  assert.equal(Buffer.concat(stderr).toString("utf8"), "ab");
});

test("Docker sandbox disables network and drops ambient privileges", () => {
  const args = buildDockerRunArguments(image,"/tmp/workspace","/tmp/sandbox.cid",["npm","test"]);
  assert.ok(args.includes("--network=none"));
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("--cap-drop=ALL"));
  assert.ok(args.includes("--security-opt=no-new-privileges:true"));
  assert.ok(args.includes("--pids-limit=128"));
  assert.ok(args.includes("--memory=1g"));
  assert.ok(args.includes("--memory-swap=1g"));
  assert.ok(args.includes("HOME=/tmp"));
  assert.ok(args.includes("--user=0:0"));
  assert.ok(args.includes("--cpus=2"));
  assert.ok(args.includes("--pull=never"));
  // Docker rejects the `-v` shorthand `rw` and the bare `readwrite` inside a --mount field list:
  // every field must be key=value. `readonly=false` is the explicit read-write form Docker accepts.
  assert.ok(args.includes("type=bind,src=/tmp/workspace,dst=/workspace,readonly=false"));
  assert.equal(args.includes("--privileged"),false);
});

test("rootless Docker is accepted only when the daemon explicitly reports it", () => {
  assert.equal(
    isRootlessDockerSecurityOptions(JSON.stringify(["name=seccomp,profile=builtin", "name=rootless"])),
    true
  );
  assert.equal(isRootlessDockerSecurityOptions(JSON.stringify(["name=seccomp,profile=builtin"])), false);
  assert.equal(isRootlessDockerSecurityOptions(JSON.stringify(["name=not-rootless"])), false);
  assert.equal(isRootlessDockerSecurityOptions("not-json"), false);
  assert.equal(isRootlessDockerSecurityOptions(JSON.stringify({ name: "rootless" })), false);
});

test("sandbox image must be pinned to an immutable digest", () => {
  assert.throws(
    () => buildDockerRunArguments("node:22","/tmp/workspace","/tmp/sandbox.cid",["node","--version"]),
    /immutable sha256 digest/
  );
});

test("sandbox file paths reject traversal and absolute paths", () => {
  assert.deepEqual(validateSandboxFilePath(".github/workflows/ci.yml"),[".github","workflows","ci.yml"]);
  assert.throws(() => validateSandboxFilePath("../escape.txt"),/unsafe path segment/);
  assert.throws(() => validateSandboxFilePath("src/../../escape.txt"),/unsafe path segment/);
  assert.throws(() => validateSandboxFilePath("/etc/passwd"),/must be relative/);
  assert.throws(() => validateSandboxFilePath("C:\\Windows\\system.ini"),/invalid character/);
});

test("sandbox command must be an explicit non-empty argument array", () => {
  assert.throws(() => buildDockerRunArguments(image,"/tmp/workspace","/tmp/sandbox.cid",[]),/1 to 64 non-empty arguments/);
  assert.throws(() => buildDockerRunArguments(image,"/tmp/workspace","/tmp/sandbox.cid",[""]),/1 to 64 non-empty arguments/);
});
