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
from queue import Queue, Empty
import time
import traceback
import urllib.parse
import uuid


# ---------- WebSocket client (stdlib only, RFC 6455) ----------

class WSError(Exception):
	"""WebSocket protocol error."""
	pass


class Cancelled(Exception):
	"""Raised when a tool call is cancelled."""
	pass


class ToolCtx:
	"""Context passed to tool functions for cancellation and progress reporting."""
	__slots__ = ("cancel_event", "on_progress")

	def __init__(self, cancel_event: threading.Event, on_progress=None):
		self.cancel_event = cancel_event
		self.on_progress = on_progress

	def emit_progress(self, delta: str) -> None:
		if self.on_progress:
			self.on_progress(delta)

# ---------- Constants ----------

VERSION = "0.5.0"
HEARTBEAT_INTERVAL_MS = 5000
RECONNECT_BACKOFF = [1, 2, 4, 8, 16, 30]
DEFAULT_BASH_TIMEOUT = 30
MAX_BASH_TIMEOUT = 3600
MAX_STDOUT = 50000
MAX_STDERR = 10000
MAX_TOOL_RESULT_BYTES = 100000
MAX_READ_BYTES = 5242880
MAX_CONCURRENT = 4


# ---------- WebSocket frame helpers ----------

_WS_MAGIC = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def _ws_mask(payload: bytes, mask_key: bytes) -> bytes:
	return bytes(b ^ mask_key[i % 4] for i, b in enumerate(payload))


