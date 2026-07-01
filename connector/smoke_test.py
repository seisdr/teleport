"""Smoke-test the connector's tool functions in isolation, no network."""
import os
import sys
import threading
sys.path.insert(0, os.path.join(os.path.dirname(__file__)))
import connector as c

ev = threading.Event()
ctx = c.ToolCtx(ev)

def run(name, args):
    try:
        out = c.TOOLS[name](args, ctx)
        if isinstance(out, tuple):
            content, is_err = out
        else:
            content, is_err = out, False
        print(f"--- {name} ({'ERR' if is_err else 'OK'}) ---")
        for blk in content:
            print(blk.get("text", "")[:600])
    except Exception as e:
        print(f"--- {name} EXC: {type(e).__name__}: {e} ---")

# bash
run("bash", {"command": "echo hello; echo world 1>&2; exit 0"})
# bash with cwd
run("bash", {"command": "pwd", "cwd": os.path.expanduser("~")})
# read
import tempfile
with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as t:
    t.write("alpha\nbeta\ngamma\n")
    tp = t.name
run("read", {"path": tp})
run("read", {"path": tp, "offset": 2, "limit": 4})
# write
wp = os.path.join(tempfile.gettempdir(), "omp_remote_test.txt")
run("write", {"path": wp, "content": "written by test\n"})
# edit
run("edit", {"path": wp, "old_text": "written", "new_text": "EDITED"})
run("read", {"path": wp})
# glob
run("glob", {"pattern": os.path.join(tempfile.gettempdir(), "omp_remote_test*")})
# grep
run("grep", {"pattern": "EDITED", "path": wp})
# ls
run("ls", {"path": os.path.dirname(wp)})
# stat
run("stat", {"path": wp})
# env
run("env", {"name": "PATH"})
os.unlink(tp)
os.unlink(wp)

# --- concurrency limit ---
print(f"--- max_concurrent (limit={c.MAX_CONCURRENT}) ---")

class MockWS:
    def __init__(self):
        self.sent = []
        self.closed = False
    def send(self, data):
        self.sent.append(data)
    def close(self, code=1000, reason=""):
        self.closed = True

conn = c.Connector("ws://x", None, "test")
# Fill active_calls to MAX_CONCURRENT
for i in range(c.MAX_CONCURRENT):
    conn._active_calls[f"t_{i}"] = (threading.Event(), threading.Thread(target=lambda: None))

ws = MockWS()
# Send one more — should be rejected
conn._handle(ws, {"type": "tool.call", "id": "t_over", "name": "bash",
                    "args": {"command": "echo hi"}})

rejected = [m for m in ws.sent if isinstance(m, dict) and m.get("type") == "tool.result" and not m.get("ok")]
assert len(rejected) == 1, f"expected 1 rejection, got {len(rejected)}"
assert "too many concurrent" in rejected[0]["error"], f"unexpected error: {rejected[0].get('error')}"
print(f"  rejected correctly: {rejected[0]['error']}")

# Clean up active calls so Connector can shut down
conn._active_calls.clear()
print("  OK")

print("DONE")
