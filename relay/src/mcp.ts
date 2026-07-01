// MCP (Model Context Protocol) Streamable HTTP server.
//
// Exposes the connected machines' tools under /mcp. Tool naming:
//   <safe_label>__<tool_name>   e.g. db_prod_01__bash
// Tools/list returns all (machine, tool) pairs currently online.

import { z } from "zod";
import type { ContentBlock, MachineRecord, PendingCall, ToolResultFrame } from "./types.ts";
import { safeLabel, parseToolName } from "./util.ts";
import { dispatchToolCall } from "./connector-ws.ts";
import type { Store } from "./store.ts";

const SERVER_INFO = {
	name: "omp-teleport-relay",
	version: "0.1.0",
} as const;

const JSON_RPC_VERSION = "2.0";

// ---- JSON-RPC envelope ----

const JsonRpcRequest = z.object({
	jsonrpc: z.literal(JSON_RPC_VERSION),
	id: z.union([z.string(), z.number()]).optional(),
	method: z.string().min(1).max(128),
	params: z.unknown().optional(),
});

interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number | null;
	[Symbol.iterator]?: never;
}

function rpcError(id: string | number | null, code: number, message: string, data?: unknown): object {
	return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function rpcResult(id: string | number | null, result: unknown): object {
	return { jsonrpc: "2.0", id, result };
}

function errorCode(s: string): number {
	switch (s) {
		case "parse":
			return -32700;
		case "invalid_request":
			return -32600;
		case "method_not_found":
			return -32601;
		case "invalid_params":
			return -32602;
		case "internal":
			return -32603;
		default:
			return -32000;
	}
}

// ---- tool catalog ----

interface McpTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

const ToolArgSchema: Record<string, z.ZodTypeAny> = {
	bash: z.object({
		command: z.string().min(1),
		cwd: z.string().optional(),
		timeout: z.number().int().min(1).max(3600).optional(),
	}),
	read: z.object({
		path: z.string().min(1),
		offset: z.number().int().min(0).optional(),
		limit: z.number().int().min(0).optional(),
	}),
	write: z.object({
		path: z.string().min(1),
		content: z.string(),
	}),
	edit: z.object({
		path: z.string().min(1),
		old_text: z.string(),
		new_text: z.string(),
		replace_all: z.boolean().optional(),
	}),
	glob: z.object({
		pattern: z.string().min(1),
		cwd: z.string().optional(),
	}),
	grep: z.object({
		pattern: z.string().min(1),
		path: z.string().min(1),
		include: z.string().optional(),
		max_count: z.number().int().min(1).max(100000).optional(),
	}),
	ls: z.object({
		path: z.string().min(1),
	}),
	stat: z.object({
		path: z.string().min(1),
	}),
	env: z.object({
		name: z.string().optional(),
	}),
};

const TOOL_DESCRIPTIONS: Record<string, string> = {
	bash: "Run a shell command on the remote machine. Returns combined stdout+stderr and [exit: N] line. cwd/timeout optional.",
	read: "Read a file. offset/limit in bytes; omit for full read (capped at 4MB).",
	write: "Write content to a file (atomic replace).",
	edit: "Replace old_text with new_text in a file. Pass replace_all=true to replace every occurrence; otherwise the match must be unique.",
	glob: "List files matching a glob pattern (recursive with **).",
	grep: "Regex search across files. Returns 'path:line:match' lines.",
	ls: "List a directory (one entry per line, with kind and size).",
	stat: "Return file metadata.",
	env: "Read environment variables. Pass name to get a single var, omit for all.",
};

function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
	if (schema instanceof z.ZodObject) {
		const shape = schema.shape as Record<string, z.ZodTypeAny>;
		const properties: Record<string, unknown> = {};
		const required: string[] = [];
		for (const [k, v] of Object.entries(shape)) {
			properties[k] = zodToJsonSchema(v);
			if (!(v instanceof z.ZodOptional)) required.push(k);
		}
		return {
			type: "object",
			properties,
			...(required.length ? { required } : {}),
			additionalProperties: false,
		};
	}
	if (schema instanceof z.ZodString) return { type: "string" };
	if (schema instanceof z.ZodNumber) return { type: "number" };
	if (schema instanceof z.ZodBoolean) return { type: "boolean" };
	if (schema instanceof z.ZodOptional) return zodToJsonSchema(schema.unwrap());
	return {};
}

