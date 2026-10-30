// Nexora ClamAV relay — a tiny HTTPS front door for a local clamd.
//
// WHY THIS EXISTS: Vercel functions cannot reach a clamd daemon over
// private networking, and clamd's own protocol is plain TCP with no
// TLS and no authentication — it must never be exposed to the
// internet. So the daemon stays on loopback (127.0.0.1:3310) and
// this relay is the only public surface: it authenticates every
// scan request with a bearer token, enforces a body cap, forwards
// the bytes to clamd over INSTREAM, and returns only a verdict.
//
// SECURITY MODEL (read before deploying):
// - clamd binds loopback ONLY. The host firewall must keep 3310
//   closed; only the relay port (default 8443) is public.
// - Every POST /scan requires `Authorization: Bearer <token>`,
//   compared with timingSafeEqual. No token, no scan.
// - The relay never returns a signature name — only
//   "clean" / "infected". Signatures stay in clamd's own logs.
// - TLS: pass --tls-cert/--tls-key (or RELAY_TLS_CERT/
//   RELAY_TLS_KEY) with a certificate for the relay. Without a
//   domain, generate a private CA + server cert with openssl
//   (see relay/README.md) and pin that CA in the app via
//   NEXORA_CLAMAV_RELAY_CA. Running without TLS is for local
//   tests only: the app refuses plain-http relay URLs in
//   production.
// - Body cap: requests larger than maxBytes (default 10 MiB,
//   the app's per-file cap) are rejected with 413 before the
//   bytes are buffered. The relay never holds more than one
//   capped file in memory.
//
// Node standard library only — no dependencies to install, audit,
// or keep patched. Run with: node relay/server.mjs (see the
// systemd unit in relay/nexora-clamav-relay.service).
//
// This file is plain JavaScript (not TypeScript): it must run
// directly under node on the VPS without a build step. Types
// below are JSDoc comments only.

import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createConnection } from "node:net";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";

export const DEFAULT_RELAY_PORT = 8443;
export const DEFAULT_CLAMD_HOST = "127.0.0.1";
export const DEFAULT_CLAMD_PORT = 3310;
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_SCAN_TIMEOUT_MS = 30_000;
const CHUNK_SIZE = 65_536;

/**
 * @typedef {object} RelayOptions
 * @property {string} token Bearer token; required — the relay refuses to start without one.
 * @property {string} [clamdHost]
 * @property {number} [clamdPort]
 * @property {number} [maxBytes]
 * @property {number} [scanTimeoutMs]
 * @property {string} [tlsCertPath]
 * @property {string} [tlsKeyPath]
 * @property {(event: Record<string, unknown>) => void} [log] Structured log sink; defaults to one JSON line per event on stdout.
 */

function parseClamdResponse(response) {
  const line = response.replace(/\0/g, "").trim();
  if (line === "stream: OK") return "clean";
  if (/^stream: .+ FOUND$/.test(line)) return "infected";
  return "unavailable";
}

/** Scan bytes through clamd INSTREAM. Never throws: failures are "unavailable". */
function scanWithClamd(bytes, host, port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (verdict) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // Teardown must never turn a verdict into an error.
      }
      resolve(verdict);
    };
    const socket = createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once("timeout", () => finish("unavailable"));
    socket.once("error", () => finish("unavailable"));
    socket.once("connect", () => {
      try {
        socket.write("zINSTREAM\0");
        for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_SIZE) {
          const chunk = bytes.subarray(offset, Math.min(offset + CHUNK_SIZE, bytes.byteLength));
          const header = Buffer.alloc(4);
          header.writeUInt32BE(chunk.byteLength, 0);
          socket.write(header);
          socket.write(chunk);
        }
        const terminator = Buffer.alloc(4);
        terminator.writeUInt32BE(0, 0);
        socket.write(terminator);
      } catch {
        finish("unavailable");
      }
    });
    let response = "";
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (response.includes("\n")) finish(parseClamdResponse(response));
    });
    socket.once("end", () => finish(parseClamdResponse(response)));
    socket.once("close", () => finish(parseClamdResponse(response)));
  });
}

function tokenMatches(provided, expected) {
  if (!provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.byteLength !== b.byteLength) return false;
  return timingSafeEqual(a, b);
}

