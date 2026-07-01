// omp-teleport OMP extension.
//
// Wires the OMP TUI to the omp-teleport relay. Registers 9 tools
// (`remote_bash`, `remote_read`, `remote_write`, `remote_edit`,
// `remote_glob`, `remote_grep`, `remote_ls`, `remote_stat`, `remote_env`)
// that forward calls to the relay.
//
// Two modes:
//
//   Default: model has access to ALL tools (local OMP + remote_*).
//     The model picks whichever fits. The user can use /tp pick
//     to inject `machine: "<label>"` into the editor so the model
//     targets a specific machine without having to memorize labels.
//
//   Remote-only (/tp connect <machine>): local filesystem/process tools
//     are hidden from the model via setActiveTools. The remote tools are the
//     model's only filesystem interface, with the `machine` arg becoming
//     optional and defaulting to the active connection.
//     Tools that don't need the remote machine (memory, web search, etc.)
//     stay available automatically — no whitelist needed.
//     /tp disconnect restores the full local tool set.
//
// No system-prompt manipulation. The model is not told where it is;
// the tools and their results are the only source of truth.
//
// Config (env or --omp-teleport-relay flag):
//   OMP_REMOTE_RELAY         — explicit relay URL; if absent we default to http://127.0.0.1:7777
//   OMP_REMOTE_PORT          — port (default 7777)
//
// Slash commands:
//   /tp ls                       — list connected machines
//   /tp pick                     — interactive machine picker, connects to the selected machine
//   /tp connect <machine>         — enter remote-only mode (hides local tools)
//   /tp disconnect               — exit remote-only mode (restores local tools)
//   /tp force [on|off]           — toggle force mode: hide local tools and use short names (bash, read, etc.) as aliases to remote versions
import { homedir } from "node:os";
import { existsSync, realpathSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

interface MachineCapabilities {
	tools: string[];
	max_concurrent: number;
	supports_progress: boolean;
	supports_cancel: boolean;
}

interface Machine {
	id: string;
	label: string;
	hostname: string;
	os: string;
	arch: string;
	version: string;
	connected_at: number;
	last_seen_at: number;
	status: "online" | "offline";
	capabilities: MachineCapabilities;
}

interface Config {
	relay: string;
}



const WIDGET_KEY = "omp-teleport-status";
const MAX_WIDGET_LINES = 8;
const WIDGET_MAX_WIDTH = 80;

const TOOL_NAMES = ["bash", "read", "write", "edit", "glob", "grep", "ls", "stat", "env"] as const;
type ToolName = (typeof TOOL_NAMES)[number];

const REMOTE_TOOL_NAMES: readonly string[] = TOOL_NAMES.map((t) => `remote_${t}`);

// Local tools to HIDE in remote-only mode: they touch the local filesystem or
// local process state and would be wrong to run on the OMP host when the user
// wants to work on a remote machine. Everything else (memory tools, web search,
// image generation, etc.) stays available automatically — no whitelist needed.
const LOCAL_FS_TOOLS: ReadonlySet<string> = new Set([
	"bash",
	"read",
	"write",
	"edit",
	"glob",
	"grep",
	"ls",
	"stat",
	"env",
	"browser",
	"debug",
	"eval",
	"lsp",
	"ast_grep",
	"ast_edit",
	"task",
	"job",
]);

const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
	bash: "Run a shell command on a remote machine (Windows, macOS, Linux). Pass `command`. If you have an active remote connection (set with /tp connect), the `machine` arg defaults to it; otherwise pass it explicitly. Use `timeout` (sec) to bound long-running commands.",
	read: "Read a file on a remote machine. Pass `path`. If you have an active remote connection, `machine` is optional; otherwise pass it explicitly. `offset`/`limit` in bytes; omit for full read (capped at 4MB).",
	write: "Write content to a file on a remote machine. Pass `path` and `content`. `machine` is optional if you have an active remote connection; otherwise pass it explicitly. Atomic replace.",
	edit: "Replace `old_text` with `new_text` in a remote file. Pass `path` and the search/replace strings. `machine` is optional if you have an active remote connection. Pass `replace_all=true` to replace every occurrence; otherwise the match must be unique.",
	glob: "List files matching a glob pattern on a remote machine. Pass `pattern` (recursive with `**`). `machine` is optional if you have an active remote connection. Optional `cwd`.",
	grep: "Regex search across files on a remote machine. Pass `pattern` and `path`. `machine` is optional if you have an active remote connection. Returns `path:line:match` lines. Optional `include` (glob) and `max_count`.",
	ls: "List a directory on a remote machine. Pass `path`. `machine` is optional if you have an active remote connection.",
	stat: "Return file metadata on a remote machine. Pass `path`. `machine` is optional if you have an active remote connection.",
	env: "Read environment variables on a remote machine. `machine` is optional if you have an active remote connection. Optional `name` for a single var; omit for all.",
};
function findRelayEntry(): string | undefined {
	const candidates: string[] = [];
	if (process.env.OMP_REMOTE_RELAY_ENTRY) candidates.push(process.env.OMP_REMOTE_RELAY_ENTRY);
	try {
		const meta = import.meta as unknown as { path?: string; filename?: string; url?: string };
		const here = realpathSync(meta.path || meta.filename || (meta.url ? new URL(meta.url).pathname : ""));
		const hereDir = dirname(here);
		candidates.push(resolve(hereDir, "..", "relay", "src", "index.ts"));
		candidates.push(resolve(hereDir, "..", "..", "relay", "src", "index.ts"));
	} catch {}
	candidates.push(resolve(process.cwd(), "relay", "src", "index.ts"));
	for (const c of candidates) {
		if (c && existsSync(c)) return c;
	}
	return undefined;
}