function listTools(store: Store): McpTool[] {
	const out: McpTool[] = [];
	for (const m of store.listOnlineMachines()) {
		const label = safeLabel(m.label);
		for (const t of m.capabilities.tools) {
			const argSchema = ToolArgSchema[t];
			if (!argSchema) continue;
			out.push({
				name: `${label}__${t}`,
				description: `[${m.label} (${m.hostname})] ${TOOL_DESCRIPTIONS[t] ?? t}`,
				inputSchema: zodToJsonSchema(argSchema),
			});
		}
	}
	return out;
}

function findMachineByLabel(store: Store, label: string): MachineRecord | undefined {
	for (const m of store.listOnlineMachines()) {
		if (safeLabel(m.label) === label) return m;
	}
	return undefined;
}

// ---- per-call dispatch ----

interface DispatchArgs {
	store: Store;
	toolName: string;
	args: Record<string, unknown>;
}

interface DispatchResult {
	content: ContentBlock[];
	isError: boolean;
}

function makeCallId(): string {
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	return `t_${Buffer.from(bytes).toString("base64url")}`;
}

function dispatchCall({ store, toolName, args }: DispatchArgs): Promise<DispatchResult> {
	const parsed = parseToolName(toolName);
	if (!parsed) {
		return Promise.resolve({
			content: [{ type: "text", text: `error: tool name must look like '<machine>__<tool>' (got '${toolName}')` }],
			isError: true,
		});
	}
	const machine = findMachineByLabel(store, parsed.label);
	if (!machine) {
		return Promise.resolve({
			content: [{ type: "text", text: `error: no online machine with label '${parsed.label}'` }],
			isError: true,
		});
	}
	const argSchema = ToolArgSchema[parsed.tool];
	if (!argSchema) {
		return Promise.resolve({
			content: [{ type: "text", text: `error: machine '${parsed.label}' has no tool '${parsed.tool}'` }],
			isError: true,
		});
	}
	const validation = argSchema.safeParse(args);
	if (!validation.success) {
		return Promise.resolve({
			content: [{ type: "text", text: `error: invalid args: ${validation.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` }],
			isError: true,
		});
	}
	const timeoutMs =
		parsed.tool === "bash" && typeof validation.data.timeout === "number"
			? validation.data.timeout * 1000
			: 60_000;
	const callId = makeCallId();
	const { promise, resolve, reject } = Promise.withResolvers<ToolResultFrame>();
	const pending: PendingCall = {
		id: callId,
		name: parsed.tool,
		args: validation.data as Record<string, unknown>,
		timeoutMs,
		resolve,
		reject,
		timer: undefined,
	};
	pending.timer = setTimeout(() => {
		pending.reject(new Error(`tool call timed out after ${timeoutMs}ms`));
		machine.pendingCalls.delete(callId);
		// Best-effort cancel to connector
		try {
			(machine.ws as { send?: (s: string) => void }).send?.(JSON.stringify({ type: "tool.cancel", id: callId }));
		} catch {
			// ignore
		}
	}, timeoutMs);
	const ok = dispatchToolCall(store, machine.id, pending);
	if (!ok) {
		if (pending.timer) clearTimeout(pending.timer);
		return Promise.resolve({
			content: [{ type: "text", text: "error: failed to dispatch to connector" }],
			isError: true,
		});
	}
	return promise
		.then((frame) => ({
			content: frame.content ?? [],
			isError: !frame.ok,
		}))
		.catch((err: unknown) => ({
			content: [{ type: "text", text: `error: ${err instanceof Error ? err.message : String(err)}` }],
			isError: true,
		}));
}

