#!/usr/bin/env python3
"""
omp-teleport connector (v0.5)

Single-file Python 3 tool executor that connects outbound to a relay over
WebSocket and executes tool calls locally. Stdlib only.

Usage:
    connector.py --relay wss://relay.example.com/ws --token jt_abc... [--label NAME] [--install-dir DIR]

Environment:
    OMP_REMOTE_RELAY  override --relay
    OMP_REMOTE_TOKEN  override --token
    OMP_REMOTE_LABEL  override --label
"""
from __future__ import annotations

import argparse
import base64
import contextlib
import glob as _glob
import hashlib
import json
import mimetypes
import os
import re
import secrets
import shutil
import signal
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
import uuid


def _read_hwid() -> str:
	"""Deterministic hardware ID. Same machine always returns the same value."""
	# Windows: use MachineGuid from registry
	if sys.platform == "win32":
		try:
			import winreg
			key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Cryptography")
			guid, _ = winreg.QueryValueEx(key, "MachineGuid")
			winreg.CloseKey(key)
			if guid:
				return hashlib.sha256(guid.encode()).hexdigest()[:16]
		except Exception:
			pass
		# Fallback: hash of hostname + MAC via uuid
		try:
			mac = uuid.getnode()
			raw = socket.gethostname() + str(mac)
			return hashlib.sha256(raw.encode()).hexdigest()[:16]
		except Exception:
			return hashlib.sha256(socket.gethostname().encode()).hexdigest()[:16]
	
	# macOS: use IOPlatformUUID
	if sys.platform == "darwin":
		try:
			r = subprocess.run(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
			                   capture_output=True, text=True, timeout=5)
			for line in r.stdout.splitlines():
				if "IOPlatformUUID" in line:
					return line.split('"')[1] if '"' in line else line.split("=")[1].strip()
		except Exception:
			pass
	
	# Linux: use machine-id
	try:
		for p in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
			if os.path.exists(p):
				with open(p) as f:
					hwid = f.read().strip()
				if hwid:
					return hwid
	except Exception:
		pass
	
	# Fallback: hash of hostname + MAC
	try:
		mac = ""
		if sys.platform == "linux":
			for iface in sorted(os.listdir("/sys/class/net/")):
				p = f"/sys/class/net/{iface}/address"
				if os.path.exists(p):
					with open(p) as f:
						m = f.read().strip()
					if m and m != "00:00:00:00:00:00":
						mac = m
						break
		else:
			mac = str(uuid.getnode())
		raw = socket.gethostname() + mac
		return hashlib.sha256(raw.encode()).hexdigest()[:16]
	except Exception:
		return hashlib.sha256(socket.gethostname().encode()).hexdigest()[:16]

def _truncate(text: str, n: int = 200) -> str:
	return text if len(text) <= n else text[:n] + f"\n[truncated {len(text) - n} bytes]"


def _tool_summary(name: str, args: dict) -> str:
	if name == "bash":
		cmd = str(args.get("command", ""))
		return repr(cmd) if len(cmd) <= 120 else repr(cmd[:120]) + "…"
	if name in ("read", "write", "edit", "stat", "ls"):
		return str(args.get("path", ""))
	if name == "glob":
		return str(args.get("pattern", ""))
	if name == "grep":
		return f"{args.get('pattern', '')} in {args.get('path', '.')}"
	if name == "env":
		return str(args.get("name", "(all)"))
	return ""


import threading
from queue import Queue, Empty

