#!/bin/bash
# End-to-end smoke test for omp-teleport.
# Starts the relay, starts a connector, exercises the HTTP and MCP APIs.
cd "$(dirname "$0")/.."

RELAY_PORT=17777
STATE_DIR=/tmp/omp-teleport-smoke
INSTALL_DIR=/tmp/omp-teleport-smoke-connector
LOG_DIR=/tmp/omp-teleport-smoke-logs

pkill -f "relay/src/index.ts" 2>/dev/null || true
pkill -f "connector/connector.py" 2>/dev/null || true
sleep 0.5
rm -rf "$STATE_DIR" "$INSTALL_DIR" "$LOG_DIR"
mkdir -p "$STATE_DIR" "$INSTALL_DIR" "$LOG_DIR"

cleanup() {
  pkill -f "relay/src/index.ts" 2>/dev/null || true
  pkill -f "connector/connector.py" 2>/dev/null || true
}
trap cleanup EXIT

echo "[1/6] start relay"
OMP_REMOTE_STATE_DIR=$STATE_DIR OMP_REMOTE_PORT=$RELAY_PORT OMP_REMOTE_BIND=127.0.0.1 \
  bun relay/src/index.ts > "$LOG_DIR/relay.log" 2>&1 &
RELAY_PID=$!
sleep 2.5
if [ ! -f "$STATE_DIR/state.json" ]; then
  echo "FATAL: relay did not write state.json — see $LOG_DIR/relay.log"
  cat "$LOG_DIR/relay.log"
  exit 1
fi
OP_TOKEN=$(python3 -c "import json; print(json.load(open('$STATE_DIR/state.json'))['operatorTokens'][0]['secret'])")
echo "  relay PID=$RELAY_PID op_token=$OP_TOKEN"

echo
echo "[2/6] omp-teleport install-url prod-db"
INSTALL_URL=$(OMP_REMOTE_RELAY=http://127.0.0.1:$RELAY_PORT OMP_REMOTE_TOKEN=$OP_TOKEN \
  bun cli/omp-teleport.ts install-url prod-db 2>&1 | tail -1)
echo "  install URL: $INSTALL_URL"
JOIN_TOKEN=$(echo "$INSTALL_URL" | sed 's/.*token=//')

echo
echo "[3/6] start connector"
OMP_REMOTE_RELAY=ws://127.0.0.1:$RELAY_PORT/ws/connector \
  OMP_REMOTE_TOKEN=$JOIN_TOKEN \
  OMP_REMOTE_LABEL=prod-db \
  python3 connector/connector.py \
    --relay ws://127.0.0.1:$RELAY_PORT/ws/connector \
    --token "$JOIN_TOKEN" \
    --label prod-db \
    --install-dir "$INSTALL_DIR" \
  > "$LOG_DIR/connector.log" 2>&1 &
CONN_PID=$!
sleep 1.5
echo "  connector PID=$CONN_PID"
echo "  --- connector log ---"
sed 's/^/  /' "$LOG_DIR/connector.log"

echo
echo "[4/6] omp-teleport ls"
OMP_REMOTE_RELAY=http://127.0.0.1:$RELAY_PORT OMP_REMOTE_TOKEN=$OP_TOKEN \
  bun cli/omp-teleport.ts ls

echo
echo "[5/6] tool calls via /api/tools/call (used by the OMP extension)"

call_tool() {
  local name="$1" args="$2" desc="$3"
  local body="{\"name\":\"$name\",\"arguments\":$args}"
  local out
  out=$(curl -s -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $OP_TOKEN" \
    -d "$body" "http://127.0.0.1:$RELAY_PORT/api/tools/call")
  local result
  result=$(echo "$out" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    ok = d.get('ok')
    c = d.get('content', [])
    text = c[0].get('text','') if c else ''
    text = text.replace('\n', ' / ')[:120]
    print(f'ok={ok} text={text!r}')
except Exception as e:
    print(f'PARSE_ERR={e}')
" 2>/dev/null) || result="curl_failed"
  printf "  %-30s %s\n" "$desc" "$result"
}

call_tool "prod_db__bash"  '{"command":"echo SMOKE_OK"}' "bash"
call_tool "prod_db__read"  '{"path":"/etc/hostname"}' "read"
call_tool "prod_db__ls"    '{"path":"/tmp"}' "ls"
call_tool "prod_db__stat"  '{"path":"/etc/hostname"}' "stat"
call_tool "prod_db__grep"  '{"pattern":"127.0.0.1","path":"/etc/hosts"}' "grep"
call_tool "prod_db__glob"  '{"pattern":"/tmp/omp-teleport-smoke*"}' "glob"
call_tool "prod_db__env"   '{"name":"PATH"}' "env"
call_tool "prod_db__write" '{"path":"/tmp/omp-smoke-write.txt","content":"hello"}' "write"
call_tool "prod_db__edit"  '{"path":"/tmp/omp-smoke-write.txt","old_text":"hello","new_text":"HI"}' "edit"
call_tool "prod_db__read"  '{"path":"/tmp/omp-smoke-write.txt"}' "read after edit"
call_tool "prod_db__bash"  '{"command":"exit 42"}' "bash nonzero"
call_tool "no_such__bash"  '{"command":"x"}' "unknown machine"

echo
echo "[6/6] tool call via MCP protocol (for non-OMP harnesses)"
MCP_OUT=$(curl -s -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $OP_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"prod_db__bash","arguments":{"command":"echo MCP_OK"}}}' \
  "http://127.0.0.1:$RELAY_PORT/mcp")
echo "$MCP_OUT" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    if d.get('result'):
        c = d['result'].get('content', [])
        text = c[0].get('text','') if c else ''
        print(f'  result.ok={d[\"result\"].get(\"isError\") is False} text={text!r}')
    else:
        print(f'  error: {d.get(\"error\")}')
except Exception as e:
    print(f'  parse err: {e}')
"

echo
echo "[7/6] tools/list via MCP"
TOOLS_OUT=$(curl -s -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $OP_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "http://127.0.0.1:$RELAY_PORT/mcp")
echo "$TOOLS_OUT" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    tools = d.get('result', {}).get('tools', [])
    print(f'  {len(tools)} tools exposed via MCP:')
    for t in tools:
        print(f'    - {t[\"name\"]}')
except Exception as e:
    print(f'  parse err: {e}')
"

echo
echo "smoke test complete."