// ---- HTTP handler ----

export async function handleMcpRequest(req: Request, store: Store): Promise<Response> {

	if (req.method === "GET") {
		// Open SSE listener for server-initiated notifications.
		let unsub: (() => void) | null = null;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const enc = new TextEncoder();
				const send = (data: object) => {
					try {
						controller.enqueue(enc.encode(`event: message\ndata: ${JSON.stringify(data)}\n\n`));
					} catch {
						// stream closed
					}
				};
				// Initial endpoint event (matches legacy MCP behavior, optional)
				controller.enqueue(enc.encode(`event: endpoint\ndata: /mcp\n\n`));
				unsub = store.onMachinesChange((reason) => {
					send({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: { reason } });
				});
				const cleanup = () => {
					unsub?.();
					unsub = null;
					try {
						controller.close();
					} catch {
						// already closed
					}
				};
				req.signal.addEventListener("abort", cleanup);
			},
			cancel() {
				unsub?.();
				unsub = null;
			},
		});
		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache, no-transform",
				Connection: "keep-alive",
			},
		});
	}

	if (req.method === "DELETE") {
		return new Response(null, { status: 204 });
	}

	if (req.method !== "POST") {
		return new Response("method not allowed", { status: 405 });
	}

	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return new Response(JSON.stringify(rpcError(null, errorCode("parse"), "invalid json")), {
			status: 400,
			headers: { "Content-Type": "application/json" },
		});
	}

	const parsed = JsonRpcRequest.safeParse(body);
	if (!parsed.success) {
		return new Response(JSON.stringify(rpcError(null, errorCode("invalid_request"), "invalid jsonrpc envelope")), {
			status: 400,
			headers: { "Content-Type": "application/json" },
		});
	}

	const { id, method, params } = parsed.data;

	if (method === "initialize") {
		return new Response(JSON.stringify(rpcResult(id ?? null, {
			protocolVersion: "2025-03-26",
			capabilities: { tools: { listChanged: true } },
			serverInfo: SERVER_INFO,
		})), { headers: { "Content-Type": "application/json" } });
	}

	if (method === "notifications/initialized") {
		return new Response(null, { status: 204 });
	}

	if (method === "ping") {
		return new Response(JSON.stringify(rpcResult(id ?? null, {})), {
			headers: { "Content-Type": "application/json" },
		});
	}

	if (method === "tools/list") {
		return new Response(JSON.stringify(rpcResult(id ?? null, { tools: listTools(store) })), {
			headers: { "Content-Type": "application/json" },
		});
	}

	if (method === "tools/call") {
		const Params = z.object({
			name: z.string().min(1),
			arguments: z.record(z.unknown()).optional(),
		});
		const v = Params.safeParse(params);
		if (!v.success) {
			return new Response(JSON.stringify(rpcError(id ?? null, errorCode("invalid_params"), "tools/call params invalid")), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		}
		// Stream the result as SSE. The response returns immediately
		// so multiple tool calls don't block each other (no HOL blocking).
		const enc = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const send = (event: string, data: unknown) => {
					try {
						controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
					} catch {
						// stream closed
					}
				};
				send("started", { id, name: v.data.name });
				const result = dispatchCall({ store, toolName: v.data.name, args: v.data.arguments ?? {} });
				result.then((res) => {
					send("result", res);
					try { controller.close(); } catch { /* ignore */ }
				}).catch((err: unknown) => {
					send("result", { content: [{ type: "text", text: `error: ${err instanceof Error ? err.message : String(err)}` }], isError: true });
					try { controller.close(); } catch { /* ignore */ }
				});
			},
			cancel() {
				// client disconnected — no need to cancel the tool call
			},
		});
		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache, no-transform",
			},
		});
	}

	return new Response(JSON.stringify(rpcError(id ?? null, errorCode("method_not_found"), `unknown method: ${method}`)), {
		status: 404,
		headers: { "Content-Type": "application/json" },
	});
}
