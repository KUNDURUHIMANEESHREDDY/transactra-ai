import test from "node:test";
import assert from "node:assert/strict";
import { ProviderRouter } from "../dist/packages/providers/src/router.js";

const request = { input: "test", maxOutputTokens: 20, estimatedCostInr: 0 };
function response(provider) {
  return { output: "ok", provider, model: "test-model" };
}
function fakeProvider(id,complete,zeroCostAuthorized = true) {
  return { id,zeroCostAuthorized,complete };
}

test("provider router rejects all positive-cost requests", async () => {
  const router = new ProviderRouter([fakeProvider("free",async () => response("free"))]);
  await assert.rejects(() => router.complete({ ...request,estimatedCostInr:0.01 }),/INR 0 ceiling/);
});

test("provider router refuses to run without an authorized no-cost provider", async () => {
  const router = new ProviderRouter([fakeProvider("paid",async () => response("paid"),false)]);
  await assert.rejects(() => router.complete(request),/No verified no-cost provider/);
});

test("provider router fails over to the next authorized no-cost provider", async () => {
  const router = new ProviderRouter([
    fakeProvider("primary",async () => { throw new Error("unavailable"); }),
    fakeProvider("backup",async () => response("backup"))
  ]);
  const result = await router.complete(request);
  assert.equal(result.provider,"backup");
});

test("provider circuit opens after repeated failures and skips the provider", async () => {
  let primaryCalls = 0;
  let backupCalls = 0;
  const router = new ProviderRouter([
    fakeProvider("primary",async () => { primaryCalls += 1; throw new Error("offline"); }),
    fakeProvider("backup",async () => { backupCalls += 1; return response("backup"); })
  ],{ failureThreshold:2,cooldownMs:1000,now:() => 1000 });
  await router.complete(request);
  await router.complete(request);
  await router.complete(request);
  assert.equal(primaryCalls,2);
  assert.equal(backupCalls,3);
  assert.equal(router.getCircuitStates()[0].state,"open");
});

test("provider circuit permits a half-open probe after cooldown and recovers", async () => {
  let now = 1000;
  let calls = 0;
  const router = new ProviderRouter([
    fakeProvider("nim",async () => {
      calls += 1;
      if (calls <= 2) throw new Error("temporary outage");
      return response("nim");
    })
  ],{ failureThreshold:2,cooldownMs:1000,now:() => now });
  await assert.rejects(() => router.complete(request),AggregateError);
  await assert.rejects(() => router.complete(request),AggregateError);
  assert.equal(router.getCircuitStates()[0].state,"open");
  now = 2001;
  const result = await router.complete(request);
  assert.equal(result.provider,"nim");
  assert.equal(router.getCircuitStates()[0].state,"closed");
  assert.equal(router.getCircuitStates()[0].consecutiveFailures,0);
});

test("only one half-open provider probe runs at a time", async () => {
  let now = 1000;
  let calls = 0;
  let releaseProbe;
  const router = new ProviderRouter([
    fakeProvider("nim",async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary outage");
      return await new Promise((resolve) => { releaseProbe = () => resolve(response("nim")); });
    })
  ],{ failureThreshold:1,cooldownMs:1000,now:() => now });
  await assert.rejects(() => router.complete(request),AggregateError);
  now = 2001;
  const probe = router.complete(request);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => router.complete(request),AggregateError);
  assert.equal(calls,2);
  releaseProbe?.();
  const result = await probe;
  assert.equal(result.provider,"nim");
  assert.equal(router.getCircuitStates()[0].state,"closed");
});

test("provider health events persist sanitized success and failure status", async () => {
  const events = [];
  let calls = 0;
  const router = new ProviderRouter([
    fakeProvider("nim",async () => {
      calls += 1;
      if (calls === 1) throw new Error("sensitive provider response details");
      return response("nim");
    })
  ],{ onHealth:async (event) => { events.push(event); } });
  await assert.rejects(() => router.complete(request),AggregateError);
  await router.complete(request);
  assert.equal(events.length,2);
  assert.equal(events[0].status,"degraded");
  assert.equal(events[0].failureReason,"provider_request_failed");
  assert.equal("sensitive provider response details".includes(events[0].failureReason),false);
  assert.equal(events[1].status,"healthy");
  assert.equal(events[1].model,"test-model");
});