class WebSocket:
	"""Minimal RFC 6455 WebSocket client for JSON text frames. Stdlib only."""

	def __init__(self, sock: socket.socket):
		self._sock = sock
		self._recv_buf = bytearray()
		self.closed = False

	@staticmethod
	def connect(url: str, headers: dict[str, str] | None = None, timeout: float = 15) -> "WebSocket":
		parsed = urllib.parse.urlparse(url)
		if parsed.scheme not in ("ws", "wss"):
			raise WSError(f"unsupported scheme: {parsed.scheme}")
		host = parsed.hostname
		port = parsed.port or (443 if parsed.scheme == "wss" else 80)
		path = parsed.path or "/"
		if parsed.query:
			path += "?" + parsed.query

		sock = socket.create_connection((host, port), timeout=timeout)
		if parsed.scheme == "wss":
			ctx = ssl.create_default_context()
			sock = ctx.wrap_socket(sock, server_hostname=host)

		# HTTP upgrade handshake
		key = base64.b64encode(os.urandom(16)).decode()
		req_lines = [
			f"GET {path} HTTP/1.1",
			f"Host: {host}:{port}",
			"Upgrade: websocket",
			"Connection: Upgrade",
			f"Sec-WebSocket-Key: {key}",
			"Sec-WebSocket-Version: 13",
		]
		if headers:
			for k, v in headers.items():
				req_lines.append(f"{k}: {v}")
		req_lines.append("")
		req_lines.append("")
		sock.sendall("\r\n".join(req_lines).encode())

		# Read response
		resp = b""
		while b"\r\n\r\n" not in resp:
			chunk = sock.recv(4096)
			if not chunk:
				raise WSError("connection closed during handshake")
			resp += chunk
		header_end = resp.index(b"\r\n\r\n")
		status_line = resp[:resp.index(b"\r\n")].decode()
		if " 101 " not in status_line and not status_line.startswith("HTTP/1.1 101"):
			raise WSError(f"handshake failed: {status_line}")

		# Validate accept key
		expected_accept = base64.b64encode(
			hashlib.sha1(key.encode() + _WS_MAGIC).digest()
		).decode()
		response_headers = resp[:header_end].decode().split("\r\n")[1:]
		got_accept = ""
		for h in response_headers:
			if h.lower().startswith("sec-websocket-accept:"):
				got_accept = h.split(":", 1)[1].strip()
		if got_accept != expected_accept:
			raise WSError(f"Sec-WebSocket-Accept mismatch: expected {expected_accept}, got {got_accept}")

		return WebSocket(sock)

	def send(self, data: object) -> None:
		"""Send a JSON text frame."""
		payload = json.dumps(data, ensure_ascii=False).encode()
		self._send_frame(0x1, payload)

	def recv(self) -> dict | None:
		"""Receive and parse a JSON text frame. Returns None if connection closed cleanly."""
		while True:
			data = self._recv_frame()
			if data is None:
				return None
			opcode, payload = data
			if opcode == 0x1:  # text
				return json.loads(payload.decode())
			if opcode == 0x8:  # close
				self.closed = True
				return None
			if opcode == 0x9:  # ping
				self._send_frame(0xA, payload)
			# pong (0xA) and other frames: ignore

	def close(self, code: int = 1000, reason: str = "") -> None:
		"""Send close frame and shutdown."""
		if self.closed:
			return
		try:
			try:
				payload = struct.pack("!H", code) + reason.encode()
				self._send_frame(0x8, payload)
			except Exception:
				pass
			try:
				self._sock.shutdown(socket.SHUT_RDWR)
			except OSError:
				pass
		finally:
			try:
				self._sock.close()
			except OSError:
				pass
			self.closed = True
	# ---- internal framing ----

	def _send_frame(self, opcode: int, payload: bytes) -> None:
		mask_key = os.urandom(4)
		header = bytearray([0x80 | opcode])
		length = len(payload)
		if length < 126:
			header.append(0x80 | length)
		elif length < 65536:
			header.append(0x80 | 126)
			header += struct.pack("!H", length)
		else:
			header.append(0x80 | 127)
			header += struct.pack("!Q", length)
		header += mask_key
		self._sock.sendall(bytes(header) + _ws_mask(payload, mask_key))

	def _recv_frame(self) -> tuple[int, bytes] | None:
		"""Read one frame. Returns (opcode, payload) or None on close/error."""
		# Read header (at least 2 bytes)
		while len(self._recv_buf) < 2:
			try:
				chunk = self._sock.recv(4096)
			except OSError:
				self.closed = True
				return None
			if not chunk:
				self.closed = True
				return None
			self._recv_buf += chunk

		b0 = self._recv_buf[0]
		b1 = self._recv_buf[1]
		opcode = b0 & 0xF
		masked = (b1 & 0x80) != 0
		length = b1 & 0x7F
		pos = 2

		if length == 126:
			while len(self._recv_buf) < pos + 2:
				chunk = self._sock.recv(4096)
				if not chunk:
					self.closed = True
					return None
				self._recv_buf += chunk
			length = struct.unpack("!H", bytes(self._recv_buf[pos:pos+2]))[0]
			pos += 2
		elif length == 127:
			while len(self._recv_buf) < pos + 8:
				chunk = self._sock.recv(4096)
				if not chunk:
					self.closed = True
					return None
				self._recv_buf += chunk
			length = struct.unpack("!Q", bytes(self._recv_buf[pos:pos+8]))[0]
			pos += 8

		header_len = pos + (4 if masked else 0)
		while len(self._recv_buf) < header_len + length:
			chunk = self._sock.recv(4096)
			if not chunk:
				self.closed = True
				return None
			self._recv_buf += chunk

		mask_key = bytes(self._recv_buf[pos:pos+4]) if masked else b""
		pos += 4 if masked else 0
		payload = bytes(self._recv_buf[pos:pos+length])
		if masked:
			payload = _ws_mask(payload, mask_key)

		self._recv_buf = self._recv_buf[pos+length:]
		return (opcode, payload)

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