async function waitForHealth(url: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
			if (r.ok) return true;
		} catch {}
		await new Promise((r) => setTimeout(r, 150));
	}
	return false;
}

async function readConfig(pi: ExtensionAPI): Promise<Config> {
	const flagRelay = pi.getFlag?.("omp-teleport-relay") as string | undefined;
	const explicitRelay = flagRelay || process.env.OMP_REMOTE_RELAY;
	if (explicitRelay) {
		return { relay: explicitRelay.replace(/\/+$/, "") };
	}
	const port = Number(process.env.OMP_REMOTE_PORT ?? 7777);
	const relay = `http://127.0.0.1:${port}`;
	const up = await waitForHealth(relay, 500);
	if (up) return { relay };
	const entry = findRelayEntry();
	if (entry) {
		spawn("bun", ["run", entry], {
			stdio: "ignore",
			env: { ...process.env, OMP_REMOTE_PORT: String(port), OMP_REMOTE_BIND: "0.0.0.0" },
		});
	}
	return { relay };
}

interface ToolCallResult {
	ok: boolean;
	content: Array<{ type: string; text: string }>;
	error?: string;
	duration_ms?: number;
}

interface RelayClient {
	relay: string;
	listMachines(): Promise<Machine[]>;
	callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolCallResult>;
	callToolStream(
		name: string,
		args: Record<string, unknown>,
		onUpdate: (partial: { content: Array<{ type: string; text: string }> }) => void,
		signal?: AbortSignal,
	): Promise<ToolCallResult>;
}
function makeClient(config: Config): RelayClient {
	async function fetchOk(path: string, init?: RequestInit): Promise<Response> {
		try {
			return await fetch(`${config.relay}${path}`, {
				...init,
				headers: { "Content-Type": "application/json", ...(init?.headers as Record<string, string> ?? {}) },
			});
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			throw new Error(`relay at ${config.relay} unreachable: ${msg}. ` +
				`Use /tp restart to bring the relay back up, or restart omp.`);
		}
	}
	async function callToolInternal(
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal | undefined,
		stream: boolean,
		onUpdate: ((p: { content: Array<{ type: string; text: string }> }) => void) | undefined,
	): Promise<ToolCallResult> {
		const init: RequestInit = {
			method: "POST",
			body: JSON.stringify({ name, arguments: args, ...(stream ? { stream: true } : {}) }),
		};
		if (signal) init.signal = signal;
		const r = await fetchOk("/api/tools/call", init);
		if (!r.ok) {
			return { ok: false, content: [{ type: "text", text: `error: relay HTTP ${r.status}: ${await r.text()}` }] };
		}
		if (!stream || !r.body || r.headers.get("Content-Type")?.includes("json")) {
			return r.json() as Promise<ToolCallResult>;
		}
		// SSE
		const reader = r.body.getReader();
		const dec = new TextDecoder();
		let buf = "";
		let result: ToolCallResult | null = null;
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += dec.decode(value, { stream: true });
			let idx;
			while ((idx = buf.indexOf("\n\n")) !== -1) {
				const chunk = buf.slice(0, idx);
				buf = buf.slice(idx + 2);
				const lines = chunk.split("\n");
				let event = "message";
				let data = "";
				for (const line of lines) {
					if (line.startsWith("event: ")) event = line.slice(7).trim();
					else if (line.startsWith("data: ")) data += line.slice(6);
				}
				if (!data) continue;
				try {
					const parsed = JSON.parse(data) as { type?: string; [k: string]: unknown };
					if (event === "progress" && onUpdate && typeof parsed.delta === "string") {
						onUpdate({ content: [{ type: "text", text: parsed.delta }] });
					} else if (event === "result") {
						result = {
							ok: parsed.ok !== false,
							content: Array.isArray(parsed.content) ? parsed.content : [],
							error: typeof parsed.error === "string" ? parsed.error : undefined,
							duration_ms: typeof parsed.duration_ms === "number" ? parsed.duration_ms : undefined,
						};
					}
				} catch {
					// ignore parse errors
				}
			}
		}
		return result ?? { ok: false, content: [{ type: "text", text: "error: SSE stream ended without result event" }] };
	}

	return {
		relay: config.relay,
		async listMachines() {
			const r = await fetchOk("/api/machines", { method: "GET" });
			if (!r.ok) throw new Error(`listMachines: HTTP ${r.status}: ${await r.text()}`);
			const body = (await r.json()) as { machines: Machine[] };
			return body.machines;
		},
		async callTool(name, args, signal) {
			return callToolInternal(name, args, signal, false, undefined);
		},
		async callToolStream(name, args, onUpdate, signal) {
			return callToolInternal(name, args, signal, true, onUpdate);
		},
	};
}

