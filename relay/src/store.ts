// In-memory state with atomic file persistence and change-listener fanout.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { JoinToken, MachineRecord, OperatorToken } from "./types.ts";

interface PersistedState {
	operatorTokens: OperatorToken[];
	joinTokens: JoinToken[];
}

const SECRET_BYTES = 24;

function randomToken(prefix: "jt" | "ot"): string {
	const bytes = new Uint8Array(SECRET_BYTES);
	crypto.getRandomValues(bytes);
	const b64 = Buffer.from(bytes).toString("base64url");
	return `${prefix}_${b64}`;
}

export type ChangeReason = "machine_connected" | "machine_disconnected";

export class Store {
	private operators = new Map<string, OperatorToken>();
	private joins = new Map<string, JoinToken>();
	private machines = new Map<string, MachineRecord>();
	private persistPath: string;
	private persistQueued = false;
	private listeners = new Set<(reason: ChangeReason, machineId?: string) => void>();

	constructor(persistPath: string) {
		this.persistPath = persistPath;
		this.load();
		if (this.operators.size === 0) {
			this.createOperator("default");
		}
	}

	private load(): void {
		try {
			if (!existsSync(this.persistPath)) return;
			const raw = readFileSync(this.persistPath, "utf8");
			const data = JSON.parse(raw) as PersistedState;
			for (const t of data.operatorTokens ?? []) this.operators.set(t.secret, t);
			for (const t of data.joinTokens ?? []) this.joins.set(t.secret, t);
		} catch (e) {
			console.error("[store] failed to load state:", e);
		}
	}

	private schedulePersist(): void {
		if (this.persistQueued) return;
		this.persistQueued = true;
		queueMicrotask(() => {
			this.persistQueued = false;
			this.persistNow();
		});
	}

	private persistNow(): void {
		const data: PersistedState = {
			operatorTokens: [...this.operators.values()],
			joinTokens: [...this.joins.values()],
		};
		try {
			mkdirSync(dirname(this.persistPath), { recursive: true });
			const tmp = `${this.persistPath}.tmp.${Date.now()}`;
			writeFileSync(tmp, JSON.stringify(data, null, 2));
			renameSync(tmp, this.persistPath);
		} catch (e) {
			console.error("[store] failed to persist:", e);
		}
	}

	onMachinesChange(fn: (reason: ChangeReason, machineId?: string) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private notify(reason: ChangeReason, id?: string): void {
		for (const fn of this.listeners) {
			try {
				fn(reason, id);
			} catch (e) {
				console.error("[store] listener error:", e);
			}
		}
	}

	// ---- operators ----
	createOperator(name: string): OperatorToken {
		const t: OperatorToken = {
			kind: "operator",
			secret: randomToken("ot"),
			name,
			created_at: Date.now(),
		};
		this.operators.set(t.secret, t);
		this.schedulePersist();
		return t;
	}

	listOperators(): OperatorToken[] {
		return [...this.operators.values()];
	}

	findOperator(secret: string): OperatorToken | undefined {
		return this.operators.get(secret);
	}

	revokeOperator(secret: string): boolean {
		const ok = this.operators.delete(secret);
		if (ok) this.schedulePersist();
		return ok;
	}

	// ---- join tokens ----
	createJoinToken(label: string, ttlSec?: number): JoinToken {
		const now = Date.now();
		const t: JoinToken = {
			kind: "join",
			secret: randomToken("jt"),
			label,
			created_at: now,
			expires_at: ttlSec ? now + ttlSec * 1000 : undefined,
		};
		this.joins.set(t.secret, t);
		this.schedulePersist();
		return t;
	}

	listJoinTokens(): JoinToken[] {
		return [...this.joins.values()];
	}

	consumeJoinToken(secret: string): JoinToken | undefined {
		const t = this.joins.get(secret);
		if (!t) return undefined;
		if (t.expires_at && t.expires_at < Date.now()) {
			this.joins.delete(secret);
			this.schedulePersist();
			return undefined;
		}
		if (t.used_at) return undefined; // one-shot
		t.used_at = Date.now();
		this.schedulePersist();
		return t;
	}

	findJoinToken(secret: string): JoinToken | undefined {
		return this.joins.get(secret);
	}

	revokeJoinToken(secret: string): boolean {
		const ok = this.joins.delete(secret);
		if (ok) this.schedulePersist();
		return ok;
	}

	// ---- machines ----
	upsertMachine(m: MachineRecord): void {
		const isNew = !this.machines.has(m.id);
		this.machines.set(m.id, m);
		if (isNew) this.notify("machine_connected", m.id);
	}

	getMachine(id: string): MachineRecord | undefined {
		return this.machines.get(id);
	}

	listMachines(): MachineRecord[] {
		return [...this.machines.values()].sort((a, b) => b.connected_at - a.connected_at);
	}

	listOnlineMachines(): MachineRecord[] {
		return this.listMachines().filter((m) => m.status === "online");
	}

	removeMachine(id: string): boolean {
		const m = this.machines.get(id);
		if (!m) return false;
		for (const call of m.pendingCalls.values()) {
			if (call.timer) clearTimeout(call.timer);
			call.reject(new Error("machine disconnected"));
		}
		m.pendingCalls.clear();
		this.machines.delete(id);
		this.notify("machine_disconnected", id);
		return true;
	}

	markMachineOffline(id: string): void {
		const m = this.machines.get(id);
		if (!m) return;
		m.status = "offline";
		for (const call of m.pendingCalls.values()) {
			if (call.timer) clearTimeout(call.timer);
			call.reject(new Error("machine disconnected"));
		}
		m.pendingCalls.clear();
		this.notify("machine_disconnected", id);
	}

}