def tool_bash(args: dict, ctx: ToolCtx) -> tuple[list[dict], bool]:
	command = args.get("command")
	if not isinstance(command, str) or not command.strip():
		raise ValueError("bash.command must be a non-empty string")
	cwd = args.get("cwd") or os.getcwd()
	timeout = int(args.get("timeout") or DEFAULT_BASH_TIMEOUT)
	timeout = max(1, min(timeout, MAX_BASH_TIMEOUT))

	if not os.path.isdir(cwd):
		raise FileNotFoundError(f"cwd not found: {cwd}")

	# Windows: use CREATE_NEW_PROCESS_GROUP, Unix: use start_new_session
	if sys.platform == "win32":
		proc = subprocess.Popen(
			command,
			shell=True,
			cwd=cwd,
			stdout=subprocess.PIPE,
			stderr=subprocess.STDOUT,
			text=True,
			bufsize=1,
			creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
		)
	else:
		proc = subprocess.Popen(
			command,
			shell=True,
			cwd=cwd,
			stdout=subprocess.PIPE,
			stderr=subprocess.STDOUT,
			text=True,
			bufsize=1,
			start_new_session=True,
		)

	# Read on a dedicated thread so the main loop can do timeout-aware
	# queue.get() — the timeout fires whether or not the subprocess writes.
	q: Queue = Queue(maxsize=1024)
	READER_ERROR: list = [None]

	def reader() -> None:
		try:
			for line in iter(proc.stdout.readline, ""):
				q.put(line)
		except Exception as e:
			READER_ERROR[0] = e
		finally:
			q.put(None)  # EOF sentinel

	th = threading.Thread(target=reader, daemon=True)
	th.start()

	deadline = time.time() + timeout
	chunks: list[str] = []
	total = 0
	timed_out = False
	try:
		while True:
			if ctx.cancel_event.is_set():
				if sys.platform == "win32":
					proc.terminate()
				else:
					with contextlib.suppress(ProcessLookupError):
						os.killpg(proc.pid, signal.SIGKILL)
				proc.wait(timeout=2)
				raise Cancelled()
			remaining = max(0.0, deadline - time.time())
			if remaining == 0:
				if sys.platform == "win32":
					proc.terminate()
				else:
					with contextlib.suppress(ProcessLookupError):
						os.killpg(proc.pid, signal.SIGKILL)
				proc.wait(timeout=2)
				timed_out = True
				break
			try:
				# Short poll: lets us notice timeouts while the subprocess is
				# alive but not producing output.
				line = q.get(timeout=min(0.5, remaining))
			except Empty:
				continue
			if line is None:
				break  # EOF
			chunks.append(line)
			ctx.emit_progress(line)
			total += len(line)
			if total > MAX_TOOL_RESULT_BYTES:
				if sys.platform == "win32":
					proc.terminate()
				else:
					with contextlib.suppress(ProcessLookupError):
						os.killpg(proc.pid, signal.SIGKILL)
				chunks.append(f"\n[output truncated at {MAX_TOOL_RESULT_BYTES} bytes, killed]")
				break
	finally:
		with contextlib.suppress(Exception):
			if proc.poll() is None:
				proc.kill()
			proc.wait(timeout=2)

	if timed_out:
		return [{
			"type": "text",
			"text": _truncate("".join(chunks)) + f"\n[timeout after {timeout}s, killed]",
		}], True
	rc = proc.returncode if proc.returncode is not None else -1
	out = "".join(chunks)
	out += f"\n[exit: {rc}]"
	return [{"type": "text", "text": _truncate(out)}], rc != 0

def tool_read(args: dict, ctx: ToolCtx) -> list[dict]:
	path = args.get("path")
	if not isinstance(path, str) or not path:
		raise ValueError("read.path required")
	offset = int(args.get("offset") or 0)
	limit = int(args.get("limit") or 0)
	if not os.path.isfile(path):
		raise FileNotFoundError(path)
	size = os.path.getsize(path)
	with open(path, "rb") as f:
		if offset:
			f.seek(offset)
		if limit and limit > 0:
			data = f.read(limit)
		else:
			data = f.read(MAX_READ_BYTES)
			if f.read(1):
				data += b"\n[file truncated at 4MB; use offset/limit]"
	try:
		text = data.decode("utf-8")
	except UnicodeDecodeError:
		text = data.decode("utf-8", errors="replace")
	return [{"type": "text", "text": text}]


def tool_write(args: dict, ctx: ToolCtx) -> list[dict]:
	path = args.get("path")
	content = args.get("content")
	if not isinstance(path, str) or not path:
		raise ValueError("write.path required")
	if not isinstance(content, str):
		raise ValueError("write.content must be string")
	parent = os.path.dirname(os.path.abspath(path)) or "."
	os.makedirs(parent, exist_ok=True)
	tmp = path + f".tmp.{uuid.uuid4().hex[:8]}"
	with open(tmp, "w", encoding="utf-8") as f:
		f.write(content)
		f.flush()
		os.fsync(f.fileno())
	os.replace(tmp, path)
	return [{"type": "text", "text": f"wrote {len(content.encode('utf-8'))} bytes to {path}"}]


