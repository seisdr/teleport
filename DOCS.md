# Teleport — Full Documentation

Run filesystem tools on remote machines over HTTP. One relay, many connectors, zero inbound firewall rules.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Quick Start](#quick-start)
3. [Relay](#relay)
4. [Connector](#connector)
5. [Install Scripts](#install-scripts)
6. [Protocol](#protocol)
7. [API Reference](#api-reference)
8. [MCP Endpoint](#mcp-endpoint)
9. [CLI](#cli)
10. [OMP Extension](#omp-extension)
11. [Security](#security)
12. [Configuration Reference](#configuration-reference)
13. [Development & Testing](#development--testing)
14. [Troubleshooting](#troubleshooting)

---

## Architecture

```
┌──────────┐     HTTP/WS      ┌──────────┐     WebSocket      ┌──────────────┐
│  Client  │ ◄──────────────► │  Relay   │ ◄───────────────── │  Connector   │
│ (OMP/CLI)│                  │  (Bun)   │                    │  (Python 3)  │
└──────────┘                  └──────────┘                    └──────────────┘
                                    │                                 │
                                    │                          Remote machine
                              localhost or                       (outbound only)
                              reachable server
```

**Relay** — Bun server that accepts WebSocket connections from connectors and exposes an HTTP API + MCP endpoint to clients. Runs wherever is reachable by both sides.

**Connector** — Single-file Python 3 script that runs on each target machine. Opens an outbound WebSocket to the relay. Executes tool calls locally. No pip dependencies.

**Client** — Anything that talks to the relay: the `omp-teleport` CLI, the OMP extension (`/tp` commands), curl, or any MCP-compatible harness.

### Data flow for a tool call

```
Client ──POST /api/tools/call──► Relay ──WS tool.call──► Connector ──subprocess──► local fs
Client ◄──── JSON result ────── Relay ◄── WS tool.result ── Connector ◄─── stdout ──
```

Progress streaming: connector emits `tool.progress` frames during long-running `bash` calls; relay forwards them via SSE to streaming clients.

---

## Quick Start

### 1. Start the relay

```bash
cd relay
bun install
bun run src/index.ts
```

Output:
```
[relay] state dir: /home/user/.omp-teleport
[relay] one-liner install: curl http://0.0.0.0:7777/sh | sh -
[relay] connector websocket:   ws://0.0.0.0:7777/ws/connector
[relay] MCP streamable HTTP:   http://0.0.0.0:7777/mcp
```

### 2. Install on target machine

Paste the one-liner on the machine you want to control:

```bash
# Linux, macOS, Termux
curl -sSL 'http://<relay>:7777/sh' | sh -

# Windows (PowerShell)
irm 'http://<relay>:7777/psh' | iex
```

### 3. Verify

```bash
OMP_REMOTE_RELAY=http://127.0.0.1:7777 bun cli/omp-teleport.ts ls
```

### 4. Call a tool

```bash
curl -X POST http://127.0.0.1:7777/api/tools/call \
  -H 'Content-Type: application/json' \
  -d '{"name":"my_machine__bash","arguments":{"command":"uname -a"}}'
```

---

## Relay

### Source layout

```
relay/
├── package.json          # deps: zod only
├── tsconfig.json
├── bun.lock
└── src/
    ├── index.ts          # entry point, Bun.serve
    ├── types.ts          # shared interfaces and type aliases
    ├── store.ts          # in-memory state with atomic file persistence
    ├── connector-ws.ts   # WebSocket handler for connectors
    ├── http.ts           # HTTP routes: /sh, /psh, /api/*, /health
    ├── mcp.ts            # MCP Streamable HTTP handler (/mcp)
    └── util.ts           # safeLabel, toolNameFor, parseToolName
```

### Startup behavior

1. Creates state directory (`~/.omp-teleport` by default)
2. Loads `state.json` if it exists (persists operator and join tokens)
3. Starts Bun HTTP server with WebSocket support
4. Listens on `OMP_REMOTE_BIND:OMP_REMOTE_PORT` (default `0.0.0.0:7777`)

### State persistence

The relay stores tokens in `$OMP_REMOTE_STATE_DIR/state.json`. This file is written atomically (write to temp file, rename). It contains:

```json
{
  "operatorTokens": [
    {
      "kind": "operator",
      "secret": "ot_...",
      "name": "default",
      "created_at": 1735689600000
    }
  ],
  "joinTokens": [
    {
      "kind": "join",
      "secret": "jt_...",
      "label": "prod-db",
      "created_at": 1735689600000,
      "used_at": 1735689610000
    }
  ]
}
```

Machine state (connected machines, pending calls) is in-memory only — it does not survive relay restart.

### Lifecycle events

- **Machine connects**: `upsertMachine()` → emits `machine_connected` notification
- **Machine disconnects**: `markMachineOffline()` → all pending calls rejected with `"machine disconnected"`, emits `machine_disconnected`
- **Stale machine cleanup**: on reconnect, offline machines with the same hostname are removed

### Running in development

```bash
cd relay
bun run dev        # hot reload with --hot flag
bun run typecheck  # tsc --noEmit
```

---

## Connector

### Source

`connector/connector.py` — single file, stdlib only. No `pip install` needed.

### Runtime requirements

- Python 3.8+
- Outbound network access to the relay's WebSocket endpoint
- No root/admin privileges required (tools run as the connector's user)

### Command line

```bash
python3 connector.py \
  --relay ws://relay.example.com:7777/ws/connector \
  --token jt_abc123... \
  --label "prod db primary" \
  --install-dir ~/.omp-teleport
```

All arguments can also be set via environment variables:

| Flag | Env var |
|---|---|
| `--relay` | `OMP_REMOTE_RELAY` |
| `--token` | `OMP_REMOTE_TOKEN` |
| `--label` | `OMP_REMOTE_LABEL` |
| `--install-dir` | `OMP_REMOTE_INSTALL_DIR` |

### Hardware ID

The connector computes a deterministic machine ID on startup:

1. Reads `/etc/machine-id` (Linux) or `/var/lib/dbus/machine-id`
2. Falls back to SHA256 of hostname (first 16 hex chars)
3. Returns as `m_<12 chars base64url>`

This ID is stable across connector restarts and is used by the relay to deduplicate machines.

### Heartbeat

- Interval: 5 seconds
- Relay sends `ping`, connector replies `pong`
- If no pong received for 15 seconds (3x interval), relay closes connection
- Connector reconnects with exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s (capped)

### Tool execution

Tools run in threads (up to 4 concurrent). Each tool call:

1. Receives `tool.call` frame with `id`, `name`, `args`
2. Validates tool name against `TOOLS` registry
3. Spawns a daemon thread that executes the tool function
4. Sends `tool.result` frame on completion or error
5. Supports `tool.cancel` (sets a threading.Event checked by bash subprocess)

### Available tools

| Tool | Implementation | Notes |
|---|---|---|
| `bash` | `subprocess.run` via shell | 30s default timeout, streams output |
| `read` | `open(path).read()` | Returns text content, binary→base64 |
| `write` | `open(path, 'w')` | Creates parent directories |
| `edit` | Read→replace→write | Can replace substring or whole file |
| `glob` | `glob.glob` + `os.walk` for `**` | Returns newline-separated paths |
| `grep` | `re.search` per line | Returns `path:line:match` format |
| `ls` | `os.scandir` | Returns `name\tkind\tsize` per entry |
| `stat` | `os.stat` | Returns structured JSON |
| `env` | `os.environ` | All vars or single lookup |

### Cancellation

The bash tool supports cancellation via `threading.Event`. When the event is set:
- `subprocess.Popen` is killed via `process.kill()`
- A `Cancelled` exception propagates to the result handler
- Connector sends `tool.result` with `ok: false` and `"cancelled"` error

---

## Install Scripts

The relay generates install scripts dynamically, substituting the relay's actual URL.

### Shell (`/sh`)

- Finds `python3` or `python` on PATH
- Downloads connector.py from relay
- Starts connector in background with `nohup`
- Writes PID file for health checks on re-run
- Idempotent: skips if connector already running

### PowerShell (`/psh`)

- Same logic for Windows
- Tries `python3`, `python`, `py` launcher
- Falls back to downloading portable Python 3.12.4 embeddable zip
- Starts connector as a background process
- Waits 2 seconds to verify startup

### Token handling

The install scripts start connectors without a token. The relay accepts all connections by default, so a token is not required. For authenticated setups, pass `--token` directly to the connector or set `OMP_REMOTE_TOKEN`.

---

## Protocol

Full specification in [PROTOCOL.md](PROTOCOL.md). Summary:

### Transport

- Connector ↔ Relay: WebSocket, JSON text frames, one connection per machine
- Relay ↔ Client: HTTP POST (JSON), SSE for streaming; MCP over Streamable HTTP

### Frame types

| Frame | Direction | Purpose |
|---|---|---|
| `register` | C → R | Machine announces itself with capabilities |
| `registered` | R → C | Relay assigns `machine_id` and heartbeat interval |
| `tool.call` | R → C | Relay dispatches a tool invocation |
| `tool.progress` | C → R | Streaming output delta (bash only) |
| `tool.result` | C → R | Final result: content + ok/error + duration |
| `tool.cancel` | R → C | Cancel an in-flight tool call |
| `ping` / `pong` | Both | Heartbeat (every 5s) |
| `disconnect` | R → C | Graceful shutdown notice |

### Register frame

```json
{
  "type": "register",
  "machine_id": "m_abc123def456",
  "hostname": "db-prod-01",
  "os": "linux",
  "arch": "x64",
  "label": "prod db primary",
  "version": "0.5.0",
  "capabilities": {
    "tools": ["bash", "read", "write", "edit", "glob", "grep", "ls", "stat", "env"],
    "max_concurrent": 4,
    "supports_progress": true,
    "supports_cancel": true
  }
}
```

### Tool call / result

```json
// Relay → Connector
{
  "type": "tool.call",
  "id": "t_lx2abc",
  "name": "bash",
  "args": {"command": "ls /", "timeout": 30},
  "timeout_ms": 30000
}

// Connector → Relay (success)
{
  "type": "tool.result",
  "id": "t_lx2abc",
  "ok": true,
  "content": [{"type": "text", "text": "bin\netc\nhome\n"}],
  "duration_ms": 42
}

// Connector → Relay (failure)
{
  "type": "tool.result",
  "id": "t_lx2abc",
  "ok": false,
  "error": "exit code 2",
  "content": [{"type": "text", "text": "ls: cannot access ..."}]
}
```

---

## API Reference

### `GET /health`

Returns relay status and connected machine counts.

```json
{"ok": true, "machines": 3, "online": 2}
```

### `GET /api/machines`

Lists all machines the relay has ever seen.

```json
{
  "machines": [
    {
      "id": "m_abc123",
      "label": "prod_db",
      "hostname": "db-prod-01",
      "os": "linux",
      "arch": "x64",
      "version": "0.5.0",
      "connected_at": 1735689600000,
      "last_seen_at": 1735689610000,
      "status": "online",
      "capabilities": {
        "tools": ["bash", "read", "write", "edit", "glob", "grep", "ls", "stat", "env"],
        "max_concurrent": 4,
        "supports_progress": true,
        "supports_cancel": true
      }
    }
  ]
}
```

### `POST /api/tools/call`

Invoke a tool on a connected machine.

**Request:**
```json
{
  "name": "prod_db__bash",
  "arguments": {"command": "uname -a"},
  "timeout_ms": 30000,
  "stream": false
}
```

Tool name format: `<safe_label>__<tool_name>` where `safe_label` is the machine label lowercased with non-alphanumeric chars replaced by `_`.

**Response (non-streaming):**
```json
{
  "ok": true,
  "content": [
    {"type": "text", "text": "Linux db-prod-01 6.8.0 ..."}
  ],
  "duration_ms": 15
}
```

**Response (streaming, `stream: true`):**

SSE stream with events: `started`, `progress`, `result`.

```
event: started
data: {"id":"t_labc","name":"bash","machine":"prod-db"}

event: progress
data: {"id":"t_labc","delta":"total 84\ndrwxr-xr-x ...\n"}

event: result
data: {"id":"t_labc","ok":true,"content":[...],"duration_ms":42}
```

**Errors:**

| Condition | Response |
|---|---|
| Invalid tool name format | `ok: false, "tool name must be '<label>__<tool>'"` |
| Machine not found/offline | `ok: false, "no online machine with HWID '...'"` |
| Dispatch failed | `ok: false, "failed to dispatch to connector"` |
| Timeout | `ok: false, "tool call timed out after Nms"` |

### `GET /api/events`

Server-Sent Events stream for real-time machine state changes.

```
event: data
data: {"type":"snapshot","machines":[...]}

event: data
data: {"type":"change","reason":"machine_connected","id":"m_abc","machine":{...}}

event: data
data: {"type":"change","reason":"machine_disconnected","id":"m_abc","machine":null}
```

Keepalive comments (`: keepalive`) sent every 15 seconds.

### `GET /sh`

Returns the shell install script with relay URL substituted. Content-Type: `text/x-shellscript`.

### `GET /psh`

Returns the PowerShell install script. Content-Type: `text/plain`.

### `GET /connector.py`

Returns the connector source code. Content-Type: `text/x-python`.

---

## MCP Endpoint

### `POST /mcp`

Implements MCP (Model Context Protocol) over Streamable HTTP. Accepts standard JSON-RPC 2.0 requests.

**Initialize:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "capabilities": {},
    "clientInfo": {"name": "test-client", "version": "1.0"}
  }
}
```

**List tools:**
```json
{"jsonrpc": "2.0", "id": 2, "method": "tools/list"}
```

Response includes all `(machine_label, tool)` pairs for online machines:
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "tools": [
      {
        "name": "prod_db__bash",
        "description": "Run a shell command on prod_db",
        "inputSchema": {
          "type": "object",
          "properties": {
            "command": {"type": "string", "description": "Shell command to execute"},
            "cwd": {"type": "string", "description": "Working directory"},
            "timeout": {"type": "integer", "description": "Timeout in seconds (default 30)"}
          },
          "required": ["command"]
        }
      }
    ]
  }
}
```

**Call tool:**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "prod_db__bash",
    "arguments": {"command": "df -h"}
  }
}
```

Response:
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [{"type": "text", "text": "Filesystem ..."}],
    "isError": false
  }
}
```

**Tool naming convention:** `<safe_label>__<tool_name>` — same as the REST API.

**Notifications:** `notifications/tools/list_changed` is sent when machines connect or disconnect.

### MCP Tool Schemas

| Tool | Required args | Optional args |
|---|---|---|
| `bash` | `command` (string) | `cwd` (string), `timeout` (int) |
| `read` | `path` (string) | `offset` (int), `limit` (int) |
| `write` | `path` (string), `content` (string) | — |
| `edit` | `path` (string), `old_text` (string), `new_text` (string) | `replace_all` (bool) |
| `glob` | `pattern` (string) | `cwd` (string) |
| `grep` | `pattern` (string), `path` (string) | `include` (string), `max_count` (int) |
| `ls` | `path` (string) | — |
| `stat` | `path` (string) | — |
| `env` | — | `name` (string) |

---

## CLI

```
usage: omp-teleport <subcommand> [args]

Subcommands:
  start                  Start the relay (auto-spawn if not running)
  token <label> [ttl]    Create a join token (for isolation/tracking)
  install-url [label] [ttl]  Print a tokenless install one-liner
  ls                     List connected machines
  operators              List operator tokens
  config                 Show config and relay URL
```

### `omp-teleport start`

Starts the relay as a background process if not already running. Uses `OMP_REMOTE_RELAY` to check health before spawning. Auto-creates an operator token on first run.

### `omp-teleport token <label>`

Creates a join token and prints the install URL:

```
curl -sSL 'http://127.0.0.1:7777/sh' | sh -
```

The token is minted server-side for isolation/tracking but not embedded in the URL. Use `curl -X POST /api/tokens` to get the raw token secret if needed.

Optional TTL in seconds: `omp-teleport token prod-db 3600`

### `omp-teleport ls`

```json
[
  {"id": "m_abc", "label": "prod-db", "hostname": "db-prod-01", "os": "linux", "status": "online"},
  {"id": "m_def", "label": "staging", "hostname": "staging-01", "os": "linux", "status": "offline"}
]
```

### `omp-teleport config`

Shows relay URL, state directory, and installed CLI path.

---

## OMP Extension

The `agent/omp-teleport.ts` file registers as an OMP extension providing slash commands and remote tool access.

### Slash commands

| Command | Effect |
|---|---|
| `/tp ls` | List connected machines in a sidebar widget |
| `/tp pick` | Interactive machine selector → sets active machine |
| `/tp connect <label>` | Remote-only mode: hides local filesystem tools, all 9 remote tools default to active machine |
| `/tp disconnect` | Restores full local tool set |
| `/tp force [on\|off]` | Aliases short names (`bash`, `read`, etc.) to their `remote_*` equivalents |
| `/tp refresh` | Re-poll machine list from relay |
| `/tp restart` | Reconnect to relay |

### Remote tools

Nine tools are registered with `remote_` prefix:

`remote_bash`, `remote_read`, `remote_write`, `remote_edit`, `remote_glob`, `remote_grep`, `remote_ls`, `remote_stat`, `remote_env`

Each accepts a `machine` argument to target a specific machine by label.

### Widget

A sidebar widget shows online/offline machine status, updated via SSE from `/api/events`.

### Connection modes

- **Default**: Both local and remote tools available. Model chooses.
- **Remote-only** (`/tp connect`): Local filesystem tools hidden via `setActiveTools`. Remote tools default to the connected machine. Non-filesystem tools (memory, search, etc.) remain available.
- **Force mode** (`/tp force on`): Short names (`bash`, `read`) alias to `remote_*`. Useful when you want to type naturally.

---

## Security

### Current state

The relay runs **open by default**. No authentication is enforced on HTTP endpoints or WebSocket connections. The `auth.ts` module has a stub that always returns `{ ok: true }`.

Token infrastructure exists in the store:
- **Join tokens** (`jt_...`): single-use, optional TTL, intended for connector authentication
- **Operator tokens** (`ot_...`): long-lived, intended for client/CLI authentication

### Enabling authentication

To enable token enforcement:

1. Wire `requireOperator()` into `handleHttpRequest` and `handleMcpRequest`
2. Wire token validation into `handleConnectorUpgrade`
3. Configure tokens via CLI or environment

### Connector security

- **Outbound only**: Connectors initiate WebSocket connections to the relay. No inbound ports needed.
- **No elevated privileges**: Connector runs as the user who installed it.
- **Tool scoping**: Only the 9 defined tools are executable. Arbitrary code execution is limited to what `bash` allows (which is everything the user can do).
- **Hardware ID**: Deterministic machine identity prevents spoofing (if auth is enforced).

### Recommendations for production

- Run relay behind a reverse proxy with TLS (nginx, Caddy)
- Set `OMP_REMOTE_BIND=127.0.0.1` and use SSH tunneling or WireGuard
- Enable token authentication
- Use short TTLs on join tokens
- Rotate operator tokens periodically
- Restrict `OMP_REMOTE_INSTALL_DIR` to non-world-readable locations

---

## Configuration Reference

### Relay environment variables

| Variable | Default | Description |
|---|---|---|
| `OMP_REMOTE_PORT` | `7777` | HTTP/WS listen port |
| `OMP_REMOTE_BIND` | `0.0.0.0` | Bind address |
| `OMP_REMOTE_STATE_DIR` | `~/.omp-teleport` | Token persistence directory |
| `OMP_REMOTE_PUBLIC_URL` | (auto-detect) | Override public-facing URL for install scripts |

### Connector environment variables

| Variable | Default | Description |
|---|---|---|
| `OMP_REMOTE_RELAY` | (required) | Relay WebSocket URL (`ws://host:port/ws/connector`) |
| `OMP_REMOTE_TOKEN` | — | Join token |
| `OMP_REMOTE_LABEL` | hostname | Machine display label |
| `OMP_REMOTE_INSTALL_DIR` | `~/.omp-teleport` | Connector working directory |

### CLI / OMP extension environment variables

| Variable | Default | Description |
|---|---|---|
| `OMP_REMOTE_RELAY` | `http://127.0.0.1:7777` | Relay HTTP URL |
| `OMP_REMOTE_TOKEN` | — | Operator token |

---

## Development & Testing

### Project structure

```
teleport/
├── README.md
├── PROTOCOL.md          # Wire protocol specification
├── DOCS.md              # This file
├── .gitignore
├── relay/               # Bun relay server
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts
│       ├── types.ts
│       ├── store.ts
│       ├── auth.ts
│       ├── connector-ws.ts
│       ├── http.ts
│       ├── mcp.ts
│       └── util.ts
├── connector/           # Python connector
│   ├── connector.py
│   └── smoke_test.py
├── cli/                 # CLI tool
│   ├── package.json
│   └── omp-teleport.ts
├── agent/               # OMP extension
│   └── omp-teleport.ts
└── scripts/             # Test scripts
    ├── smoke.sh
    ├── smoke-autospawn.sh
    ├── smoke-autospawn-e2e.sh
    ├── smoke-isolation.sh
    └── test-concurrent.sh
```

### Running tests

```bash
# Full end-to-end: relay + connector + all 9 tools + MCP
bash scripts/smoke.sh

# Auto-spawn relay variant
bash scripts/smoke-autospawn.sh

# Full auto-spawn + CLI + connector lifecycle
bash scripts/smoke-autospawn-e2e.sh

# Concurrent tool execution safety
bash scripts/smoke-isolation.sh

# Stress test with multiple simultaneous calls
bash scripts/test-concurrent.sh
```

Smoke tests use port `17777` and temp directories under `/tmp/omp-teleport-smoke*` to avoid conflicts with a running relay.

### Type checking

```bash
cd relay
bun run typecheck    # tsc --noEmit
```

### Connector testing in isolation

```bash
cd connector
python3 smoke_test.py
```

---

## Troubleshooting

### Relay won't start

```
EADDRINUSE: port 7777 is in use
```
→ Change `OMP_REMOTE_PORT` or kill the existing process:
```bash
pkill -f "relay/src/index.ts"
```

### Connector won't connect

Check the connector log:
```bash
tail -f ~/.omp-teleport/connector.log
```

Common causes:
- Relay not reachable (firewall, wrong URL)
- Token expired or already used
- Network timeout (check `--relay` uses `ws://` not `http://`)

### Machine shows offline

The relay marks a machine offline after 15 seconds (3x heartbeat) of silence. Check:
- Connector process still running: `ps aux | grep connector`
- Network connectivity to relay
- Connector logs for errors

### Tool call returns "no online machine"

- Machine is offline (see above)
- Wrong label in tool name: use `omp-teleport ls` to see exact labels
- Tool name format: label is lowercased, non-alphanumeric → `_`. `"Prod DB"` becomes `prod_db`.

### "tool name must be '<label>__<tool>'" error

The tool name must contain `__` (double underscore) separating label from tool name. Example: `my_server__bash`, not `my_server.bash` or `my_server_bash`.

### TypeScript compilation errors in relay

```bash
cd relay
bun install        # ensure deps match bun.lock
bun run typecheck  # see specific errors
```

### Port already in use on Mac

macOS AirPlay Receiver may use port 5000 or other common ports. Use a non-standard port:
```bash
OMP_REMOTE_PORT=17777 bun run relay/src/index.ts
```
