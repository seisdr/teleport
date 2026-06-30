// WebSocket handler for connector side. Exports a Bun WebSocketHandler<WSContext>.

import type { ServerWebSocket, WebSocketHandler } from "bun";
import { z } from "zod";
import type { Store } from "./store.ts";
import type { ConnectorFrame, MachineRecord, PendingCall, TimerHandle, ToolResultFrame } from "./types.ts";

const HEARTBEAT_MS = 5000;

const RegisterFrame = z.object({
	type: z.literal("register"),
	machine_id: z.string().min(1).max(128),
	hostname: z.string().min(1).max(256),
	os: z.string().min(1).max(64),
	arch: z.string().min(1).max(64),
	label: z.string().min(1).max(64),
	version: z.string().min(1).max(32),
	capabilities: z.object({
		tools: z.array(z.string()),
		max_concurrent: z.number().int().min(1).max(64),
		supports_progress: z.boolean(),
		supports_cancel: z.boolean(),
	}),
});
const ToolResultFrameSchema = z.object({
	type: z.literal("tool.result"),
	id: z.string().min(1).max(256),
	ok: z.boolean(),
	content: z.array(z.object({ type: z.literal("text"), text: z.string() })).optional(),
	error: z.string().optional(),
	duration_ms: z.number().optional(),
});

const ToolProgressFrameSchema = z.object({
	type: z.literal("tool.progress"),
	id: z.string().min(1).max(256),
	delta: z.string(),
});

const PongFrameSchema = z.object({
	type: z.literal("pong"),
	t: z.number(),
});

const ConnectorFrameSchema = z.union([
	RegisterFrame,
	ToolResultFrameSchema,
	ToolProgressFrameSchema,
	PongFrameSchema,
	z.object({ type: z.string() }).passthrough(),
]);

export interface WSContext {
	machineId?: string;
}

interface SessionState {
	machine: MachineRecord | undefined;
	lastPongAt: number;
	heartbeat: TimerHandle;
}

export function handleConnectorUpgrade(
	_req: Request,
	_store: Store,
): { ok: true; ctx: WSContext } {
	return { ok: true, ctx: {} };
}

export function createConnectorHandler(store: Store): WebSocketHandler<WSContext> {
	const sessions = new WeakMap<ServerWebSocket<WSContext>, SessionState>();

	return {
		open(ws) {
			const session: SessionState = {
				machine: undefined,
				lastPongAt: Date.now(),
				heartbeat: setInterval(() => {
					const s = sessions.get(ws);
					if (!s) return;
					if (Date.now() - s.lastPongAt > HEARTBEAT_MS * 3) {
						ws.close(4000, "heartbeat timeout");
						return;
					}
					try {
						ws.send(JSON.stringify({ type: "ping", t: Date.now() }));
					} catch {
						ws.close();
					}
				}, HEARTBEAT_MS),
			};
			sessions.set(ws, session);
		},

		message(ws, message) {
			const s = sessions.get(ws);
			if (!s) return;
			s.lastPongAt = Date.now();

			let raw: unknown;
			try {
				raw = typeof message === "string" ? JSON.parse(message) : null;
			} catch {
				return;
			}
			const parsed = ConnectorFrameSchema.safeParse(raw);
			if (!parsed.success) return;
			const frame = parsed.data as ConnectorFrame;

		if (frame.type === "register") {
			if (s.machine) return;
			// Remove stale offline machines with the same hostname
			for (const m of store.listMachines()) {
				if (m.hostname === frame.hostname && m.status === "offline") {
					store.removeMachine(m.id);
				}
			}
			const id = frame.machine_id;
			// If machine with this ID exists, update in-place (handles both resume and
			// reconnect-before-close races — the new WebSocket replaces the old one,
			// and the old close handler's ws-guard prevents marking the new one offline).
			const existing = store.getMachine(id);
			if (existing) {
				existing.ws = ws;
				existing.status = "online";
				existing.connected_at = Date.now();
				existing.last_seen_at = Date.now();
				existing.hostname = frame.hostname;
				existing.os = frame.os;
				existing.arch = frame.arch;
				existing.version = frame.version;
				existing.capabilities = frame.capabilities;
				s.machine = existing;
				ws.data = { machineId: id };
				ws.send(JSON.stringify({ type: "registered", machine_id: id, heartbeat_ms: HEARTBEAT_MS }));
				return;
			}
			// New machine
			s.machine = {
				id,
				label: frame.label,
				hostname: frame.hostname,
				os: frame.os,
				arch: frame.arch,
				version: frame.version,
				capabilities: frame.capabilities,
				connected_at: Date.now(),
				last_seen_at: Date.now(),
				status: "online",
				ws,
				pendingCalls: new Map(),
			};
			store.upsertMachine(s.machine);
			ws.data = { machineId: id };
			ws.send(JSON.stringify({ type: "registered", machine_id: id, heartbeat_ms: HEARTBEAT_MS }));
			return;
		}


			if (frame.type === "ping") {
				const t = typeof (frame as Record<string, unknown>).t === "number" ? (frame as Record<string, unknown>).t : Date.now();
				try {
					ws.send(JSON.stringify({ type: "pong", t }));
				} catch {
					// connection lost
				}
				return;
			}
			if (frame.type === "pong") return;

			if (frame.type === "tool.result") {
				if (!s.machine) return;
				const call = s.machine.pendingCalls.get(frame.id);
				if (!call) return;
				s.machine.pendingCalls.delete(frame.id);
				if (call.timer) clearTimeout(call.timer);
				const resultFrame = frame as ToolResultFrame; // Zod-validated; narrowing union member
				call.resolve(resultFrame);
				return;
			}

			if (frame.type === "tool.progress") {
				// Forward per-line output from the connector to whoever owns
				// the pending call (the SSE response stream in HTTP, or a
				// future consumer).
				if (!s.machine) return;
				const call = s.machine.pendingCalls.get(frame.id);
				if (!call || !call.onProgress) return;
				const delta = typeof (frame as { delta?: unknown }).delta === "string"
					? (frame as { delta: string }).delta
					: "";
				if (delta) {
					try { call.onProgress(delta); } catch { /* swallow consumer errors */ }
				}
				return;
			}
		},

		close(ws) {
			const s = sessions.get(ws);
			if (s) {
				clearInterval(s.heartbeat);
				// Only mark offline if this WebSocket still owns the machine record.
				// A stale close (after the machine reconnected with a new WebSocket)
				// must not mark the new record offline.
				if (s.machine && s.machine.ws === ws) store.markMachineOffline(s.machine.id);
			}
			sessions.delete(ws);
		},
	};
}

export function dispatchToolCall(store: Store, machineId: string, call: PendingCall): boolean {
	const m = store.getMachine(machineId);
	if (!m || m.status !== "online") return false;
	m.pendingCalls.set(call.id, call);
	const ws = m.ws as ServerWebSocket<WSContext>;
	try {
		ws.send(JSON.stringify({
			type: "tool.call",
			id: call.id,
			name: call.name,
			args: call.args,
			timeout_ms: call.timeoutMs,
		}));
		return true;
	} catch {
		m.pendingCalls.delete(call.id);
		return false;
	}
}
