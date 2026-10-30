import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { after, test } from "node:test";
import { getMalwareScanner, MalwareConfigurationError, scanFileForUpload } from "../src/server/malware.ts";

// App-side relay scanner unit tests (no database). The stub relay
// is plain HTTP: the production https-only rule is tested through
// configuration errors, not through a real TLS stack here.

const RELAY_TOKEN = "scanner-test-token";

const previousScanner = process.env.NEXORA_MALWARE_SCANNER;
const previousRelayUrl = process.env.NEXORA_CLAMAV_RELAY_URL;
const previousRelayToken = process.env.NEXORA_CLAMAV_RELAY_TOKEN;
const previousRelayCa = process.env.NEXORA_CLAMAV_RELAY_CA;
const previousNodeEnv = process.env.NODE_ENV;
// NODE_ENV is read-only in the ProcessEnv type; the cast record
// is the same workaround the integration tests use.
const runtimeEnvironment = process.env as unknown as Record<string, string | undefined>;

after(() => {
  if (previousScanner === undefined) delete process.env.NEXORA_MALWARE_SCANNER;
  else process.env.NEXORA_MALWARE_SCANNER = previousScanner;
  if (previousRelayUrl === undefined) delete process.env.NEXORA_CLAMAV_RELAY_URL;
  else process.env.NEXORA_CLAMAV_RELAY_URL = previousRelayUrl;
  if (previousRelayToken === undefined) delete process.env.NEXORA_CLAMAV_RELAY_TOKEN;
  else process.env.NEXORA_CLAMAV_RELAY_TOKEN = previousRelayToken;
  if (previousRelayCa === undefined) delete process.env.NEXORA_CLAMAV_RELAY_CA;
  else process.env.NEXORA_CLAMAV_RELAY_CA = previousRelayCa;
  runtimeEnvironment.NODE_ENV = previousNodeEnv;
});

function setRelayEnv(url: string, token: string | undefined, ca?: string) {
  process.env.NEXORA_MALWARE_SCANNER = "clamav-relay";
  process.env.NEXORA_CLAMAV_RELAY_URL = url;
  if (token === undefined) delete process.env.NEXORA_CLAMAV_RELAY_TOKEN;
  else process.env.NEXORA_CLAMAV_RELAY_TOKEN = token;
  if (ca === undefined) delete process.env.NEXORA_CLAMAV_RELAY_CA;
  else process.env.NEXORA_CLAMAV_RELAY_CA = ca;
}

async function startStubRelay(respond: (request: import("node:http").IncomingMessage) => { status: number; body: string }) {
  const server = createServer((request, response) => {
    // Drain the body so the client never hangs on a full buffer.
    request.resume();
    request.on("end", () => {
      const { status, body } = respond(request);
      response.writeHead(status, { "content-type": "application/json", connection: "close" });
      response.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

test("relay scanner maps clean to clean and everything else to quarantined", async (t) => {
  let verdict: "clean" | "infected" = "clean";
  const stub = await startStubRelay(() => ({ status: 200, body: JSON.stringify({ verdict }) }));
  t.after(() => {
    stub.server.closeAllConnections();
    stub.server.close();
  });
  setRelayEnv(stub.url, RELAY_TOKEN);
  assert.equal(await scanFileForUpload(Buffer.from("hello")), "clean");
  verdict = "infected";
  assert.equal(await scanFileForUpload(Buffer.from("hello")), "quarantined");
});

test("relay scanner quarantines on relay errors, bad bodies, and unreachable relays", async (t) => {
  let behavior: "error-status" | "garbage" = "error-status";
  const stub = await startStubRelay(() =>
    behavior === "error-status" ? { status: 500, body: "{}" } : { status: 200, body: "not json" },
  );
  t.after(() => {
    stub.server.closeAllConnections();
    stub.server.close();
  });
  setRelayEnv(stub.url, RELAY_TOKEN);
  assert.equal(await scanFileForUpload(Buffer.from("hello")), "quarantined");
  behavior = "garbage";
  assert.equal(await scanFileForUpload(Buffer.from("hello")), "quarantined");

  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const deadPort = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  setRelayEnv(`http://127.0.0.1:${deadPort}`, RELAY_TOKEN);
  assert.equal(await scanFileForUpload(Buffer.from("hello")), "quarantined");
});

test("relay scanner configuration errors throw instead of silently going unscanned", async () => {
  const stub = await startStubRelay(() => ({ status: 200, body: JSON.stringify({ verdict: "clean" }) }));
  try {
    setRelayEnv(stub.url, undefined);
    await assert.rejects(scanFileForUpload(Buffer.from("hello")), MalwareConfigurationError);

    setRelayEnv("", RELAY_TOKEN);
    await assert.rejects(scanFileForUpload(Buffer.from("hello")), MalwareConfigurationError);

    setRelayEnv("not-a-url", RELAY_TOKEN);
    await assert.rejects(scanFileForUpload(Buffer.from("hello")), MalwareConfigurationError);

    // Plain http is refused in production, allowed elsewhere.
    setRelayEnv(stub.url, RELAY_TOKEN);
    runtimeEnvironment.NODE_ENV = "production";
    try {
      await assert.rejects(scanFileForUpload(Buffer.from("hello")), MalwareConfigurationError);
    } finally {
      runtimeEnvironment.NODE_ENV = "test";
    }

    // A malformed CA is refused; a well-formed PEM CA is accepted.
    setRelayEnv(stub.url, RELAY_TOKEN, Buffer.from("not a certificate").toString("base64"));
    await assert.rejects(scanFileForUpload(Buffer.from("hello")), MalwareConfigurationError);
    const pemCa = Buffer.from("-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----").toString("base64");
    setRelayEnv(stub.url, RELAY_TOKEN, pemCa);
    assert.ok(getMalwareScanner());
  } finally {
    stub.server.closeAllConnections();
    stub.server.close();
  }
});
