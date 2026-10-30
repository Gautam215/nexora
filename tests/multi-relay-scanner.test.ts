import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  getMalwareScanner,
  multiRelayScanner,
} from "../src/server/malware.ts";

// Multi-relay client tests (no database). Stub relays are plain
// HTTP: the production https-only rule is tested through
// configuration errors, not through a real TLS stack here.
// Rotation makes the starting relay alternate, so tests assert
// outcomes and hit counts over enough scans to be
// order-independent, never which relay a single scan started on.

const runtimeEnvironment = process.env as unknown as Record<string, string | undefined>;

const savedEnv: Record<string, string | undefined> = {};
for (const key of [
  "NEXORA_MALWARE_SCANNER",
  "NEXORA_CLAMAV_RELAY_URL",
  "NEXORA_CLAMAV_RELAY_TOKEN",
  "NEXORA_CLAMAV_RELAY_CA",
  "NEXORA_CLAMAV_RELAY_URL_2",
  "NEXORA_CLAMAV_RELAY_TOKEN_2",
  "NEXORA_CLAMAV_RELAY_CA_2",
  "NODE_ENV",
]) {
  savedEnv[key] = process.env[key];
}

function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  runtimeEnvironment.NODE_ENV = savedEnv.NODE_ENV;
}

interface StubRelay {
  server: ReturnType<typeof createServer>;
  url: string;
  hits: () => number;
}

