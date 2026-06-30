#!/bin/bash
# Validates the v0.3 default: omp's extension auto-spawns a local relay
# when OMP_REMOTE_RELAY is not set, and tears it down with the session.
set -e
cd "$(dirname "$0")/.."

# Wipe any prior state
pkill -f "relay/src/index.ts" 2>/dev/null || true
pkill -f "omp --mode rpc" 2>/dev/null || true
sleep 0.5
rm -rf ~/.omp-teleport

# 1. Run omp in RPC mode. The extension should auto-spawn a relay.
# Wait long enough for the relay to come up before querying.
{
  sleep 3
  echo '{"id":"1","type":"get_state"}'
  sleep 1
} | timeout 10 omp --mode rpc 2>/dev/null > /tmp/auto.log

echo "--- 1. extension UI: connected notification ---"
grep -oE 'omp-teleport: connected[^"]+' /tmp/auto.log | head -1

echo
echo "--- 2. relay is bound to 0.0.0.0 (visible in process list) ---"
ps -ef | grep "relay/src/index.ts" | grep -v grep | head -1 | awk '{print "  PID="$2, "CMD="$8, $9, $10}'

echo
echo "--- 3. state.json was created with a bootstrap operator token ---"
python3 -c "import json; d=json.load(open('$HOME/.omp-teleport/state.json')); print('  operator:', d['operatorTokens'][0]['secret'][:20]+'…')"

echo
echo "--- 4. all 9 remote tools registered ---"
grep -oE '"name":"remote_[a-z_]+"' /tmp/auto.log | sort -u | sed 's/^/  /'

echo
echo "--- 5. /tp command is registered ---"
grep -oE '"name":"remote","description":"[^"]+' /tmp/auto.log | head -1 | sed 's/^/  /'

echo
echo "--- 6. relay health endpoint responds ---"
curl -s -m 2 http://127.0.0.1:7777/health

echo
echo "--- 7. issuing a token from the auto-spawned relay ---"
OP=$(python3 -c "import json; print(json.load(open('$HOME/.omp-teleport/state.json'))['operatorTokens'][0]['secret'])")
INSTALL=$(curl -s -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $OP" -d '{"label":"auto-test"}' http://127.0.0.1:7777/api/tokens | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['install_url'])")
echo "  install URL: $INSTALL"
echo
echo "  (URL should use the public base set via OMP_REMOTE_PUBLIC_URL,"
echo "   or the auto-detected box IP if none was set)"

# Cleanup
pkill -f "relay/src/index.ts" 2>/dev/null || true
echo
echo "v0.3 auto-spawn smoke test complete."
