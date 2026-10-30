import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";
import { createRelayServer } from "../relay/server.mjs";

// Relay unit tests (no database). A fake clamd speaks INSTREAM
// (zINSTREAM\0, then 4-byte-big-endian length + chunk, terminated
// by a zero length) and answers "stream: OK" or
// "stream: <name> FOUND" depending on the mode the test sets.

const RELAY_TOKEN = "relay-test-token";

function startFakeClamd(mode: () => "clean" | "infected", terminator = "\n") {
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let headerConsumed = false;
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!headerConsumed) {
        if (buffer.byteLength < 10) return;
        buffer = buffer.subarray(10);
        headerConsumed = true;
      }
      for (;;) {
        if (buffer.byteLength < 4) return;
        const length = buffer.readUInt32BE(0);
        if (buffer.byteLength < 4 + length) return;
        buffer = buffer.subarray(4 + length);
        if (length === 0) {
          socket.end(
            (mode() === "clean" ? "stream: OK" : "stream: Eicar-Test-Signature FOUND") + terminator,
          );
          return;
        }
      }
    });
  });
  return new Promise<{ server: ReturnType<typeof createServer>; port: number }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("fake clamd did not bind"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

async function startRelay(options: {
  clamdPort: number;
  maxBytes?: number;
  token?: string;
}) {
  const server = createRelayServer({
    token: options.token ?? RELAY_TOKEN,
    clamdHost: "127.0.0.1",
    clamdPort: options.clamdPort,
    maxBytes: options.maxBytes,
    log: () => {},
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function closeServers(...servers: { close: (callback?: (error?: Error) => void) => void; closeAllConnections?: () => void }[]) {
  for (const server of servers) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("relay scans clean and infected files, and enforces auth, size cap, and clamd failure", async (t) => {
  let mode: "clean" | "infected" = "clean";
  const clamd = await startFakeClamd(() => mode);
  const relay = await startRelay({ clamdPort: clamd.port });
  t.after(() => closeServers(relay.server, clamd.server));

  const post = (body: Uint8Array, token: string | null) =>
    fetch(`${relay.url}/scan`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        connection: "close",
      },
      body: new Uint8Array(body),
    });

  const clean = await post(Buffer.from("hello, world"), RELAY_TOKEN);
  assert.equal(clean.status, 200);
  assert.deepEqual(await clean.json(), { verdict: "clean" });

  mode = "infected";
  const infected = await post(Buffer.from("hello, world"), RELAY_TOKEN);
  assert.equal(infected.status, 200);
  assert.deepEqual(await infected.json(), { verdict: "infected" });

  const wrongToken = await post(Buffer.from("hello"), "wrong-token");
  assert.equal(wrongToken.status, 401);
  const noToken = await post(Buffer.from("hello"), null);
  assert.equal(noToken.status, 401);

  const health = await fetch(`${relay.url}/health`, { headers: { connection: "close" } });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const unknown = await fetch(`${relay.url}/nope`, { headers: { connection: "close" } });
  assert.equal(unknown.status, 404);
});

test("relay rejects oversized bodies and reports clamd failure as 502", async (t) => {
  const clamd = await startFakeClamd(() => "clean");
  const small = await startRelay({ clamdPort: clamd.port, maxBytes: 10 });
  t.after(() => closeServers(small.server, clamd.server));

  const big = await fetch(`${small.url}/scan`, {
    method: "POST",
    headers: { authorization: `Bearer ${RELAY_TOKEN}`, connection: "close" },
    body: Buffer.from("eleven bytes!"),
  });
  assert.equal(big.status, 413);

  // A relay pointed at a dead clamd must 502, never claim clean.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const deadPort = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const dead = await startRelay({ clamdPort: deadPort });
  t.after(() => closeServers(dead.server));
  const failed = await fetch(`${dead.url}/scan`, {
    method: "POST",
    headers: { authorization: `Bearer ${RELAY_TOKEN}`, connection: "close" },
    body: Buffer.from("hello"),
  });
  assert.equal(failed.status, 502);
});

test("relay refuses to start without a token", () => {
  assert.throws(() => createRelayServer({ token: "" }), /bearer token/);
});

test("relay parses null-terminated clamd replies with no newline", async (t) => {
  // Real clamd INSTREAM replies are null-terminated ("stream:
  // OK\0") with no newline; trim() does not strip \0, so a
  // parser that only trims turns every scan into "unavailable".
  // This test failed before the parser fix and passes after it.
  let mode: "clean" | "infected" = "clean";
  const clamd = await startFakeClamd(() => mode, "\0");
  const relay = await startRelay({ clamdPort: clamd.port });
  t.after(() => closeServers(relay.server, clamd.server));

  const post = (body: Uint8Array) =>
    fetch(`${relay.url}/scan`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        authorization: `Bearer ${RELAY_TOKEN}`,
        connection: "close",
      },
      body: new Uint8Array(body),
    });

  const clean = await post(Buffer.from("hello, world"));
  assert.equal(clean.status, 200);
  assert.deepEqual(await clean.json(), { verdict: "clean" });

  mode = "infected";
  const infected = await post(Buffer.from("hello, world"));
  assert.equal(infected.status, 200);
  assert.deepEqual(await infected.json(), { verdict: "infected" });
});