async function startStubRelay(respond: () => { status: number; body: string }): Promise<StubRelay> {
  let hits = 0;
  const server = createServer((request, response) => {
    hits++;
    request.resume();
    request.on("end", () => {
      const { status, body } = respond();
      response.writeHead(status, { "content-type": "application/json", connection: "close" });
      response.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}`, hits: () => hits };
}

async function closeRelay(relay: StubRelay) {
  relay.server.closeAllConnections?.();
  await new Promise<void>((resolve) => relay.server.close(() => resolve()));
}

const cleanBody = JSON.stringify({ verdict: "clean" });
const infectedBody = JSON.stringify({ verdict: "infected" });

test("falls through to the second relay when the first is unavailable", async (t) => {
  const first = await startStubRelay(() => ({ status: 500, body: "{}" }));
  const second = await startStubRelay(() => ({ status: 200, body: cleanBody }));
  t.after(() => Promise.all([closeRelay(first), closeRelay(second)]));
  const scanner = multiRelayScanner([
    { origin: first.url, token: "token-1" },
    { origin: second.url, token: "token-2" },
  ]);
  const result = await scanner.scan(Buffer.from("hello"));
  assert.equal(result.outcome, "clean");
  assert.equal(second.hits(), 1);
});

test("returns infected from the first decisive relay without trying the second", async (t) => {
  const first = await startStubRelay(() => ({ status: 200, body: infectedBody }));
  const second = await startStubRelay(() => ({ status: 200, body: infectedBody }));
  t.after(() => Promise.all([closeRelay(first), closeRelay(second)]));
  const scanner = multiRelayScanner([
    { origin: first.url, token: "token-1" },
    { origin: second.url, token: "token-2" },
  ]);
  // Both relays agree (as synced signature databases do), so the
  // scan must stop at whichever relay it started on: one hit total.
  const result = await scanner.scan(Buffer.from("hello"));
  assert.equal(result.outcome, "infected");
  assert.equal(first.hits() + second.hits(), 1);
});

test("returns unavailable when every relay fails", async (t) => {
  const first = await startStubRelay(() => ({ status: 500, body: "{}" }));
  const second = await startStubRelay(() => ({ status: 500, body: "{}" }));
  t.after(() => Promise.all([closeRelay(first), closeRelay(second)]));
  const scanner = multiRelayScanner([
    { origin: first.url, token: "token-1" },
    { origin: second.url, token: "token-2" },
  ]);
  const result = await scanner.scan(Buffer.from("hello"));
  assert.equal(result.outcome, "unavailable");
});

test("ejects a repeatedly failing relay and readmits it after the window", async (t) => {
  const first = await startStubRelay(() => ({ status: 500, body: "{}" }));
  const second = await startStubRelay(() => ({ status: 200, body: cleanBody }));
  t.after(() => Promise.all([closeRelay(first), closeRelay(second)]));
  const scanner = multiRelayScanner(
    [
      { origin: first.url, token: "token-1" },
      { origin: second.url, token: "token-2" },
    ],
    { failureThreshold: 1, ejectMs: 80 },
  );
  // Four scans: rotation starts each relay twice, so the failing
  // relay is hit exactly once (its first failure ejects it) and
  // every scan still resolves clean through the second relay.
  for (let i = 0; i < 4; i++) {
    assert.equal((await scanner.scan(Buffer.from("hello"))).outcome, "clean");
  }
  assert.equal(first.hits(), 1);
  // After the ejection window, two more scans cover both rotation
  // starts, so the recovered relay is tried again exactly once.
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (let i = 0; i < 2; i++) {
    assert.equal((await scanner.scan(Buffer.from("hello"))).outcome, "clean");
  }
  assert.equal(first.hits(), 2);
});

test("skips a relay at its in-flight cap and uses the other relay", async (t) => {
  let releaseHang!: () => void;
  const hangGate = new Promise<void>((resolve) => {
    releaseHang = resolve;
  });
  let hangHits = 0;
  const hangServer = createServer((request, response) => {
    hangHits++;
    request.resume();
    void hangGate.then(() => {
      response.writeHead(200, { "content-type": "application/json", connection: "close" });
      response.end(cleanBody);
    });
  });
  await new Promise<void>((resolve) => hangServer.listen(0, "127.0.0.1", resolve));
  const hangAddress = hangServer.address();
  assert.ok(hangAddress && typeof hangAddress !== "string");
  const hangUrl = `http://127.0.0.1:${hangAddress.port}`;
  const clean = await startStubRelay(() => ({ status: 200, body: cleanBody }));
  t.after(async () => {
    releaseHang();
    hangServer.closeAllConnections?.();
    await new Promise<void>((resolve) => hangServer.close(() => resolve()));
    await closeRelay(clean);
  });
  const scanner = multiRelayScanner(
    [
      { origin: hangUrl, token: "token-1" },
      { origin: clean.url, token: "token-2" },
    ],
    { maxInFlightPerRelay: 1 },
  );
  // Launch scans until one is holding the hanging relay. Rotation
  // strictly alternates, so this takes at most two launches no
  // matter which relay the first scan started on; scans that hit
  // the clean relay resolve immediately and harmlessly.
  const pendings: Promise<{ outcome: string }>[] = [];
  for (let i = 0; i < 4 && hangHits === 0; i++) {
    pendings.push(scanner.scan(Buffer.from("hello")));
    for (let j = 0; j < 100 && hangHits === 0; j++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.equal(hangHits, 1);
  // The next scan must resolve clean while the first is still
  // hanging — either it started at the clean relay, or it skipped
  // the capped relay and fell through to it.
  const second = await scanner.scan(Buffer.from("hello"));
  assert.equal(second.outcome, "clean");
  releaseHang();
  for (const pending of pendings) {
    assert.equal((await pending).outcome, "clean");
  }
});

test("bounds the total scan time across hanging relays", async (t) => {
  const hang = createServer((request) => {
    request.resume();
    // Never responds.
  });
  await new Promise<void>((resolve) => hang.listen(0, "127.0.0.1", resolve));
  const hangAddress = hang.address();
  assert.ok(hangAddress && typeof hangAddress !== "string");
  const hangUrl = `http://127.0.0.1:${hangAddress.port}`;
  t.after(async () => {
    hang.closeAllConnections?.();
    await new Promise<void>((resolve) => hang.close(() => resolve()));
  });
  const scanner = multiRelayScanner(
    [
      { origin: hangUrl, token: "token-1" },
      { origin: hangUrl, token: "token-2" },
    ],
    { totalBudgetMs: 200 },
  );
  const started = Date.now();
  const result = await scanner.scan(Buffer.from("hello"));
  assert.equal(result.outcome, "unavailable");
  assert.ok(Date.now() - started < 5000, `scan took ${Date.now() - started}ms`);
});

test("wires both relays from the environment", async (t) => {
  const first = await startStubRelay(() => ({ status: 500, body: "{}" }));
  const second = await startStubRelay(() => ({ status: 200, body: cleanBody }));
  t.after(() => {
    restoreEnv();
    return Promise.all([closeRelay(first), closeRelay(second)]);
  });
  runtimeEnvironment.NODE_ENV = "test";
  process.env.NEXORA_MALWARE_SCANNER = "clamav-relay";
  process.env.NEXORA_CLAMAV_RELAY_URL = first.url;
  process.env.NEXORA_CLAMAV_RELAY_TOKEN = "token-1";
  delete process.env.NEXORA_CLAMAV_RELAY_CA;
  process.env.NEXORA_CLAMAV_RELAY_URL_2 = second.url;
  process.env.NEXORA_CLAMAV_RELAY_TOKEN_2 = "token-2";
  delete process.env.NEXORA_CLAMAV_RELAY_CA_2;
  const scanner = getMalwareScanner();
  assert.ok(scanner);
  assert.equal(scanner.name, "clamav-relay");
  assert.equal((await scanner.scan(Buffer.from("hello"))).outcome, "clean");
  assert.equal(second.hits(), 1);
});

test("rejects a second relay without its own token or with a malformed CA", async (t) => {
  t.after(() => restoreEnv());
  runtimeEnvironment.NODE_ENV = "test";
  process.env.NEXORA_MALWARE_SCANNER = "clamav-relay";
  process.env.NEXORA_CLAMAV_RELAY_URL = "http://127.0.0.1:9";
  process.env.NEXORA_CLAMAV_RELAY_TOKEN = "token-1";
  delete process.env.NEXORA_CLAMAV_RELAY_CA;
  process.env.NEXORA_CLAMAV_RELAY_URL_2 = "http://127.0.0.1:10";
  delete process.env.NEXORA_CLAMAV_RELAY_TOKEN_2;
  assert.throws(() => getMalwareScanner(), /NEXORA_CLAMAV_RELAY_TOKEN_2/);
  process.env.NEXORA_CLAMAV_RELAY_TOKEN_2 = "token-2";
  process.env.NEXORA_CLAMAV_RELAY_CA_2 = Buffer.from("not a certificate").toString("base64");
  assert.throws(() => getMalwareScanner(), /NEXORA_CLAMAV_RELAY_CA_2/);
});

test("rejects a plain-http second relay in production", async (t) => {
  t.after(() => restoreEnv());
  runtimeEnvironment.NODE_ENV = "production";
  process.env.NEXORA_MALWARE_SCANNER = "clamav-relay";
  process.env.NEXORA_CLAMAV_RELAY_URL = "https://127.0.0.1:9";
  process.env.NEXORA_CLAMAV_RELAY_TOKEN = "token-1";
  delete process.env.NEXORA_CLAMAV_RELAY_CA;
  process.env.NEXORA_CLAMAV_RELAY_URL_2 = "http://127.0.0.1:10";
  process.env.NEXORA_CLAMAV_RELAY_TOKEN_2 = "token-2";
  delete process.env.NEXORA_CLAMAV_RELAY_CA_2;
  assert.throws(() => getMalwareScanner(), /NEXORA_CLAMAV_RELAY_URL_2.*https/);
});
