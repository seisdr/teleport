# teleport

`curl | sh` — run an AI agent's tools on a remote machine (Linux, macOS, Windows, Android).

Drop a one-liner on any box, then drive it from your local harness as if
the tools were local. All tool calls (`bash`, `read`, `edit`, …) execute
on the remote; the model and session stay on your machine.

```
your harness (OMP, Claude Code, …)
        │
        ▼
    relay (Bun)  ◄──── connector (Python, on remote)
        │
        ▼
    MCP server (any MCP-capable client)
```

## What you get

- **One connector script** — Python 3 stdlib, ~660 lines, zero
  dependencies. Talks WebSocket outbound, so it works on hosts that
  only allow egress.
- **A relay server** — Bun, single binary. Holds connected machines,
  exposes an HTTP API and a WebSocket endpoint for connectors, and an
  MCP server for any harness.
- **An OMP extension** (`agent/omp-teleport.ts`) that registers
  `remote_bash`, `remote_read`, `remote_write`, `remote_edit`,
  `remote_glob`, `remote_grep`, `remote_ls`, `remote_stat`,
  `remote_env` and forwards each call to the relay. Plus `/tp`
  slash command and a live status widget above the editor.
- **A CLI** (`cli/omp-teleport.ts`) to manage a separately-run relay
  (issue join tokens, list machines, print config).
- **An MCP server** at `/mcp` (defined but not yet routed) so any
  MCP-capable harness can get the same tools with zero extra code.

## Quickstart

By default, the OMP extension auto-spawns a local relay on first use
and tears it down with the session. No separate install needed.

```bash
# 1. Start omp. The extension spawns a relay on 0.0.0.0:7777.
omp

# 2. On the remote machine:
curl -sSL 'http://<your-ip>:7777/sh' | sh -

# 3. Windows (PowerShell, no admin needed):
irm 'http://<your-ip>:7777/psh' | iex
```

The relay binds `0.0.0.0:7777` by default. Override with
`OMP_REMOTE_BIND` or `OMP_REMOTE_PORT`.

### macOS

Standard sh installer works:

```bash
curl -sSL 'http://<relay>:7777/sh' | sh -
```

### Android (Termux, no root)

```bash
# Install Termux from F-Droid, then:
pkg install python
curl -sSL 'http://<relay>:7777/sh' | sh -
```

### Windows

```powershell
irm 'http://<relay>:7777/psh' | iex
```

The PowerShell installer will find an existing Python or download a
portable one, then download and start the connector. No admin rights
needed. Requires PowerShell 5.1+ (ships with Windows 10+).

### What the install scripts do

`/sh` (Linux/macOS/Android):
1. Creates `~/.omp-teleport/`
2. Persists the relay URL to `~/.omp-teleport/env`
3. Downloads `connector.py` from the relay
4. Starts the connector in the background with `python3` or `python`
5. Writes a PID file

