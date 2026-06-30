# omp-teleport

`curl | sh` → an OMP agent on a remote machine (Linux, macOS, Windows, Android).

omp-teleport lets you drop a one-liner on any Linux/macOS box, then drive
that box from your local OMP TUI as if OMP were running there. All tool
calls (`bash`, `read`, `edit`, …) execute on the remote; the model and
session stay on your machine.

```
your OMP TUI  ─►  relay (Bun, local or remote)  ─►  connector (Python, on remote)
                          ▲
                          │
                       MCP server
                          ▲
                          │
                  Claude Code / Codex / anything
```

## What you get

- **One connector script** (Python 3 stdlib, ~700 lines, no deps). Talks
  WebSocket outbound — works on hosts that only allow egress.
- **A relay server** (Bun, single binary). Holds the machines, exposes
  MCP for any harness, and an HTTP API for tighter integrations.
- **An OMP extension** that registers `remote_bash`, `remote_read`,
  `remote_write`, `remote_edit`, `remote_glob`, `remote_grep`,
  `remote_ls`, `remote_stat`, `remote_env` and forwards each call to
  the relay. Plus a `/tp` slash command for managing machines and
  tokens, and a live status widget above the editor.
- **A `omp-teleport` CLI** to manage a separately-run relay (issue
  tokens, list machines).
- **An MCP server** at `/mcp` so any MCP-capable harness (Claude Code,
  Codex CLI, etc.) gets the same tools with zero extra code.

## Quickstart (zero-config)

By default, OMP auto-spawns a local relay on first use and tears it
down with the session. You don't need to install or run anything
separately:

```bash
# Just run omp. The extension spawns a relay on 127.0.0.1:7777
# bound to 0.0.0.0, with OMP_REMOTE_PUBLIC_URL auto-set to your
# box's primary network IP.
omp

# Mint a join token from inside the TUI:
/tp token my-server
# → http://45.83.179.102:7777/sh
```

Then on the remote machine:

```bash
curl -sSL 'http://45.83.179.102:7777/sh' | sh -
```

The auto-spawned relay binds `0.0.0.0:7777` by default, so the remote
can reach it on the OMP box's primary IP. The install URL embeds
that IP via `OMP_REMOTE_PUBLIC_URL` (auto-detected from the box's
primary IPv4 interface). Override it when the remote is on a
different network:

```bash
# Example: relay is reachable via a tunnel at https://relay.example.com
OMP_REMOTE_PUBLIC_URL=https://relay.example.com omp
```

The extension spawns the relay by finding `relay/src/index.ts`

### Windows Installation

For Windows machines, use the PowerShell installer:

```powershell
# From PowerShell (no admin rights needed):
irm 'http://45.83.179.102:7777/psh' | iex
```

Or use the `/psh` command in the TUI to get the Windows install URL:

```bash
/psh          # show Windows install URL
/psh help     # show detailed help
```

The Windows installer will:
- Download and install a portable Python runtime if Python is not found
- Download and run the connector
- Create a persistent connection to the relay
- Work without administrator privileges

**Requirements:**
- Windows 10/11 or Windows Server 2016+
- PowerShell 5.1+ (included with Windows)
- No administrator rights required

### macOS Installation

macOS works with the standard `/sh` installer:

```bash
curl -sSL 'http://45.83.179.102:7777/sh' | sh -
```

### Android Installation

Android works via Termux (no root required):

```bash
# Install Termux from F-Droid (not Play Store)
# Then in Termux:
pkg install python
curl -sSL 'http://45.83.179.102:7777/sh' | sh -
```

**Requirements:**
- Termux from F-Droid
- Python package installed (`pkg install python`)
- No root required
relative to the extension file (or via the `OMP_REMOTE_RELAY_ENTRY`
env var if installed somewhere else). If the relay is already
running on the configured URL, the extension reuses it instead of
spawning a new one.

### What you get for free with the default

- **`/tp ls`** — list connected machines in the TUI
- **`/tp pick`** — interactive machine picker that injects
  `machine: "<label>" ` into the editor
- **`/tp token <label> [ttl_sec]`** — mint a join token, print the
  install URL
- **`/tp refresh`** — re-poll the machine list
- **Live status widget** above the editor showing the relay URL and
  the online/total machine count, updated on every connect/disconnect

## Optional: explicit remote relay

If you'd rather run the relay as a separate service (cloud, shared
team relay, a long-lived systemd unit), point OMP at it explicitly
via `OMP_REMOTE_RELAY`. The extension skips auto-spawn when this is
set.

```bash
# Set these in your shell (or in ~/.omp/agent/config.yml):
export OMP_REMOTE_RELAY=https://relay.example.com
export OMP_REMOTE_TOKEN=ot_xxxxxxxxxxxxxxxx
omp
```

To run the relay as a separate process:

```bash
# In this repo:
cd relay
bun install
bun run src/index.ts
```

First run prints a bootstrap operator token (also persisted to
`~/.omp-teleport/state.json`):

```
created bootstrap operator token: ot_xxxxxxxxxxxxxxxx
set it as OMP_REMOTE_TOKEN for the OMP extension.
```

The CLI can mint install URLs against a running relay:

```bash
OMP_REMOTE_RELAY=http://127.0.0.1:7777 OMP_REMOTE_TOKEN=ot_xxx... \
  bun cli/omp-teleport.ts install-url prod-db
# → http://127.0.0.1:7777/sh
```

`ttl_sec` is optional (default = no expiry; one-shot after first use).

State (tokens, machine list) lives in `~/.omp-teleport/state.json` by
default; override with `OMP_REMOTE_STATE_DIR`. The relay binds
`0.0.0.0:7777` by default; override with `OMP_REMOTE_BIND`. The
default public URL embedded in install scripts is auto-detected from
the box's primary network IP; override with `OMP_REMOTE_PUBLIC_URL`.

## Plug other harnesses via MCP

Any MCP-capable harness can point at `<relay>/mcp` with
`Authorization: Bearer ot_xxx…`. Tools appear as
`<safeLabel>__<tool>`, e.g. `prod_db__bash`. The harness sees
machines join/leave via `notifications/tools/list_changed` (open the
SSE listener on the same URL via GET).

## Architecture

```
connector.py (Python)              relay (Bun)                 harness (OMP, Claude Code, …)
       │                                │                                 │
       │   WS /ws/connector             │                                 │
       │   Sec-WebSocket-Protocol:      │                                 │
       │     bearer.<join_token>        │                                 │
       │ ──────────────────────────────►│                                 │
       │                                │                                 │
       │   {type:"register",label,…}    │                                 │
       │ ──────────────────────────────►│                                 │
       │                                │  MCP initialize                 │
       │                                │ ◄────────────────────────────── │
       │                                │  MCP tools/list                 │
       │                                │ ◄────────────────────────────── │
       │                                │                                 │
       │                                │  MCP tools/call                 │
       │                                │   {name:"prod_db__bash",…}      │
       │                                │ ◄────────────────────────────── │
       │   {type:"tool.call",…}         │                                 │
       │ ◄──────────────────────────────│                                 │
       │                                │                                 │
       │   {type:"tool.result",…}       │                                 │
       │ ──────────────────────────────►│  MCP response                   │
       │                                │ ──────────────────────────────►│
```

See `PROTOCOL.md` for the full wire-level spec.

## Wire protocol summary

| Surface | Transport | Format | Auth |
|---|---|---|---|
| Connector ↔ relay | WebSocket `/ws/connector` | JSON text frames | `Sec-WebSocket-Protocol: bearer.<jt_…>` (one-shot join token) |
| Harness ↔ relay | Streamable HTTP `/mcp` | JSON-RPC 2.0 | `Authorization: Bearer <ot_…>` |
| OMP extension ↔ relay | HTTP `/api/*` | JSON over HTTP | `Authorization: Bearer <ot_…>` |

Tokens:
- `jt_<base64>` — join token, one-shot, used by the connector
- `ot_<base64>` — operator token, long-lived, used by harnesses

## Tool surface

The connector implements nine tools, all returning
`{content: [{type: "text", text: "..."}], isError: bool}`:

| Tool | Args | Result text |
|---|---|---|
| `bash` | `command`, `cwd?`, `timeout?` (sec, default 30) | combined stdout+stderr + `[exit: N]` |
| `read` | `path`, `offset?`, `limit?` (bytes) | file contents (capped at 4MB) |
| `write` | `path`, `content` | `"wrote N bytes"` |
| `edit` | `path`, `old_text`, `new_text`, `replace_all?` | `"patched"` |
| `glob` | `pattern`, `cwd?` | newline-separated paths |
| `grep` | `pattern`, `path`, `include?`, `max_count?` | `path:line:match` lines |
| `ls` | `path` | `kind size name` lines |
| `stat` | `path` | one-line summary |
| `env` | `name?` | single value or all env |

MCP names are `<safeLabel>__<tool>` (e.g. `prod_db__bash`). OMP
extension names are flat `remote_<tool>` with a `machine` arg.

## OMP slash commands

| Command | Effect |
|---|---|
| `/tp ls` | list connected machines (marks the active one) |
| `/tp pick` | interactive machine picker; injects `machine: "<label>" ` into the editor |
| `/tp token <label> [ttl_sec]` | mint a join token, print the install URL |
| `/tp refresh` | re-poll `/api/machines` |
| `/tp connect <machine>` | enter remote-only mode (hides local filesystem tools; sets active machine) |
| `/tp disconnect` | exit remote-only mode (restores all local tools) |
## CLI