/** @param {RelayOptions} options */
export function createRelayServer(options) {
  const token = options.token?.trim() ?? "";
  if (!token) throw new Error("CLAMAV relay requires a bearer token (CLAMAV_RELAY_TOKEN)");
  const clamdHost = options.clamdHost ?? DEFAULT_CLAMD_HOST;
  const clamdPort = options.clamdPort ?? DEFAULT_CLAMD_PORT;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const scanTimeoutMs = options.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
  const log = options.log ?? ((event) => console.log(JSON.stringify(event)));

  const handler = async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    try {
      const url = new URL(request.url ?? "/", "http://relay.invalid");
      if (request.method === "GET" && url.pathname === "/health") {
        send(200, { ok: true });
        return;
      }
      if (request.method !== "POST" || url.pathname !== "/scan") {
        send(404, { error: "not_found" });
        return;
      }
      const authorization = request.headers.authorization ?? "";
      const provided = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
      if (!tokenMatches(provided, token)) {
        log({ event: "relay.auth_failed", endpoint: "scan" });
        send(401, { error: "unauthorized" });
        return;
      }
      const declared = Number(request.headers["content-length"] ?? "0");
      if (Number.isFinite(declared) && declared > maxBytes) {
        send(413, { error: "file_too_large" });
        return;
      }
      const chunks = [];
      let total = 0;
      let rejected = false;
      for await (const chunk of request) {
        total += chunk.byteLength;
        if (total > maxBytes) {
          rejected = true;
          break;
        }
        chunks.push(chunk);
      }
      if (rejected) {
        send(413, { error: "file_too_large" });
        return;
      }
      const bytes = Buffer.concat(chunks);
      const verdict = await scanWithClamd(bytes, clamdHost, clamdPort, scanTimeoutMs);
      if (verdict === "unavailable") {
        log({ event: "relay.scan_unavailable" });
        send(502, { error: "scanner_unavailable" });
        return;
      }
      log({ event: "relay.scan_completed", verdict });
      send(200, { verdict });
    } catch {
      // A handler failure must never leak internals or hang the client.
      try {
        send(500, { error: "internal_error" });
      } catch {
        // Response already gone; nothing left to do.
      }
    }
  };

  if (options.tlsCertPath && options.tlsKeyPath) {
    return createHttpsServer(
      { cert: readFileSync(options.tlsCertPath), key: readFileSync(options.tlsKeyPath) },
      handler,
    );
  }
  if (options.tlsCertPath || options.tlsKeyPath) {
    throw new Error("TLS needs both a cert and a key (RELAY_TLS_CERT and RELAY_TLS_KEY)");
  }
  return createHttpServer(handler);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (flag.startsWith("--") && i + 1 < argv.length) out[flag.slice(2)] = argv[i + 1];
  }
  return out;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const entry = new URL(`file://${process.argv[1]}`).href;
  return import.meta.url === entry;
}

if (isMainModule()) {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.CLAMAV_RELAY_TOKEN?.trim() ?? "";
  const port = Number(args.port ?? process.env.CLAMAV_RELAY_PORT ?? DEFAULT_RELAY_PORT);
  const server = createRelayServer({
    token,
    clamdHost: args["clamd-host"] ?? process.env.CLAMAV_RELAY_CLAMD_HOST,
    clamdPort: Number(args["clamd-port"] ?? process.env.CLAMAV_RELAY_CLAMD_PORT ?? DEFAULT_CLAMD_PORT),
    tlsCertPath: args["tls-cert"] ?? process.env.RELAY_TLS_CERT,
    tlsKeyPath: args["tls-key"] ?? process.env.RELAY_TLS_KEY,
  });
  server.listen(port, "0.0.0.0", () => {
    const tls = Boolean(args["tls-cert"] ?? process.env.RELAY_TLS_CERT);
    console.log(JSON.stringify({ event: "relay.listening", port, tls }));
    if (!tls) {
      console.log(
        JSON.stringify({
          event: "relay.tls_warning",
          detail: "Running without TLS — local tests only. Production must use TLS (see relay/README.md).",
        }),
      );
    }
  });
}