def tool_edit(args: dict, ctx: ToolCtx) -> list[dict]:
	path = args.get("path")
	old_text = args.get("old_text")
	new_text = args.get("new_text")
	replace_all = bool(args.get("replace_all"))
	if not isinstance(path, str) or not path:
		raise ValueError("edit.path required")
	if not isinstance(old_text, str) or not isinstance(new_text, str):
		raise ValueError("edit.old_text and edit.new_text must be strings")
	if not os.path.isfile(path):
		raise FileNotFoundError(path)
	with open(path, "r", encoding="utf-8") as f:
		original = f.read()
	if replace_all:
		if old_text not in original:
			raise ValueError("old_text not found in file")
		count = original.count(old_text)
		new_content = original.replace(old_text, new_text)
		msg = f"patched {count} occurrence(s)"
	else:
		if original.count(old_text) != 1:
			raise ValueError(f"old_text matches {original.count(old_text)} occurrences; pass replace_all=true to force")
		new_content = original.replace(old_text, new_text, 1)
		msg = "patched"
	tmp = path + f".tmp.{uuid.uuid4().hex[:8]}"
	with open(tmp, "w", encoding="utf-8") as f:
		f.write(new_content)
		f.flush()
		os.fsync(f.fileno())
	os.replace(tmp, path)
	return [{"type": "text", "text": msg}]


def tool_glob(args: dict, ctx: ToolCtx) -> list[dict]:
	pattern = args.get("pattern")
	cwd = args.get("cwd") or os.getcwd()
	if not isinstance(pattern, str) or not pattern:
		raise ValueError("glob.pattern required")
	if not os.path.isabs(pattern):
		pattern = os.path.join(cwd, pattern)
	matches = []
	for m in _glob.glob(pattern, recursive=True):
		if os.path.isfile(m):
			matches.append(m)
	matches.sort()
	return [{"type": "text", "text": "\n".join(matches) if matches else "(no matches)"}]


def tool_grep(args: dict, ctx: ToolCtx) -> list[dict]:
	pattern = args.get("pattern")
	path = args.get("path") or "."
	include = args.get("include")
	max_count = int(args.get("max_count") or 500)
	if not isinstance(pattern, str) or not pattern:
		raise ValueError("grep.pattern required")
	try:
		rx = re.compile(pattern)
	except re.error as e:
		raise ValueError(f"invalid regex: {e}")
	if os.path.isfile(path):
		files = [path]
	else:
		files = []
		for root, dirs, fs in os.walk(path):
			for fn in fs:
				if include and not _glob.fnmatch.fnmatch(fn, include):
					continue
				files.append(os.path.join(root, fn))
			if len(files) > 5000:
				break
	lines_out: list[str] = []
	count = 0
	for fp in files:
		try:
			with open(fp, "r", encoding="utf-8", errors="replace") as f:
				for ln, line in enumerate(f, 1):
					if rx.search(line):
						lines_out.append(f"{fp}:{ln}:{line.rstrip()}")
						count += 1
						if count >= max_count:
							break
		except OSError:
			continue
		if count >= max_count:
			break
	if not lines_out:
		return [{"type": "text", "text": "(no matches)"}]
	return [{"type": "text", "text": "\n".join(lines_out)}]


def tool_ls(args: dict, ctx: ToolCtx) -> list[dict]:
	path = args.get("path")
	if not isinstance(path, str) or not path:
		raise ValueError("ls.path required")
	if not os.path.isdir(path):
		raise FileNotFoundError(f"not a directory: {path}")
	rows = []
	for name in sorted(os.listdir(path)):
		full = os.path.join(path, name)
		try:
			st = os.lstat(full)
			kind = "d" if os.path.isdir(full) else ("l" if os.path.islink(full) else "-")
			size = st.st_size
		except OSError:
			kind, size = "?", 0
		rows.append(f"{kind} {size:>10}  {name}")
	return [{"type": "text", "text": "\n".join(rows) if rows else "(empty)"}]


def tool_stat(args: dict, ctx: ToolCtx) -> list[dict]:
	path = args.get("path")
	if not isinstance(path, str) or not path:
		raise ValueError("stat.path required")
	st = os.lstat(path)
	kind = "directory" if os.path.isdir(path) else ("link" if os.path.islink(path) else "file")
	import datetime as _dt
	return [{
		"type": "text",
		"text": f"{kind} {st.st_size}B  mtime={_dt.datetime.fromtimestamp(st.st_mtime).isoformat()}  perms={oct(st.st_mode & 0o777)}",
	}]


