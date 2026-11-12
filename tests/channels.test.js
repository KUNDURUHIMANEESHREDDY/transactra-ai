import test from "node:test";
import assert from "node:assert/strict";
import { allowsPlaintextControlPlane } from "../dist/packages/channels/src/control-surface.js";
import { TelegramControlBot } from "../dist/packages/channels/src/telegram-bot.js";

const TOKEN = ["123456789", "A".repeat(35)].join(":");

test("plaintext control-plane URLs are allowed only for hosts the internet cannot reach", () => {
  for (const host of ["localhost", "127.0.0.1", "127.0.0.10", "::1", "10.0.0.4", "192.168.1.20",
                     "172.16.0.9", "172.31.255.254", "169.254.1.1", "fd00::1", "api", "transactra", "db"]) {
    assert.equal(allowsPlaintextControlPlane(host), true, host + " should be allowed over plain HTTP");
  }
  for (const host of ["transactra.example.com", "example.com", "8.8.8.8", "1.1.1.1",
                     "169.255.1.1", "172.32.0.1", "11.0.0.1", "control-plane.appdeploy.ai"]) {
    assert.equal(allowsPlaintextControlPlane(host), false, host + " must require HTTPS");
  }
});

test("the control surface refuses a public hostname over plain HTTP and accepts a private one", () => {
  assert.throws(
    () => new (Object.getPrototypeOf(new TelegramControlBot({
      connectionString: "postgres://u:p@127.0.0.1:5432/transactra",
      botToken: TOKEN, allowedUserIds: ["1"],
      controlPlaneUrl: "http://transactra.example.com", apiToken: "a".repeat(40),
      approvalToken: "b".repeat(40), ownerId: "11111111-1111-4111-8111-111111111111"
    })).constructor)({}),
    /HTTPS/
  );
  // The same call with a single-label compose hostname is a valid deployment.
  const bot = new TelegramControlBot({
    connectionString: "postgres://u:p@127.0.0.1:5432/transactra",
    botToken: TOKEN, allowedUserIds: ["1"],
    controlPlaneUrl: "http://api:8787", apiToken: "a".repeat(40),
    approvalToken: "b".repeat(40), ownerId: "11111111-1111-4111-8111-111111111111"
  });
  assert.ok(bot);
  void bot.close?.();
});

test("production Telegram polling is disabled because the Cloudflare Worker owns delivery", async () => {
  const originalFetch = globalThis.fetch;
  let telegramApiCalled = false;
  globalThis.fetch = async () => {
    telegramApiCalled = true;
    throw new Error("Telegram API must not be called by the disabled poller");
  };
  const bot = new TelegramControlBot({
    connectionString: "postgres://u:p@127.0.0.1:5432/transactra",
    botToken: TOKEN, allowedUserIds: ["1"],
    controlPlaneUrl: "http://api:8787", apiToken: "a".repeat(40),
    approvalToken: "b".repeat(40), ownerId: "11111111-1111-4111-8111-111111111111"
  });
  try {
    await assert.rejects(
      bot.run(new AbortController().signal),
      /long polling is disabled.*transactra-edge/i
    );
    assert.equal(telegramApiCalled, false, "the disabled poller must not call Telegram");
  } finally {
    await bot.close?.();
    globalThis.fetch = originalFetch;
  }
});
