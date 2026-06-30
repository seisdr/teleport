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
print("DONE")