def tool_env(args: dict, ctx: ToolCtx) -> list[dict]:
	name = args.get("name")
	if name:
		v = os.environ.get(name, "")
		return [{"type": "text", "text": v}]
	return [{"type": "text", "text": "\n".join(f"{k}={v}" for k, v in os.environ.items())}]


TOOLS: dict[str, callable] = {
	"bash": tool_bash,
	"read": tool_read,
	"write": tool_write,
	"edit": tool_edit,
	"glob": tool_glob,
	"grep": tool_grep,
	"ls": tool_ls,
	"stat": tool_stat,
	"env": tool_env,
}


# ---------- Connector runtime ----------

class Connector:
	def __init__(self, relay: str, token: str, label: str | None):
		self.relay = relay
		self.token = token
		self.label = label or socket.gethostname()
		self.machine_id = _read_hwid()
		self._active_calls: dict[str, tuple[threading.Event, threading.Thread]] = {}
		self._lock = threading.Lock()
		self._stop = threading.Event()

	def run_forever(self) -> None:
		backoff = 0
		while not self._stop.is_set():
			try:
				self._run_once()
				backoff = 0
			except WSError as e:
				sys.stderr.write(f"[connector] offline: ws error — {e}\n")
			except OSError as e:
				sys.stderr.write(f"[connector] offline: net error — {e}\n")
			except Exception as e:
				sys.stderr.write(f"[connector] offline: {e}\n{traceback.format_exc()}\n")
			if self._stop.is_set():
				break
			wait = RECONNECT_BACKOFF[min(backoff, len(RECONNECT_BACKOFF) - 1)]
			sys.stderr.write(f"[connector] reconnecting in {wait}s\n")
			if self._stop.wait(wait):
				break
			backoff += 1

	def _run_once(self) -> None:
		headers = {}
		if self.token:
			headers["Sec-WebSocket-Protocol"] = f"bearer.{self.token}"
		ws = WebSocket.connect(self.relay, headers=headers, timeout=15)
		sys.stderr.write(f"[connector] connected to {self.relay}\n")
		try:
			ws.send({
				"type": "register",
				"machine_id": self.machine_id,
				"hostname": socket.gethostname(),
				"os": sys.platform,
				"arch": os.uname().machine if hasattr(os, "uname") else "unknown",
				"label": self.label,
				"version": VERSION,
				"capabilities": {
					"tools": sorted(TOOLS.keys()),
					"max_concurrent": 4,
					"supports_progress": True,
					"supports_cancel": True,
				},
			})
			# Mutable container so the heartbeat closure sees updates.
			last_pong_at = [time.time()]
			heartbeat = setInterval(HEARTBEAT_INTERVAL_MS / 1000, lambda: self._heartbeat_tick(ws, last_pong_at))
			try:
				while not self._stop.is_set():
					msg = ws.recv()
					if msg is None:
						if ws.closed:
							sys.stderr.write(f"[connector] offline: connection closed\n")
							return
						continue
					last_pong_at[0] = time.time()
					self._handle(ws, msg)
			finally:
				heartbeat.cancel()
		finally:
			with self._lock:
				for _, ev in list(self._active_calls.values()):
					ev.set()
			with contextlib.suppress(Exception):
				ws.close()


	def _heartbeat_tick(self, ws: WebSocket, last_pong_at_ref: list) -> None:
		if time.time() - last_pong_at_ref[0] > HEARTBEAT_INTERVAL_MS / 1000 * 3:
			ws.close(4000, "heartbeat timeout")
			return
		try:
			ws.send({"type": "ping", "t": int(time.time() * 1000)})
		except Exception:
			ws.close()

	def _handle(self, ws: WebSocket, msg: dict) -> None:
		t = msg.get("type")
		if t == "registered":
			self.machine_id = msg.get("machine_id")
			sys.stderr.write(f"[connector] online — id={self.machine_id} hostname={socket.gethostname()}\n")
			return
		if t == "ping":
			ws.send({"type": "pong", "t": msg.get("t", int(time.time() * 1000))})
			return
		if t == "tool.call":
			cid = msg.get("id")
			name = msg.get("name")
			args = msg.get("args") or {}
			if not cid or not name:
				return
			if name not in TOOLS:
				ws.send({"type": "tool.result", "id": cid, "ok": False,
				         "error": f"unknown tool: {name}", "content": []})
				return
			ev = threading.Event()
			th = threading.Thread(
				target=self._exec, args=(ws, cid, name, args, ev), daemon=True
			)
			with self._lock:
				self._active_calls[cid] = (ev, th)
			th.start()
			return
		if t == "tool.cancel":
			cid = msg.get("id")
			with self._lock:
				tup = self._active_calls.get(cid)
			if tup:
				ev, _ = tup
				ev.set()
			return
		if t == "tool.progress":
			# v0.5: the relay could echo progress back to us for relay-side
			# fanout, but we don't currently need that.
			return
		# unknown frame: ignore

	def _exec(self, ws: WebSocket, cid: str, name: str, args: dict, ev: threading.Event) -> None:
		def send_progress(delta: str) -> None:
			try:
				ws.send({"type": "tool.progress", "id": cid, "delta": delta})
			except Exception:
				pass
			sys.stderr.write(delta if delta.endswith("\n") else delta + "\n")

		ctx = ToolCtx(ev, on_progress=send_progress)
		start = time.time()
		sys.stderr.write(f"[tool] {name} {_tool_summary(name, args)}\n")
		try:
			fn = TOOLS[name]
			content_or_tuple = fn(args, ctx)
			if isinstance(content_or_tuple, tuple):
				content, is_error = content_or_tuple
			else:
				content, is_error = content_or_tuple, False
			duration_ms = int((time.time() - start) * 1000)
			status = "error" if is_error else "ok"
			sys.stderr.write(f"[tool] {name} {status} ({duration_ms}ms)\n")
			if name != "bash":
				for item in content:
					if item.get("type") == "text":
						text = item["text"]
						sys.stderr.write((text[:500] + "\n[…]\n") if len(text) > 500 else text + "\n")
						break
			ws.send({
				"type": "tool.result",
				"id": cid,
				"ok": not is_error,
				"content": content,
				"duration_ms": duration_ms,
			})
		except Cancelled:
			sys.stderr.write(f"[tool] {name} cancelled\n")
			ws.send({
				"type": "tool.result",
				"id": cid,
				"ok": False,
				"error": "cancelled",
				"content": [{"type": "text", "text": "[cancelled]"}],
				"duration_ms": int((time.time() - start) * 1000),
			})
		except Exception as e:
			err = f"{type(e).__name__}: {e}"
			sys.stderr.write(f"[tool] {name} error: {err}\n")
			ws.send({
				"type": "tool.result",
				"id": cid,
				"ok": False,
				"error": err,
				"content": [{"type": "text", "text": f"error: {err}"}],
				"duration_ms": int((time.time() - start) * 1000),
			})
		finally:
			with self._lock:
				self._active_calls.pop(cid, None)


