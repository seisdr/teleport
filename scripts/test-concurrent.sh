#!/bin/bash
# Tests:
#   1. Bash tool's timeout (per-call) propagates from model arg to subprocess
#   2. Multiple concurrent tool calls run in parallel
#   3. Default timeouts (model doesn't pass) match across layers
set -e
cd "$(dirname "$0")/.."

pkill -f "relay/src/index.ts" 2>/dev/null || true
pkill -f "connector/connector.py" 2>/dev/null || true
sleep 0.5
rm -rf /tmp/omp-test-state /tmp/omp-test-conn

echo "=== 1. start relay ==="
OMP_REMOTE_STATE_DIR=/tmp/omp-test-state OMP_REMOTE_PORT=18777 OMP_REMOTE_BIND=127.0.0.1 \
  bun relay/src/index.ts > /tmp/relay-test.log 2>&1 &
sleep 2
OP=$(python3 -c "import json; print(json.load(open('/tmp/omp-test-state/state.json'))['operatorTokens'][0]['secret'])")
JOIN=$(curl -s -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $OP" -d '{"label":"concurrent-test"}' http://127.0.0.1:18777/api/tokens | python3 -c "import json,sys; print(json.load(sys.stdin)['token']['secret'])")
WS_URL=$(curl -s "http://127.0.0.1:18777/sh?token=$JOIN" | grep "RELAY_WS=" | head -1 | sed 's/RELAY_WS="//;s/"$//')
python3 connector/connector.py --relay "$WS_URL" --token "$JOIN" --label concurrent-test --install-dir /tmp/omp-test-conn > /tmp/conn-test.log 2>&1 &
CONN_PID=$!
sleep 1.5
echo "  connector: $(ps -p $CONN_PID >/dev/null && echo up || echo DOWN)"

call() {
	local name="$1" args="$2" desc="$3"
	local start=$(date +%s%N)
	local out
	out=$(curl -s -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $OP" \
		-d "{\"name\":\"$name\",\"arguments\":$args}" \
		http://127.0.0.1:18777/api/tools/call)
	local end=$(date +%s%N)
	local elapsed=$(( (end - start) / 1000000 ))
	local ok
	ok=$(echo "$out" | python3 -c "import json,sys; print(json.load(sys.stdin).get('ok'))" 2>/dev/null)
	local text
	text=$(echo "$out" | python3 -c "import json,sys; d=json.load(sys.stdin); c=d.get('content',[]); print(c[0].get('text','') if c else '')" 2>/dev/null | tr -d '\n' | head -c 80)
	printf "  %-35s ok=%-5s elapsed=%6dms  %s\n" "$desc" "$ok" "$elapsed" "$text"
}

echo
echo "=== 2. timeout propagation: model passes timeout=2, should fire at ~2s not 60s ==="
call "concurrent_test__bash" '{"command":"sleep 5","timeout":2}' "bash timeout=2"
call "concurrent_test__bash" '{"command":"echo hi","timeout":1}' "bash timeout=1 (no sleep)"

echo
echo "=== 3. default timeouts: model doesn't pass timeout, bash default=30, relay default=60 ==="
call "concurrent_test__bash" '{"command":"echo quick"}' "bash no timeout"

echo
echo "=== 4. multiple concurrent tool calls: 3 in parallel should overlap, not serialize ==="
START=$(date +%s%N)
# Fire 3 calls in background, each sleeps 1s
for i in 1 2 3; do
	curl -s -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $OP" \
		-d "{\"name\":\"concurrent_test__bash\",\"arguments\":{\"command\":\"echo call$i; sleep 1; echo done$i\"}}" \
		http://127.0.0.1:18777/api/tools/call > /tmp/concurrent-$i.json &
done
wait
END=$(date +%s%N)
ELAPSED=$(( (END - START) / 1000000 ))
echo "  3 concurrent sleep-1s calls: elapsed=${ELAPSED}ms (expected ~1000-1500ms, NOT 3000ms)"
for i in 1 2 3; do
	ok=$(python3 -c "import json; print(json.load(open('/tmp/concurrent-$i.json')).get('ok'))" 2>/dev/null)
	text=$(python3 -c "import json; d=json.load(open('/tmp/concurrent-$i.json')); c=d.get('content',[]); print(c[0].get('text','').strip() if c else '')" 2>/dev/null | head -1)
	printf "  call%d ok=%s  %s\n" "$i" "$ok" "$text"
done

echo
echo "=== 5. different tool types concurrently ==="
# bash + read at the same time
{
	curl -s -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $OP" \
		-d '{"name":"concurrent_test__bash","arguments":{"command":"sleep 1; echo bash-done"}}' \
		http://127.0.0.1:18777/api/tools/call > /tmp/c-bash.json &
	curl -s -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $OP" \
		-d '{"name":"concurrent_test__read","arguments":{"path":"/etc/hostname"}}' \
		http://127.0.0.1:18777/api/tools/call > /tmp/c-read.json &
	wait
}
ELAPSED=$(( ( $(date +%s%N) - $(date +%s%N) + 1500000000 ) / 1000000 ))
ok1=$(python3 -c "import json; print(json.load(open('/tmp/c-bash.json')).get('ok'))" 2>/dev/null)
ok2=$(python3 -c "import json; print(json.load(open('/tmp/c-read.json')).get('ok'))" 2>/dev/null)
echo "  bash: ok=$ok1"
echo "  read: ok=$ok2"

# cleanup
kill $CONN_PID 2>/dev/null || true
pkill -f "relay/src/index.ts" 2>/dev/null || true
pkill -f "connector/connector.py" 2>/dev/null || true
wait 2>/dev/null

echo
echo "done."
