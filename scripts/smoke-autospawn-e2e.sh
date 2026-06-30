#!/bin/bash
# End-to-end test: omp auto-spawns the relay, the user mints a token,
# the connector runs against the install URL, and a tool call round-trips.
cd "$(dirname "$0")/.."

pkill -f "relay/src/index.ts" 2>/dev/null || true
pkill -f "omp --mode rpc" 2>/dev/null || true
pkill -f "connector/connector.py" 2>/dev/null || true
sleep 0.5
rm -rf ~/.omp-teleport /tmp/auto-conn

# Start omp in RPC mode (auto-spawns the relay). Keep it running for
# the duration of the test.
{
  sleep 3
  echo '{"id":"1","type":"get_state"}'
  sleep 8
} | timeout 18 omp --mode rpc 2>/dev/null > /tmp/auto-rpc.log &
OMP_PID=$!
sleep 5

# Wait for the relay to come up
for i in 1 2 3 4 5 6 7 8 9 10; do
  if [ -f "$HOME/.omp-teleport/state.json" ]; then break; fi
  sleep 1
done
if [ ! -f "$HOME/.omp-teleport/state.json" ]; then
  echo "FATAL: relay did not write state.json in time"
  kill $OMP_PID 2>/dev/null
  cat /tmp/auto-rpc.log
  exit 1
fi

echo "[1/3] read the auto-spawned relay's state and mint a join token"
OP=$(python3 -c "import json; print(json.load(open('$HOME/.omp-teleport/state.json'))['operatorTokens'][0]['secret'])")
JOIN=$(curl -s -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $OP" -d '{"label":"e2e-auto"}' http://127.0.0.1:7777/api/tokens | python3 -c "import json,sys; print(json.load(sys.stdin)['token']['secret'])")
echo "  join token: $JOIN"

echo "[2/3] start the connector (using the install URL's host)"
WS_URL=$(curl -s "http://127.0.0.1:7777/sh?token=$JOIN" | grep -E "RELAY_WS=" | head -1 | sed 's/RELAY_WS="//;s/"$//')
echo "  connector WS URL: $WS_URL"
python3 connector/connector.py \
  --relay "$WS_URL" \
  --token "$JOIN" \
  --label e2e-auto \
  --install-dir /tmp/auto-conn \
  > /tmp/auto-conn.log 2>&1 &
CONN_PID=$!
sleep 1.5
echo "  --- connector log ---"
sed 's/^/    /' /tmp/auto-conn.log

echo "[3/3] exercise a tool call through the auto-spawned relay → connector"
curl -s -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $OP" \
  -d '{"name":"e2e_auto__bash","arguments":{"command":"echo AUTO_SPAWN_OK; hostname"}}' \
  http://127.0.0.1:7777/api/tools/call | python3 -m json.tool

# Cleanup
kill $OMP_PID 2>/dev/null || true
kill $CONN_PID 2>/dev/null || true
pkill -f "relay/src/index.ts" 2>/dev/null || true
pkill -f "connector/connector.py" 2>/dev/null || true
wait 2>/dev/null

echo
echo "auto-spawn end-to-end smoke complete."
