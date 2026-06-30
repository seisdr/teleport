# Wire Protocol (v0.1)

Two surfaces:

1. **Connector ↔ Relay** — WebSocket, JSON text frames. One WS per connector.
2. **Relay ↔ Harness** — MCP (JSON-RPC 2.0) over Streamable HTTP. Tools are dynamic per connected machine.

All frames are newline-delimited or per-message JSON. No binary payloads.

## Auth

Two token classes, both opaque strings:

- **join token** (`jt_…`) — single-use, embeds machine label and optional TTL. Used by connector on first connect.
- **operator token** (`ot_…`) — long-lived, full control. Used by the OMP extension and `omp-remote` CLI.

Tokens are sent in the WebSocket subprotocol header (`Sec-WebSocket-Protocol: bearer.<token>`) or in the `Authorization: Bearer …` HTTP header. The relay normalizes both.

## Connector messages (relay-bound)

### `register` (connector → relay)

```json
{
  "type": "register",
  "hostname": "db-prod-01",
  "os": "linux",
  "arch": "x64",
  "label": "prod db primary",
  "version": "0.1.0",
  "capabilities": {
    "tools": ["bash", "read", "write", "edit", "glob", "grep", "ls", "stat", "env"],
    "max_concurrent": 4,
    "supports_progress": true,
    "supports_cancel": true
  }
}
```

### `registered` (relay → connector)

```json
{ "type": "registered", "machine_id": "m_abc123", "heartbeat_ms": 15000 }
```

### `tool.call` (relay → connector)

```json
{ "type": "tool.call", "id": "t_xyz", "name": "bash", "args": {"command": "ls /", "timeout": 30}, "timeout_ms": 30000 }
```

### `tool.progress` (connector → relay, optional)

```json
{ "type": "tool.progress", "id": "t_xyz", "delta": "stdout chunk..." }
```

### `tool.result` (connector → relay)

```json
{ "type": "tool.result", "id": "t_xyz", "ok": true, "content": [{"type": "text", "text": "bin\netc\nhome\n"}], "duration_ms": 42 }
```

Or on error:

```json
{ "type": "tool.result", "id": "t_xyz", "ok": false, "error": "exit code 2", "content": [{"type": "text", "text": "ls: cannot access …"}] }
```

### `tool.cancel` (relay → connector)

```json
{ "type": "tool.cancel", "id": "t_xyz" }
```

### `ping` / `pong` (both)

```json
{ "type": "ping", "t": 1735689600000 }
{ "type": "pong", "t": 1735689600000 }
```

### `disconnect` (relay → connector, grace)

```json
{ "type": "disconnect", "reason": "relay_shutdown" }
```

## Tool surface (connector side)

All tools return `content: [{type: "text", text: "..."}]` plus optional `is_error: true` on failure. Args are JSON objects.

| Tool       | Args                                                                 | Result text                                    |
|------------|----------------------------------------------------------------------|------------------------------------------------|
| `bash`     | `command: str`, `cwd?: str`, `timeout?: int` (sec, default 30)       | stdout+stderr combined, then `[exit: N]`      |
| `read`     | `path: str`, `offset?: int`, `limit?: int`                            | file content                                   |
| `write`    | `path: str`, `content: str`                                          | `"wrote <N> bytes"`                            |
| `edit`     | `path: str`, `old_text: str`, `new_text: str` (or `replace_all: bool`) | `"patched"` or diff                            |
| `glob`     | `pattern: str`, `cwd?: str`                                          | newline-separated paths                        |
| `grep`     | `pattern: str`, `path: str`, `include?: str`, `max_count?: int`      | `path:line:match` lines                        |
| `ls`       | `path: str`                                                          | newline-separated entries (`name\tkind\tsize`) |
| `stat`     | `path: str`                                                          | one-line summary                               |
| `env`      | `name?: str`                                                         | one env var per line, or single value          |

Future: `upload`, `download`, `pty`, `process_kill`, `port_forward`.

## MCP surface (harness-bound)

Tools are registered dynamically per connected machine. Naming:

- `<machine_id>.<tool>` — the canonical name, e.g. `m_abc123.bash`
- For OMP, names flatten to `<machine_label>__<tool>` (e.g. `db-prod-01__bash`) so they look like normal OMP tool calls.

Each tool's input schema matches the connector tool's args. Output is a single `text` content block.

`tools/list` returns all `(machine, tool)` pairs currently reachable. `notifications/tools/list_changed` fires when a machine connects or disconnects.

## Lifecycle

```
[connector]                          [relay]                            [harness]
    |  WS open + auth (jt_…)            |                                    |
    | --- register -------------------> |                                    |
    | <-- registered (machine_id) ---- |                                    |
    |                                   |  tools/list_changed  (if first)    |
    |                                   | -- mcp notifications/tools/list_changed -->
    |                                   |                                    |
    | <-- tool.call ------------------ | <-- tools/call ------------------- |
    |     (id, name, args)              |                                    |
    | --- tool.progress (optional) ---> |                                    |
    | --- tool.result ----------------> | --- tools/call result ----------> |
    |                                   |                                    |
    | <-- disconnect (grace) ---------- |                                    |
    |  WS close                         |                                    |
```

## Failure model

- Connector WS dies: relay marks machine `offline` after `2 * heartbeat_ms` of silence. Emits `tools/list_changed`.
- Relay dies: connectors reconnect with exponential backoff (1s, 2s, 4s, 8s, max 30s).
- Tool call timeout: relay cancels in-flight call; returns `isError: true` to harness.
- Tool call on offline machine: relay returns `isError: true` with `machine offline`.
