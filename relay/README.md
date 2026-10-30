# Nexora ClamAV relay

A tiny Node.js service (standard library only, no dependencies)
that sits in front of a local `clamd` on a VPS and exposes one
authenticated HTTPS endpoint, `POST /scan`, to the Nexora app.
It is the secure half of the free-VPS scanning route: the app
never talks raw TCP to clamd over the internet, and clamd never
listens on anything but loopback.

## How it fits

```
Nexora on Vercel ──HTTPS + bearer token──> relay:8443 ──TCP 127.0.0.1:3310──> clamd
                                            (this service)                      (local only)
```

- App mode: `NEXORA_MALWARE_SCANNER=clamav-relay` (synchronous:
  the upload is scanned before its row is committed, exactly like
  the `clamav` mode — only the transport differs).
- Relay verdicts: `{"verdict":"clean"}` or `{"verdict":"infected"}`.
  A missing/broken clamd returns 502, which the app treats as
  quarantined (fail closed). Signature names are never returned.
- This relay is implemented locally 2026-10-28 and is NOT live
  until the setup below is done and the verification order at the
  bottom passes. Until then, malware protection must not be
  claimed as operational.

## Setup on the VPS (Oracle Always Free, Ubuntu 24.04 ARM)

The Oracle account, the VM, and the card verification are the
operator's own steps (card hold reverses; no later charge while
inside Always Free limits and without a PAYG upgrade). Home
region is permanent — Hyderabad has historically had easier ARM
capacity than Mumbai. Shape actually used (proven 2026-10-30):
`VM.Standard.E2.1.Micro`, 1 OCPU, 1 GB RAM — the A1.Flex shape
in the original plan never got capacity (nine out-of-capacity
failures). On 1 GB, the first freshclam run is OOM-killed, so a
2 GB swap file is part of the install (created, enabled, added
to `/etc/fstab`) before freshclam is retried. The rest is
commands on the VM:

### 1. Install ClamAV and Node

```sh
sudo apt-get update
sudo apt-get install -y clamav clamav-daemon clamav-freshclam nodejs
```

Node 18+ is enough for this service (standard library only).

### 2. Let clamd listen on loopback TCP

Ubuntu's default `clamd.conf` enables only a local socket. Add
TCP on loopback (and nothing else — never `0.0.0.0`):

```sh
sudo sed -i 's/^#TCPSocket 3310/TCPSocket 3310/' /etc/clamav/clamd.conf
sudo sed -i 's/^#TCPAddr 127.0.0.1/TCPAddr 127.0.0.1/' /etc/clamav/clamd.conf
sudo systemctl enable --now clamav-freshclam
sudo systemctl enable --now clamav-daemon
```

Note: ClamAV 1.5.4's `clamd.conf` contains no TCPSocket/TCPAddr
lines at all, so the sed commands above silently match nothing
on it — verify with grep, and if they matched nothing, append
the two lines (`TCPSocket 3310`, `TCPAddr 127.0.0.1`) to the
file instead.

Wait for the first signature download (`freshclam` can take a
few minutes), then confirm the daemon answers:

```sh
sudo systemctl status clamav-daemon --no-pager
ss -ltn | grep 3310   # must show 127.0.0.1:3310, never 0.0.0.0:3310
```

### 3. Install the relay

```sh
sudo useradd --system --no-create-home nexora-relay
sudo mkdir -p /opt/nexora-relay /etc/nexora-relay
# copy relay/server.mjs + relay/nexora-clamav-relay.service here, e.g. via scp or git clone
sudo cp relay/server.mjs /opt/nexora-relay/server.mjs
sudo cp relay/nexora-clamav-relay.service /etc/systemd/system/nexora-clamav-relay.service
sudo chown -R nexora-relay:nexora-relay /opt/nexora-relay
```

### 4. Token + private CA + server certificate

No domain is needed: the app pins this private CA, so a
self-signed server certificate is safe here (the CA private key
never leaves this VM; anyone who has it already owns the VM).

```sh
cd /opt/nexora-relay
PUBLIC_IP=<the VM's public IPv4 address>

# Private CA (kept on this VM only)
openssl req -x509 -newkey rsa:2048 -keyout ca.key -out ca.crt -days 825 -nodes -subj "/CN=nexora-clamav-ca"

# Server key + certificate for the VM's IP
openssl genrsa -out server.key 2048
openssl req -new -key server.key -out server.csr -subj "/CN=$PUBLIC_IP"
printf "subjectAltName=IP:%s\n" "$PUBLIC_IP" > server.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days 825 -extfile server.ext

# Bearer token (long random; this exact value also goes to Vercel)
TOKEN=$(openssl rand -hex 32)

sudo chown root:nexora-relay ca.crt server.crt server.key
sudo chmod 640 ca.crt server.crt server.key
sudo rm -f server.csr server.ext
sudo sh -c "cat > /etc/nexora-relay/env <<EOF
CLAMAV_RELAY_TOKEN=$TOKEN
CLAMAV_RELAY_PORT=8443
RELAY_TLS_CERT=/opt/nexora-relay/server.crt
RELAY_TLS_KEY=/opt/nexora-relay/server.key
EOF"
sudo chmod 600 /etc/nexora-relay/env
```

The CA certificate, base64-encoded on one line, is what the app
pins — never the CA key, never the token, never in chat or git:

```sh
base64 -w0 ca.crt   # -> NEXORA_CLAMAV_RELAY_CA in Vercel
```

### 5. Firewall: relay port only

Open TCP 8443 to the internet (Oracle console security list AND
the VM firewall, e.g. `sudo ufw allow 8443/tcp`). On the Oracle
Ubuntu images used here, ufw is not installed and was left
alone; what was actually needed was one host iptables ACCEPT
rule for TCP 8443 before the final REJECT rule, persisted with
the image's netfilter-persistent service — the OCI rule alone
did not open the port. Keep 3310 closed everywhere: `ss` above
must show it on loopback only.

### 6. Start + check

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now nexora-clamav-relay
sudo systemctl status nexora-clamav-relay --no-pager
sudo journalctl -u nexora-clamav-relay -n 20 --no-pager
```

### 7. Vercel Production variables + redeploy

| Variable | Value |
|---|---|
| `NEXORA_MALWARE_SCANNER` | `clamav-relay` |
| `NEXORA_CLAMAV_RELAY_URL` | `https://<PUBLIC_IP>:8443` |
| `NEXORA_CLAMAV_RELAY_TOKEN` | the `$TOKEN` from step 4 |
| `NEXORA_CLAMAV_RELAY_CA` | base64 of `ca.crt` from step 4 |

The app requires `https:` in production and rejects a missing
token or a malformed CA at startup of the scan path (uploads
fail with a configuration error, loudly, rather than silently
going unscanned).

## Two relays (HA)

A second relay is a second, independent install of steps 1–6 on
its own VM, with its own token and its own private CA — never
reuse the first relay's token or CA on the second machine. The
app's second-relay variables are:

| Variable | Value |
|---|---|
| `NEXORA_CLAMAV_RELAY_URL_2` | `https://<SECOND_PUBLIC_IP>:8443` |
| `NEXORA_CLAMAV_RELAY_TOKEN_2` | the second VM's `$TOKEN` |
| `NEXORA_CLAMAV_RELAY_CA_2` | base64 of the second VM's `ca.crt` |

With both sets configured, the app distributes scans across the
two relays, falls through to the healthy one on any failure,
and readmits a recovered relay automatically (see
`src/server/malware.ts` `multiRelayScanner` and ARCHITECTURE.md
§9b). There is no managed load balancer in this design: a
managed balancer is a paid service, so balancing lives in the
app at no extra cost. Each relay keeps its own freshclam
schedule, so signature databases stay in step without any sync
step; a relay whose database lags is still a valid scanner, and
both relays answering the same file with synced databases agree.

Recovery, honestly stated: `systemd` restarts a crashed relay
service (`Restart=on-failure`), and the app's failover covers a
dead relay with no manual step. But a whole VM going down (for
example Oracle stopping an idle Always Free instance) cannot
restart itself from inside. Until a watcher exists, the answer
for a stopped VM is an operator alert plus a console restart;
the app keeps serving scans through the surviving relay in the
meantime. A watcher script on the surviving VM that starts a
stopped instance through the OCI API is possible (API calls
themselves are free) but needs an operator-created API key and
is deliberately not part of v1.

## Verification order (before claiming scanning works)

1. Health: `curl https://<IP>:8443/health -k` → `{"ok":true}`
   (`-k` only here — curl does not have the pinned CA; the app
   verifies properly).
2. Clean file: `curl -X POST https://<IP>:8443/scan -k -H
   "Authorization: Bearer $TOKEN" --data-binary @some-clean-file`
   → `{"verdict":"clean"}`.
3. EICAR test file (the standard harmless test signature):
   `printf 'X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'
   > /tmp/eicar.txt`, then POST it → `{"verdict":"infected"}`.
   Delete `/tmp/eicar.txt` afterwards — it is a test signature,
   not malware, but it must not linger in a workspace.
4. Wrong token → 401. No token → 401.
5. In the app: upload a clean file → recorded clean, downloads
   normally; upload the EICAR file → recorded quarantined, 409
   on both download paths (link issuance and signed token).
6. Clear the pending backlog once: `scripts/rescan-task-files.mjs`
   with `MIGRATOR_DATABASE_URL` (direct Neon endpoint, migrator
   role; it cannot run from a host whose direct Neon TCP is
   blocked).
7. Only after 1–6 pass: the pending-download block deploy is a
   separate decision. Deploying it before a live scanner exists
   stops ALL production downloads.

## Operations

- `freshclam` refreshes signatures on its own timer; `clamd`
  reloads them automatically. No manual step per signature update.
- If the relay or clamd is down, new uploads are quarantined
  (fail closed) — do not work around downtime by disabling
  scanning or the download block.
- Oracle may stop an Always Free instance that sits below ~20%
  CPU, network, and memory utilization over a 7-day window. A
  scanner-only box can trip that: if scans start failing closed,
  check the instance state in the Oracle console first and
  restart it if it was stopped.
- Deliberate v1 limits: no per-IP rate limit on the relay (the
  bearer token is the control; Vercel's egress IPs vary, so IP
  allowlisting is not viable); no file bytes in relay logs
  (verdicts only); no signature names in relay responses.

## Local development

`node relay/server.mjs` without TLS variables starts plain HTTP
on 0.0.0.0:8443 with a startup warning — local tests only. The
app refuses plain-http relay URLs in production.