def setInterval(interval: float, fn):
	"""Tiny interval timer (returns a handle with .cancel())."""
	stop = threading.Event()

	def loop():
		while not stop.wait(interval):
			try:
				fn()
			except Exception:
				pass

	threading.Thread(target=loop, daemon=True).start()

	class _Handle:
		def cancel(self):
			stop.set()

	return _Handle()


def main() -> int:
	p = argparse.ArgumentParser(prog="omp-teleport-connector")
	p.add_argument("--relay", default=os.environ.get("OMP_REMOTE_RELAY"),
	               help="relay ws URL (env: OMP_REMOTE_RELAY)")
	p.add_argument("--label", default=os.environ.get("OMP_REMOTE_LABEL"),
	               help="friendly machine label")
	p.add_argument("--install-dir", default=os.path.expanduser("~/.omp-teleport"),
	               help="where to put state files (default: ~/.omp-teleport)")
	args = p.parse_args()

	if not args.relay:
		print("error: --relay is required (or set OMP_REMOTE_RELAY)", file=sys.stderr)
		return 2

	os.makedirs(args.install_dir, exist_ok=True)
	with open(os.path.join(args.install_dir, "env"), "w") as f:
		f.write(f"OMP_REMOTE_RELAY={args.relay}\n")
		if args.label:
			f.write(f"OMP_REMOTE_LABEL={args.label}\n")

	c = Connector(args.relay, None, args.label)

	def stop(*_a):
		c._stop.set()

	signal.signal(signal.SIGTERM, stop)
	signal.signal(signal.SIGINT, stop)
	c.run_forever()
	return 0


if __name__ == "__main__":
	sys.exit(main())
