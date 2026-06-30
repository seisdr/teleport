# teleport

Run tools on any machine you can reach via HTTP.

```
your harness ──► relay (Bun) ◄── connector (Python) ◄── remote machine
                          │
                          ▼
                   MCP server (/mcp)
```

## Install

```bash
# Linux, macOS, Android (Termux):
curl -sSL 'http://<relay>:7777/sh' | sh -

# Windows (PowerShell, no admin):
irm 'http://<relay>:7777/psh' | iex
```

The installer finds Python or downloads a portable one. No root/admin needed.

## Slash commands

| Command | Effect |
|---|---|
| `/tp ls` | list connected machines |
| `/tp connect <label>` | hide local tools, use remote |
| `/tp disconnect` | restore local tools |
| `/tp pick` | interactive picker → connect |
| `/tp refresh` | re-poll machines |
| `/tp restart` | reconnect relay |
| `/tp force [on\|off]` | alias `bash`→`remote_bash` etc. |

## Tools

`bash`, `read`, `write`, `edit`, `glob`, `grep`, `ls`, `stat`, `env`

## HTTP endpoints

| Route | Description |
|---|---|
| `/sh` | shell install script |
| `/psh` | PowerShell install script |
| `/connector.py` | connector source |
| `/mcp` | MCP server (not yet routed) |
| `/ws/connector` | connector WebSocket |
| `/health` | `{"ok":true, "machines":N, "online":N}` |
| `/api/machines` | list machines |
| `/api/tools/call` | invoke tool |

## Env

| Var | Default |
|---|---|
| `OMP_REMOTE_RELAY` | (auto-spawn) |
| `OMP_REMOTE_PORT` | `7777` |
| `OMP_REMOTE_BIND` | `0.0.0.0` |
| `OMP_REMOTE_STATE_DIR` | `~/.omp-teleport` |
| `OMP_REMOTE_TOKEN` | (optional) |
| `OMP_REMOTE_PUBLIC_URL` | (empty) |
| `OMP_REMOTE_LABEL` | hostname |
| `OMP_REMOTE_INSTALL_DIR` | `~/.omp-teleport` |

## Run relay

```bash
cd relay && bun install && bun run src/index.ts
```

## CLI

```bash
omp-teleport start
omp-teleport token <label>
omp-teleport ls
omp-teleport config
```
