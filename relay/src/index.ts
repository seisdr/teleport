// omp-teleport relay: HTTP + WebSocket + MCP server.

import { mkdirSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import {
	createConnectorHandler,
} from "./connector-ws.ts";
import { handleMcpRequest } from "./mcp.ts";
import { handleHttpRequest } from "./http.ts";
import { Store } from "./store.ts";

const DEFAULT_PORT = Number(process.env.OMP_REMOTE_PORT ?? 7777);
const DEFAULT_BIND = process.env.OMP_REMOTE_BIND ?? "0.0.0.0";
const PUBLIC_URL = process.env.OMP_REMOTE_PUBLIC_URL ?? "";
const STATE_DIR = process.env.OMP_REMOTE_STATE_DIR ?? join(homedir(), ".omp-teleport");


function getLocalIp(): string {
	const nets = networkInterfaces();
	for (const name of Object.keys(nets)) {
		for (const net of nets[name] || []) {
			if (net.family === "IPv4" && !net.internal) {
				return net.address;
			}
		}
	}
	return "127.0.0.1";
}

async function main(): Promise<void> {
	mkdirSync(STATE_DIR, { recursive: true });
	const statePath = join(STATE_DIR, "state.json");
	const store = new Store(statePath);

	const port = DEFAULT_PORT;
	const bind = DEFAULT_BIND;

	const server = Bun.serve({
		port,
		hostname: bind,
		async fetch(req, server) {
			const url = new URL(req.url);

			// Connector WebSocket upgrade
			if (url.pathname === "/ws/connector") {
				if (req.headers.get("upgrade") !== "websocket") {
					return new Response("expected websocket upgrade", { status: 400 });
				}
				server.upgrade(req, { data: {} });
				return undefined;
			}
			// HTTP routes (/sh, /api/*, /connector.py, /health, /mcp)
			if (url.pathname === "/mcp") {
				return handleMcpRequest(req, store);
			}
			// Other HTTP routes
			return handleHttpRequest(req, store, { publicUrl: PUBLIC_URL });
		},
		websocket: createConnectorHandler(store),
	});
	const ip = bind === "0.0.0.0" ? getLocalIp() : bind;
	console.log(`[relay] state dir: ${STATE_DIR}`);
	console.log(`[relay] one-liner install: curl http://${ip}:${server.port}/sh | sh -`);
	console.log(`[relay] connector websocket:   ws://${ip}:${server.port}/ws/connector`);
	console.log(`[relay] MCP streamable HTTP:   http://${ip}:${server.port}/mcp`);

	const shutdown = () => {
		console.log("\n[relay] shutting down");
		server.stop();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

if (import.meta.main) {
	main().catch((e: unknown) => {
		console.error("[relay] fatal:", e);
		process.exit(1);
	});
}