```bash
omp-teleport start                            # start the relay in the foreground
omp-teleport token <label> [ttl_sec]          # mint a join token, print the install URL
omp-teleport install-url <label> [ttl_sec]    # same as `token` but only print the URL
omp-teleport ls                               # list connected machines
omp-teleport operators                        # list operator tokens
omp-teleport config                           # print resolved relay URL + operator token
```

## Environment

| Var | Default | Notes |
|---|---|---|
| `OMP_REMOTE_RELAY` | (auto-spawn) | explicit relay URL; skips auto-spawn when set |
| `OMP_REMOTE_TOKEN` | (auto-discover) | operator token for the extension / CLI |
| `OMP_REMOTE_PORT` | `7777` | port for the auto-spawned relay |
| `OMP_REMOTE_BIND` | `0.0.0.0` | bind address for the auto-spawned relay |
| `OMP_REMOTE_PUBLIC_URL` | (auto-detect) | base URL embedded in install URLs |
| `OMP_REMOTE_STATE_DIR` | `~/.omp-teleport` | where the relay persists tokens + machine list |
| `OMP_REMOTE_RELAY_ENTRY` | (auto-detect) | path to `relay/src/index.ts` for the auto-spawn |
| `OMP_REMOTE_LABEL` | hostname | label for the connector (install side) |

## Running the smoke tests

```bash
# 1. Manual relay mode (starts relay explicitly):
bash scripts/smoke.sh

# 2. Auto-spawn mode (no manual relay start; the extension spawns one):
bash scripts/smoke-autospawn.sh
bash scripts/smoke-autospawn-e2e.sh
```

`smoke.sh` starts the relay, drops a connector that registers as
`prod-db`, exercises all nine tools over both HTTP and MCP, and prints
the result.

## v0.3 changelog

- **Auto-spawn relay as the default.** If `OMP_REMOTE_RELAY` isn't
  set, the extension spawns a local relay on first use and tears it
  down with the session. The relay binds `0.0.0.0:7777` by default
  (was `127.0.0.1`) and the public base URL is auto-detected from the
  box's primary network interface. Override with `OMP_REMOTE_PUBLIC_URL`
  for tunneled/cloud setups.
- **Explicit-mode support.** Set `OMP_REMOTE_RELAY` to a running
  relay (cloud, shared, systemd) and the extension skips auto-spawn.
- **`OMP_REMOTE_RELAY_ENTRY`** env var to point the auto-spawn at a
  custom path for `relay/src/index.ts`.

## v0.4 changelog

- **Active-machine mode with tool-registry filtering.** `/tp
  connect <machine>` now enters a remote-only mode that physically
  hides local filesystem tools (bash, read, write, edit, glob, grep,
  ls, stat, env, plus browser, debug, eval, lsp, ast_grep, ast_edit,
  task, job, irc) from the model via `setActiveTools`. The model
  literally cannot call them. The remote tools (`remote_*`) and a
  small set of safe globals (ask, resolve, todo, web_search, etc.)
  remain. `/tp disconnect` restores the full local tool set.
- **Optional `machine` arg.** With an active remote connection, the
  `machine` argument on every `remote_*` tool becomes optional and
  defaults to the active machine. In default mode the model still
  sees both local and remote tools and can call either; the user
  uses `/tp pick` to inject a `machine: "<label>"` token into
  the editor.
- **No system-prompt manipulation.** The model is not told it is on
  the remote; the tools and their results are the only source of
  truth. Architecture alone enforces the boundary.

## v0.2 changelog

- TUI status widget above the editor: shows relay URL and the live
  list of online machines. Updates on every connect/disconnect via
  the relay's SSE event stream.
- `/tp pick` — interactive machine picker; injects
  `machine: "<label>" ` into the editor.
- Cancellation plumbing end-to-end: OMP signal → extension fetch
  abort → relay `req.signal.abort` → connector `tool.cancel` over WS.
- Fixed label-lookup inconsistency: HTTP and MCP APIs both normalize
  via `safeLabel` so `prod-db` and `prod_db` both resolve to the same
  machine.

## What's not here yet

Deferred to v0.4+:
- **Streaming output** for long-running bash. The connector can
  stream per-line via `tool.progress` frames; plumbing through the
  relay to the harness (OMP `onUpdate`, MCP streamable response) is
  the next piece. The relay currently buffers to a single final
  result.
- **PTY support** for interactive bash.
- **File upload/download** tools.
- **Authenticated WebSocket** for operator tokens (join-only today).
- **Persisted machine identity** on the remote (connector forgets
  machine-id on restart; reconnect gets a new one).
- **systemd / launchd** install scripts.
- **Tunnel auto-setup** (e.g., spawn `cloudflared` and surface the
  public URL).

## License

Pick your favorite; this is a reference implementation.
