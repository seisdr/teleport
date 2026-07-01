# teleport

Run tools on remote machines via HTTP. One relay, many connectors, zero inbound ports.

```
your client ──► relay (Bun) ◄── connector (Python) ◄── remote machine
                          │
                          ▼
                  MCP / REST API
```

## How it works

1. Start the relay — a Bun HTTP/WebSocket server
2. Run the one-liner on any target machine — it installs and starts the connector
3. The connector opens an **outbound** WebSocket to the relay (no firewall holes)
4. Call tools (`bash`, `read`, `write`, `edit`, `glob`, `grep`, `ls`, `stat`, `env`) via the relay's REST API or MCP endpoint

Every connected machine shows up with a unique ID (`m_<base64url>`) and label. Tools are dispatched to the correct machine by `label__toolname`.

## Quick start

```bash
# Terminal 1: start relay
cd relay && bun install && bun run src/index.ts

# Target machine: paste the one-liner
curl -sSL 'http://<relay>:7777/sh' | sh -
# or on Windows:
irm 'http://<relay>:7777/psh' | iex
```

## Architecture

| Component | Runtime | Role |
|---|---|---|
| `relay/` | Bun + TypeScript | HTTP/WS server, MCP endpoint, tool dispatch |
| `connector/` | Python 3 (stdlib) | Runs on remote machines, executes tools |
| `cli/` | Bun + TypeScript | Manage tokens, list machines, start relay |
| `agent/` | TypeScript | OMP extension — `/tp` slash commands |

### Protocol

Connector ↔ Relay: WebSocket, JSON text frames. One WS per connector.
Relay ↔ Client: MCP (JSON-RPC 2.0) over `POST /mcp` or REST `POST /api/tools/call`.

See [PROTOCOL.md](PROTOCOL.md) for the full wire spec.

## Endpoints

| Route | Method | Description |
|---|---|---|
| `/sh` | GET | Shell install script (Linux/macOS/Termux) — tokenless |
| `/psh` | GET | PowerShell install script (Windows) — tokenless |
| `/connector.py` | GET | Connector source (fetched by installer) |
| `/ws/connector` | WS | Connector WebSocket upgrade |
| `/mcp` | POST | MCP JSON-RPC 2.0 (tools/list, tools/call) |
| `/mcp` | GET | MCP SSE stream |
| `/health` | GET | `{"ok":true, "machines":N, "online":N}` |
| `/api/machines` | GET | All machines: id, label, hostname, os, arch, status, capabilities |
| `/api/tools/call` | POST | Call a tool on a machine: `{"name":"label__tool","arguments":{}}` |
| `/api/tokens` | POST | Create join token → `{token:{secret,label,...}, install_url:".../sh"}` |
| `/api/operators` | GET | List operator tokens |
| `/api/events` | GET | SSE stream: `machine_connected`, `machine_disconnected` |
## Available tools

`bash`, `read`, `write`, `edit`, `glob`, `grep`, `ls`, `stat`, `env`

All return `{type: "text", text: "..."}` content blocks. See PROTOCOL.md for exact args and behavior.

## CLI

```bash
omp-teleport start              # start relay (auto-spawn)
omp-teleport token <label>      # create join token, prints install URL
omp-teleport ls                 # list connected machines
omp-teleport config             # dump config and relay URL
```

## OMP extension (/tp)

| Command | Effect |
|---|---|
| `/tp ls` | List connected machines |
| `/tp pick` | Interactive picker — connects to selected machine |
| `/tp connect <label>` | Remote-only mode: hides local fs tools |
| `/tp disconnect` | Restore local tools |
| `/tp force [on\|off]` | Alias `bash` → `remote_bash` etc. |
| `/tp refresh` | Re-poll machines from relay |
| `/tp restart` | Reconnect to relay |

## Environment variables

| Var | Default | Description |
|---|---|---|
| `OMP_REMOTE_RELAY` | `http://127.0.0.1:7777` | Relay URL |
| `OMP_REMOTE_PORT` | `7777` | Relay listen port |
| `OMP_REMOTE_BIND` | `0.0.0.0` | Relay bind address |
| `OMP_REMOTE_STATE_DIR` | `~/.omp-teleport` | Persistence (tokens, state) |
| `OMP_REMOTE_TOKEN` | — | Operator or join token |
| `OMP_REMOTE_LABEL` | hostname | Machine display label |
| `OMP_REMOTE_INSTALL_DIR` | `~/.omp-teleport` | Connector install path |
| `OMP_REMOTE_PUBLIC_URL` | — | Override public-facing relay URL |

## Connector details

- **Single file**: `connector/connector.py` — stdlib only, no pip install needed
- **Hardware ID**: deterministic (`/etc/machine-id` or hostname hash), survives reconnects
- **Reconnect**: exponential backoff (1s → 30s max) on relay disconnect
- **Heartbeat**: ping/pong every 5s, 3x timeout → marks offline
- **Concurrency**: up to 4 simultaneous tool calls (configurable)
- **Cancellation**: relay can cancel in-flight tool calls
- **Progress**: bash tool streams output line-by-line via `tool.progress` frames

## Security

The relay runs with no authentication by default (designed for localhost/dev use).
Token-based auth (`jt_` join tokens, `ot_` operator tokens) is implemented in the
store but not enforced at the HTTP/WS layer. To enforce, wire token validation
into the request handlers.

Connectors initiate outbound WebSocket connections only — no ports need to be opened
on target machines.

## Run tests

```bash
# Full end-to-end smoke test (relay + connector + all tools + MCP)
bash scripts/smoke.sh

# Smoke variants
bash scripts/smoke-autospawn.sh        # auto-spawn relay
bash scripts/smoke-autospawn-e2e.sh    # full autospawn + CLI + connector
bash scripts/smoke-isolation.sh        # concurrent safety
bash scripts/test-concurrent.sh        # stress test
```