function buildSchema(tool: ToolName): Record<string, unknown> {
	const machineProp = {
		machine: {
			type: "string",
			description: "Machine HWID (from /tp ls — the hex hash in the `id` column). Optional: defaults to the active remote connection.",
		},
	};
	switch (tool) {
		case "bash":
			return { type: "object", properties: { ...machineProp, command: { type: "string" }, cwd: { type: "string" }, timeout: { type: "number" } }, required: ["command"], additionalProperties: false };
		case "read":
			return { type: "object", properties: { ...machineProp, path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["path"], additionalProperties: false };
		case "write":
			return { type: "object", properties: { ...machineProp, path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false };
		case "edit":
			return { type: "object", properties: { ...machineProp, path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" }, replace_all: { type: "boolean" } }, required: ["path", "old_text", "new_text"], additionalProperties: false };
		case "glob":
			return { type: "object", properties: { ...machineProp, pattern: { type: "string" }, cwd: { type: "string" } }, required: ["pattern"], additionalProperties: false };
		case "grep":
			return { type: "object", properties: { ...machineProp, pattern: { type: "string" }, path: { type: "string" }, include: { type: "string" }, max_count: { type: "number" } }, required: ["pattern", "path"], additionalProperties: false };
		case "ls":
			return { type: "object", properties: { ...machineProp, path: { type: "string" } }, required: ["path"], additionalProperties: false };
		case "stat":
			return { type: "object", properties: { ...machineProp, path: { type: "string" } }, required: ["path"], additionalProperties: false };
		case "env":
			return { type: "object", properties: { ...machineProp, name: { type: "string" } }, required: [], additionalProperties: false };
	}
}

function truncate(s: string, n: number): string {
	return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

interface WidgetState {
	mode: "local" | "remote";
	activeMachine?: Machine;
	allMachines: Machine[];
	relay: string;
	forceRemote: boolean;
}

function renderWidget(state: WidgetState): string[] {
	const online = state.allMachines.filter((m) => m.status === "online");
	const total = state.allMachines.length;
	const url = state.relay.replace(/^https?:\/\//, "");
	const lines: string[] = [];

	if (state.mode === "remote" && state.activeMachine) {
		const m = state.activeMachine;
		const status = m.status === "online" ? "●" : "○";
		lines.push(`REMOTE · ${m.label} · ${status} ${m.status} · ${m.hostname} · ${m.os}/${m.arch}`);
		lines.push(`  relay: ${truncate(url, WIDGET_MAX_WIDTH - 12)} · ${online.length}/${total} online · local tools hidden`);
		if (m.status === "online") {
			lines.push("  /tp disconnect to restore local tools");
		} else {
			lines.push(total === 0 ? "  (no machines)" : "  (no online machines)");
		}
	} else if (state.forceRemote) {
		lines.push(`omp-teleport FORCE · ${truncate(url, WIDGET_MAX_WIDTH - 24)} · ${online.length}/${total} online · use bash/read/write with explicit machine`);
		lines.push("  /tp force off to restore local tools");
	} else {
		lines.push(`omp-teleport · ${truncate(url, WIDGET_MAX_WIDTH - 24)} · ${online.length}/${total} online · /tp connect <label> for remote-only mode`);
		if (online.length === 0) {
			lines.push(total === 0 ? "  (no machines — /tp link to mint an install URL)" : "  (no online machines)");
		} else {
			for (const m of online.slice(0, MAX_WIDGET_LINES - 1)) {
				lines.push(`  ● ${truncate(`${m.label} (${m.hostname}, ${m.os}/${m.arch})`, WIDGET_MAX_WIDTH - 4)}`);
			}
			if (online.length > MAX_WIDGET_LINES - 1) {
				lines.push(`  …and ${online.length - (MAX_WIDGET_LINES - 1)} more`);
			}
		}
	}
	return lines;
}

export default function ompRemoteExtension(pi: ExtensionAPI): void {
	pi.setLabel("omp-teleport");

	let cfg: Config | null = null;
	let client: RelayClient | null = null;
	let cachedMachines: Machine[] = [];
	let eventAbort: AbortController | null = null;
	let activeMachine: Machine | null = null;
	let forceRemote = false;

	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let sessionCtx: { ui: { notify: (msg: string, level: string) => void } } | null = null;
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	function updateWidget(): void {
		if (!cfg) return;
		pi.setWidget?.(WIDGET_KEY, renderWidget({
			mode: activeMachine ? "remote" : "local",
			activeMachine: activeMachine ?? undefined,
			allMachines: cachedMachines,
			relay: cfg.relay,
			forceRemote,
		}), { placement: "aboveEditor" });
	}
	async function refreshMachinesFromRelay(): Promise<Machine[]> {
		if (!client) return [];
		const prev = new Map(cachedMachines.map((m) => [m.id, m.status]));
		try {
			cachedMachines = await client.listMachines();
		} catch {
			cachedMachines = [];
		}
		if (activeMachine) {
			const fresh = cachedMachines.find((m) => m.id === activeMachine!.id);
			if (fresh) activeMachine = fresh;
		}
		// Notify on status changes
		if (sessionCtx) {
			for (const m of cachedMachines) {
				const old = prev.get(m.id);
				if (old && old !== m.status) {
					const icon = m.status === "online" ? "●" : "○";
					sessionCtx.ui.notify(`[omp-teleport] ${icon} ${m.hostname} is ${m.status}`, "info");
				} else if (!old && m.status === "online") {
					sessionCtx.ui.notify(`[omp-teleport] ● ${m.hostname} connected`, "info");
				} else if (!old && m.status === "offline") {
					sessionCtx.ui.notify(`[omp-teleport] ○ ${m.hostname} offline (was never seen online)`, "info");
				}
			}
		}
		updateWidget();
		return cachedMachines;
	}

	async function enterRemoteMode(label: string): Promise<{ ok: true; machine: Machine } | { ok: false; reason: string }> {
		if (!client) return { ok: false, reason: "relay not initialized yet" };
		const machines = cachedMachines.length > 0 ? cachedMachines : await client.listMachines();
		cachedMachines = machines;
		const m = machines.find((x) => x.label === label);
		if (!m) return { ok: false, reason: `no machine labeled '${label}'` };
		if (m.status !== "online") return { ok: false, reason: `machine '${label}' is offline` };
		activeMachine = m;
		// Keep every tool that is NOT a local filesystem/process tool,
		// then add the remote_* tools. This automatically includes memory tools,
		// web search, image generation, and anything else that runs locally but
		// doesn't touch the local filesystem.
		const allTools = pi.getAllTools?.() ?? [];
		const allowed = [
			...allTools.filter((t) => !LOCAL_FS_TOOLS.has(t)),
			...REMOTE_TOOL_NAMES,
		];
		await pi.setActiveTools?.(allowed);
		updateWidget();
		return { ok: true, machine: m };
	}

	async function exitRemoteMode(): Promise<void> {
		activeMachine = null;
		forceRemote = false;
		try {
			await pi.setActiveTools?.(pi.getAllTools?.() ?? []);
		} catch {
			// best effort
		}
		updateWidget();
	}

	async function setForceMode(enabled: boolean): Promise<void> {
		forceRemote = enabled;
		if (enabled) {
			// In force mode: hide local filesystem tools, show aliases + remote_* tools.
			// Aliases (bash, read, etc.) wrap the remote versions so the model can use short names.
			const allTools = pi.getAllTools?.() ?? [];
			const allowed = [
				...allTools.filter((t) => !LOCAL_FS_TOOLS.has(t)),
				...TOOL_NAMES.map((t) => `${t}_remote_alias`),
			];
			await pi.setActiveTools?.(allowed);
		} else {
			try {
				await pi.setActiveTools?.(pi.getAllTools?.() ?? []);
			} catch {
				// best effort
			}
		}
		updateWidget();
	}

	async function startEventStream(): Promise<void> {
		if (!client) return;
		eventAbort?.abort();
		while (true) {
			const ac = new AbortController();
			eventAbort = ac;
			const relay = cfg?.relay ?? "";
			try {
				const r = await fetch(`${relay}/api/events`, {
					signal: ac.signal,
				});
			if (!r.ok || !r.body) {
				// fall through to reconnect delay
			} else {
				const reader = r.body.getReader();
				const dec = new TextDecoder();
				let buf = "";
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					buf += dec.decode(value, { stream: true });
					let idx;
					while ((idx = buf.indexOf("\n\n")) !== -1) {
						const chunk = buf.slice(0, idx);
						buf = buf.slice(idx + 2);
						const line = chunk.split("\n").find((l) => l.startsWith("data: "));
						if (!line) continue;
						try {
							const parsed = JSON.parse(line.slice(6)) as { type: string; [k: string]: unknown };
							if (parsed.type === "snapshot" || parsed.type === "change") {
								void refreshMachinesFromRelay();
							}
						} catch {
							// ignore
						}
					}
				}
			}
			} catch (e) {
				if (e instanceof Error && e.name === "AbortError") return;
			}
			await sleep(2000);
		}
	}
	pi.on("session_start", async (_e, ctx) => {
		sessionCtx = ctx;
		cfg = await readConfig(pi);
		client = makeClient(cfg);
		const url = cfg.relay.replace(/^https?:\/\//, "");
		ctx.ui.notify(`omp-teleport: connected to ${url}`, "info");
		updateWidget();
		await refreshMachinesFromRelay();
		void startEventStream();
		pollTimer = setInterval(() => void refreshMachinesFromRelay(), 3000);
	});

	pi.on("session_shutdown", () => {
		eventAbort?.abort();
		if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
		pi.setWidget?.(WIDGET_KEY, undefined);
		activeMachine = null;
	});


	// Register all 9 tools synchronously in the factory. The `machine`
	// arg is optional in the schema; the execute function falls back
	// to the active machine when set, otherwise requires it explicitly.
	for (const tool of TOOL_NAMES) {
		pi.registerTool({
			name: `remote_${tool}`,
			label: `Remote ${tool}`,
			description: TOOL_DESCRIPTIONS[tool],
		parameters: buildSchema(tool) as never,
			async execute(_id, params, signal, onUpdate) {
				if (!client) {
					return {
						content: [{ type: "text", text: "error: omp-teleport relay not initialized yet (wait for the session to start)" }],
						isError: true,
					};
				}
				const args = (params ?? {}) as { machine?: string; [k: string]: unknown };
				const explicit = typeof args.machine === "string" && args.machine ? args.machine : null;
				const machine = explicit ?? activeMachine?.id;
				if (!machine) {
					return {
						content: [{ type: "text", text: "error: no `machine` arg and no active remote connection — set one with /tp connect <label>, or pass `machine` explicitly. See /tp ls for available machines." }],
						isError: true,
					};
				}
				const RETRY_DELAYS = [500, 1000, 2000];
				for (let attempt = 0; ; attempt++) {
					try {
						if (tool === "bash" && onUpdate) {
							const result = await client.callToolStream(`${machine}__bash`, args, onUpdate, signal);
							return { content: result.content, isError: !result.ok };
						}
						const result = await client.callTool(`${machine}__${tool}`, args, signal);
						return { content: result.content, isError: !result.ok };
					} catch (e) {
						if (attempt < RETRY_DELAYS.length && !signal?.aborted) {
							await sleep(RETRY_DELAYS[attempt]);
							continue;
						}
						return {
							content: [{ type: "text", text: `error: ${e instanceof Error ? e.message : String(e)}` }],
							isError: true,
						};
					}
				}
			},
		});
	}

	// Register aliases (bash, read, etc.) that dispatch to remote_* tools when force mode is on.
	// Allows short names instead of remote_bash, remote_read, etc.
	for (const tool of TOOL_NAMES) {
		pi.registerTool({
			name: `${tool}_remote_alias`,
			label: tool.charAt(0).toUpperCase() + tool.slice(1),
			description: TOOL_DESCRIPTIONS[tool],
			parameters: buildSchema(tool) as never,
			async execute(_id, params, signal, onUpdate) {
				if (!client) {
					return {
						content: [{ type: "text", text: "error: omp-teleport relay not initialized yet (wait for the session to start)" }],
						isError: true,
					};
				}
				const args = (params ?? {}) as { machine?: string; [k: string]: unknown };
				const explicit = typeof args.machine === "string" && args.machine ? args.machine : null;
				const machine = explicit ?? activeMachine?.id;
				if (!machine) {
					return {
						content: [{ type: "text", text: "error: no `machine` arg and no active connection — use /tp connect <label>, or pass `machine` explicitly. See /tp ls for available machines." }],
						isError: true,
					};
				}
				const RETRY_DELAYS = [500, 1000, 2000];
				for (let attempt = 0; ; attempt++) {
					try {
						if (tool === "bash" && onUpdate) {
							const result = await client.callToolStream(`${machine}__bash`, args, onUpdate, signal);
							return { content: result.content, isError: !result.ok };
						}
						const result = await client.callTool(`${machine}__${tool}`, args, signal);
						return { content: result.content, isError: !result.ok };
					} catch (e) {
						if (attempt < RETRY_DELAYS.length && !signal?.aborted) {
							await sleep(RETRY_DELAYS[attempt]);
							continue;
						}
						return {
							content: [{ type: "text", text: `error: ${e instanceof Error ? e.message : String(e)}` }],
							isError: true,
						};
					}
				}
			},
		});
	}

	pi.registerCommand("tp", {
		description: "Manage omp-teleport machines. Subcommands: ls, refresh, pick, connect <machine>, disconnect, link, help",
		handler: async (args, ctx) => {
			if (!client) {
				ctx.ui.notify("omp-teleport: relay not initialized yet", "warn");
				return;
			}
			const trimmed = args.trim();
			if (trimmed === "help" || trimmed === "?") {
				ctx.ui.notify(
					"omp-teleport commands:\n\n" +
					"  /tp ls                       — list connected machines\n" +
					"  /tp pick                     — interactive machine picker\n" +
					"  /tp connect <machine>        — enter remote-only mode (hides local tools)\n" +
					"  /tp disconnect               — exit remote-only mode (restores local tools)\n" +
					"  /tp link                     — print tokenless install one-liners\n" +
					"  /tp force [on|off]           — toggle force mode (aliases short names to remote tools)\n" +
					"  /tp refresh                  — re-poll machine list from relay\n" +
					"  /tp restart                  — reconnect extension to relay\n" +
					"  /tp help                     — show this help message",
					"info"
				);
				return;
			}
			if (!trimmed || trimmed === "ls") {
				try {
					const machines = await client.listMachines();
					if (machines.length === 0) {
						ctx.ui.notify("omp-teleport: no machines registered", "info");
						return;
					}
					const lines = machines.map((m) => {
						const cap = m.capabilities.tools.join(",");
						return `${m.id}\t${m.os}/${m.arch}\t[${cap}]`;
					});
					const head = activeMachine ? `omp-teleport machines (active: ${activeMachine.label}):` : "omp-teleport machines:";
					ctx.ui.notify(`${head}\n${lines.join("\n")}`, "info");
				} catch (e) {
					ctx.ui.notify(`omp-teleport ls failed: ${e instanceof Error ? e.message : String(e)}`, "error");
				}
				return;
			}
			if (trimmed === "pick") {
				try {
					const machines = await client.listMachines();
					const online = machines.filter((m) => m.status === "online");
					if (online.length === 0) {
						ctx.ui.notify("omp-teleport pick: no online machines", "warn");
						return;
					}
					const picked = await ctx.ui.select?.(
						"omp-teleport: pick a machine",
						online.map((m) => ({
							label: `${m.id}\t${m.os}/${m.arch}`,
						})),
					);
					if (typeof picked === "string" && picked) {
						const id = picked.split("\t")[0];
						const machine = online.find((m) => m.id === id);
						if (!machine) {
							ctx.ui.notify(`omp-teleport pick: no machine with id '${id}'`, "error");
							return;
						}
						const res = await enterRemoteMode(machine.label);
						if (res.ok) {
							ctx.ui.notify(
								`omp-teleport: REMOTE mode active on ${res.machine.id} (${res.machine.hostname}, ${res.machine.os}/${res.machine.arch}). Local filesystem tools are hidden. /tp disconnect to restore.`,
								"info",
							);
						} else {
							const errRes = res as { ok: false; reason: string };
							ctx.ui.notify(`omp-teleport pick connect failed: ${errRes.reason}`, "error");
						}
					}
				} catch (e) {
					ctx.ui.notify(`omp-teleport pick failed: ${e instanceof Error ? e.message : String(e)}`, "error");
				}
				return;
			}
			if (trimmed === "disconnect") {
				await exitRemoteMode();
				ctx.ui.notify("omp-teleport: disconnected — local tools restored", "info");
				return;
			}
			if (trimmed.startsWith("connect ")) {
				const label = trimmed.slice("connect ".length).trim();
				if (!label) {
					ctx.ui.notify("usage: /tp connect <machine>", "warn");
					return;
				}
				const res = await enterRemoteMode(label);
				if (res.ok) {
					ctx.ui.notify(
						`omp-teleport: REMOTE mode active on ${res.machine.label} (${res.machine.hostname}, ${res.machine.os}/${res.machine.arch}). Local filesystem tools are hidden. /tp disconnect to restore.`,
						"info",
					);
				} else {
					const errRes = res as { ok: false; reason: string };
					ctx.ui.notify(`omp-teleport connect failed: ${errRes.reason}`, "error");
				}
				return;
			}
			if (trimmed === "link") {
				const base = client.relay;
				const shUrl = `${base}/sh`;
				const pshUrl = `${base}/psh`;
				ctx.ui.notify(
					`omp-teleport installer:\n\n` +
					`Linux/macOS:\n` +
					`  curl -sSL '${shUrl}' | sh -\n\n` +
					`Windows (PowerShell):\n` +
					`  powershell -ep bypass -c "irm '${pshUrl}' | iex"`,
					"info"
				);
				return;
			}
			if (trimmed === "refresh") {
				const machines = await refreshMachinesFromRelay();
				const online = machines.filter((m) => m.status === "online").length;
				ctx.ui.notify(`omp-teleport: ${online} online / ${machines.length} total machine(s)`, "info");
				return;
			}
			if (trimmed === "restart") {
				try {
					cfg = await readConfig(pi);
					client = makeClient(cfg);
					eventAbort?.abort();
					pi.setActiveTools?.(pi.getAllTools?.() ?? []);
					activeMachine = null;
					forceRemote = false;
					await refreshMachinesFromRelay();
					void startEventStream();
					const url = cfg.relay.replace(/^https?:\/\//, "");
					ctx.ui.notify(`omp-teleport: reconnected to ${url}`, "info");
				} catch (e) {
					ctx.ui.notify(`omp-teleport restart failed: ${e instanceof Error ? e.message : String(e)}`, "error");
				}
				return;
			}
			if (trimmed === "force" || trimmed === "force on") {
				await setForceMode(true);
				ctx.ui.notify("omp-teleport: FORCE mode on — use bash, read, write, etc. with explicit `machine` arg (or set active machine with /tp connect). /tp force off to disable.", "info");
				return;
			}
			if (trimmed === "force off") {
				await setForceMode(false);
				ctx.ui.notify("omp-teleport: FORCE mode off — local tools restored", "info");
				return;
			}
			ctx.ui.notify("usage: /tp <subcommand>. Type /tp help for details.", "warn");
		},
	});

	pi.registerCommand("psh", {
		description: "Windows PowerShell installer. Shows install URL for Windows machines.",
		handler: async (args, ctx) => {
			if (!client) {
				ctx.ui.notify("omp-teleport: relay not initialized yet", "warn");
				return;
			}
			const trimmed = args.trim();
			
			// Get relay URL
			const url = cfg?.relay || "unknown";
			const httpBase = url.replace(/^ws/, "http").replace(/\/ws\/connector$/, "");
			
			if (!trimmed || trimmed === "url") {
				// Show Windows install URL
				const installUrl = `${httpBase}/psh`;
				ctx.ui.notify(`omp-teleport Windows installer:\n\n${installUrl}\n\nRun in PowerShell:\npowershell -ep bypass -c "irm '${installUrl}' | iex"`, "info");
				return;
			}
			
			if (trimmed === "help") {
				ctx.ui.notify(
					"omp-teleport Windows installer\n\n" +
					"Usage:\n" +
					"  /psh          — show Windows install URL\n" +
					"  /psh url      — show Windows install URL\n" +
					"  /psh help     — show this help\n\n" +
					"To install on Windows:\n" +
					"1. Open PowerShell as normal user (no admin needed)\n" +
					"2. Run: powershell -ep bypass -c \"irm 'URL' | iex\"\n\n" +
					"The installer will:\n" +
					"- Download and install Python if not found\n" +
					"- Download and run the connector\n" +
					"- Create a persistent connection to the relay",
					"info"
				);
				return;
			}
			
			ctx.ui.notify("usage: /psh [url|help]", "warn");
		},
	});
}