def tool_bash(args: dict, ctx: ToolCtx) -> tuple[list[dict], bool]:
	command = args.get("command")
	if not isinstance(command, str) or not command.strip():
		raise ValueError("bash.command must be a non-empty string")
	cwd = args.get("cwd") or os.getcwd()
	timeout = int(args.get("timeout") or DEFAULT_BASH_TIMEOUT)
	timeout = max(1, timeout)

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

	if READER_ERROR[0] is not None:
		chunks.append(f"\n[reader error: {READER_ERROR[0]}]")

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
		self.machine_id = Connector._read_hwid()
		self._active_calls: dict[str, tuple[threading.Event, threading.Thread]] = {}
		self._lock = threading.Lock()
		self._stop = threading.Event()

	@staticmethod
	def _read_hwid() -> str:
		"""Deterministic hardware ID in m_<base64url> format."""
		raw = Connector._read_raw_hwid()
		h = hashlib.sha256(raw.encode()).digest()
		return "m_" + base64.urlsafe_b64encode(h[:9]).decode().rstrip("=")

	@staticmethod
	def _read_raw_hwid() -> str:
		"""Platform-specific stable identifier, may vary in format."""
		if sys.platform == "win32":
			try:
				import winreg
				key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Cryptography")
				guid, _ = winreg.QueryValueEx(key, "MachineGuid")
				winreg.CloseKey(key)
				if guid:
					return guid
			except Exception:
				pass
			try:
				return socket.gethostname() + str(uuid.getnode())
			except Exception:
				return socket.gethostname()
		if sys.platform == "darwin":
			try:
				r = subprocess.run(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
				                   capture_output=True, text=True, timeout=5)
				for line in r.stdout.splitlines():
					if "IOPlatformUUID" in line:
						return line.split('"')[1] if '"' in line else line.split("=")[1].strip()
			except Exception:
				pass
		try:
			for p in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
				if os.path.exists(p):
					with open(p) as f:
						hwid = f.read().strip()
					if hwid:
						return hwid
		except Exception:
			pass
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
			return socket.gethostname() + mac
		except Exception:
			return socket.gethostname()

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
			if name == "bash":
				timeout_ms = msg.get("timeout_ms")
				if timeout_ms is not None:
					args["timeout"] = min(timeout_ms / 1000, 3600)
			if name not in TOOLS:
				ws.send({"type": "tool.result", "id": cid, "ok": False,
				         "error": f"unknown tool: {name}", "content": []})
				return
			ev = threading.Event()
			th = threading.Thread(
				target=self._exec, args=(ws, cid, name, args, ev), daemon=True
			)
			with self._lock:
				if len(self._active_calls) >= MAX_CONCURRENT:
					ws.send({"type": "tool.result", "id": cid, "ok": False,
					         "error": f"too many concurrent calls (max {MAX_CONCURRENT})", "content": []})
					return
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
	p.add_argument("--token", default=os.environ.get("OMP_REMOTE_TOKEN"),
	               help="join token (env: OMP_REMOTE_TOKEN)")
	p.add_argument("--label", default=os.environ.get("OMP_REMOTE_LABEL"),
	               help="friendly machine label")
	p.add_argument("--install-dir", default=os.path.expanduser("~/.omp-teleport"),
	               help="where to put state files (default: ~/.omp-teleport)")
	args = p.parse_args()

	if not args.relay:
		print("error: --relay is required (or set OMP_REMOTE_RELAY)", file=sys.stderr)
		return 2

	os.makedirs(args.install_dir, exist_ok=True)
	token = args.token or os.environ.get("OMP_REMOTE_TOKEN")
	with open(os.path.join(args.install_dir, "env"), "w") as f:
		f.write(f"OMP_REMOTE_RELAY={args.relay}\n")
		if args.label:
			f.write(f"OMP_REMOTE_LABEL={args.label}\n")
		if token:
			f.write(f"OMP_REMOTE_TOKEN={token}\n")

	c = Connector(args.relay, token, args.label)

	def stop(*_a):
		c._stop.set()

	signal.signal(signal.SIGTERM, stop)
	signal.signal(signal.SIGINT, stop)
	c.run_forever()
	return 0


if __name__ == "__main__":
	sys.exit(main())