`/psh` (Windows):
1. Creates `%USERPROFILE%\.omp-teleport\`
2. Persists the relay URL
3. Checks for `python3`, `python`, or `py` on PATH
4. If none found, downloads a portable Python embed zip
5. Downloads `connector.py` from the relay
6. Starts the connector as a background process

## Slash commands

### `/tp` — manage remote machines

| Subcommand | Effect |
|---|---|
| `/tp ls` | list connected machines (marks the active one) |
| `/tp pick` | interactive machine picker; enters remote-only mode |
| `/tp connect <machine>` | enter remote-only mode (hides local filesystem tools; sets active machine) |
| `/tp disconnect` | exit remote-only mode (restores all local tools) |
| `/tp refresh` | re-poll the machine list |
| `/tp restart` | reconnect to the relay |
| `/tp force [on\|off]` | toggle force mode: use short names (bash, read, etc.) as aliases to remote tools |

## CLI

```bash
omp-teleport start                         # start the relay in the foreground
omp-teleport token <label> [ttl_sec]       # issue a join token, print the install URL
omp-teleport install-url <label> [ttl_sec] # same but only print the URL
omp-teleport ls                            # list connected machines
omp-teleport operators                     # list operator tokens
omp-teleport config                        # print resolved relay URL + operator token
```

## Explicit relay (skip auto-spawn)

If you'd rather run the relay as a separate process (cloud server,
shared team relay, systemd unit):

```bash
export OMP_REMOTE_RELAY=https://relay.example.com
omp
```

To run the relay standalone:

```bash
cd relay
bun install
bun run src/index.ts
```

## Environment

| Var | Default | Notes |
|---|---|---|
| `OMP_REMOTE_RELAY` | (auto-spawn) | explicit relay URL; skips auto-spawn when set |
| `OMP_REMOTE_TOKEN` | (not set) | operator token for the extension / CLI |
| `OMP_REMOTE_PORT` | `7777` | port for the auto-spawned relay |
| `OMP_REMOTE_BIND` | `0.0.0.0` | bind address for the auto-spawned relay |
| `OMP_REMOTE_PUBLIC_URL` | (empty) | base URL embedded in install URLs |
| `OMP_REMOTE_STATE_DIR` | `~/.omp-teleport` | where the relay persists tokens + machine list |
| `OMP_REMOTE_RELAY_ENTRY` | (auto-detect) | path to `relay/src/index.ts` for the auto-spawn |
| `OMP_REMOTE_LABEL` | hostname | label for the connector (install side) |
| `OMP_REMOTE_INSTALL_DIR` | `~/.omp-teleport` | connector install directory |

## Architecture

```
connector.py (Python)              relay (Bun)                 harness (OMP, Claude Code, …)
       │                                │                                 │
       │   WS /ws/connector             │                                 │
       │ ──────────────────────────────►│                                 │
       │                                │                                 │
       │   {type:"register",label,…}    │                                 │
       │ ──────────────────────────────►│                                 │
       │                                │                                 │
       │   {type:"tool.call",…}         │                                 │
       │ ◄──────────────────────────────│                                 │
       │                                │                                 │
       │   {type:"tool.result",…}       │                                 │
       │ ──────────────────────────────►│                                 │
       │                                │                                 │
       │                                │  MCP at /mcp                    │
       │                                │ ◄────────────────────────────── │
       │                                │  (tools/list, tools/call)       │
       │                                │ ──────────────────────────────►│
```

## Wire protocol

| Surface | Endpoint | Format |
|---|---|---|
| Connector ↔ relay | WebSocket `/ws/connector` | JSON text frames |
| Harness ↔ relay | HTTP `/mcp` | JSON-RPC 2.0 (MCP Streamable HTTP) |
| Extension ↔ relay | HTTP `/api/*` | JSON over HTTP |

## Tool surface

The connector implements nine tools. All return
`{content: [{type: "text", text: "..."}], ok: bool}`:

| Tool | Args | Result |
|---|---|---|
| `bash` | `command`, `cwd?`, `timeout?` (sec, default 30) | combined stdout+stderr + `[exit: N]` |
| `read` | `path`, `offset?`, `limit?` (bytes) | file contents (capped at 4MB) |
| `write` | `path`, `content` | `"wrote N bytes to {path}"` |
| `edit` | `path`, `old_text`, `new_text`, `replace_all?` | `"patched"` |
| `glob` | `pattern`, `cwd?` | newline-separated paths |
| `grep` | `pattern`, `path`, `include?`, `max_count?` | `path:line:match` lines |
| `ls` | `path` | `kind size name` lines |
| `stat` | `path` | one-line summary |
| `env` | `name?` | single value or all env |

MCP tool names are `<safeLabel>__<tool>` (e.g. `prod_db__bash`).
Extension names are `remote_<tool>` with a `machine` arg.

## HTTP endpoints

| Route | Method | Description |
|---|---|---|
| `/sh` | GET | Shell install script (Linux/macOS/Android) |
| `/psh` | GET | PowerShell install script (Windows) |
| `/connector.py` | GET | Connector source |
| `/mcp` | GET/POST | MCP Streamable HTTP server (defined but not yet routed) |
| `/ws/connector` | WS | Connector WebSocket |
| `/health` | GET | `{"ok":true, "machines":N, "online":N}` |
| `/api/machines` | GET | List connected machines |
| `/api/tools/call` | POST | Invoke a tool on a machine |

## Running smoke tests

```bash
# Manual relay mode:
bash scripts/smoke.sh

# Auto-spawn mode:
bash scripts/smoke-autospawn.sh
bash scripts/smoke-autospawn-e2e.sh
```
