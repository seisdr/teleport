#!/usr/bin/env bun
// omp-teleport: manage the relay and connector.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

interface CliConfig {
	relay: string;
	token: string;
}

function loadConfig(allowBootstrap = false): CliConfig {
	const relay = process.env.OMP_REMOTE_RELAY ?? "http://127.0.0.1:7777";
	const token = process.env.OMP_REMOTE_TOKEN ?? "";
	if (!relay) {
		console.error("error: OMP_REMOTE_RELAY not set");
		process.exit(2);
	}
	if (!token && !allowBootstrap) {
		console.error("error: OMP_REMOTE_TOKEN not set");
		process.exit(2);
	}
	return { relay: relay.replace(/\/+$/, ""), token };
}

interface Machine {
	id: string;
	label: string;
	hostname: string;
	os: string;
	arch: string;
	status: "online" | "offline";
	capabilities: { tools: string[] };
}

async function apiGet<T>(cfg: CliConfig, path: string): Promise<T> {
	const r = await fetch(`${cfg.relay}${path}`, { headers: { Authorization: `Bearer ${cfg.token}` } });
	if (!r.ok) {
		console.error(`error: HTTP ${r.status}: ${await r.text()}`);
		process.exit(1);
	}
	return r.json() as Promise<T>;
}

async function apiPost<T>(cfg: CliConfig, path: string, body: unknown): Promise<T> {
	const r = await fetch(`${cfg.relay}${path}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!r.ok) {
		console.error(`error: HTTP ${r.status}: ${await r.text()}`);
		process.exit(1);
	}
	return r.json() as Promise<T>;
}

async function cmdToken(label: string, ttlSec: number | undefined, onlyUrl: boolean): Promise<void> {
	const cfg = loadConfig();
	const res = await apiPost<{
		token: { secret: string; label: string; created_at: number; expires_at?: number };
		install_url: string;
	}>(cfg, "/api/tokens", { label, ...(ttlSec ? { ttl_sec: ttlSec } : {}) });
	if (onlyUrl) {
		console.log(res.install_url);
		return;
	}
	console.log(`label:    ${res.token.label}`);
	console.log(`created:  ${new Date(res.token.created_at).toISOString()}`);
	if (res.token.expires_at) console.log(`expires:  ${new Date(res.token.expires_at).toISOString()}`);
	console.log(`install:  ${res.install_url}`);
	console.log(`windows:  ${res.install_url.replace("/sh", "/psh")}`);
	console.log("");
	console.log("");
	console.log("Linux/macOS:");
	console.log(`  curl -sSL '${res.install_url}' | sh -`);
	console.log("");
	console.log("Windows (PowerShell):");
	console.log(`  powershell -ep bypass -c "irm '${res.install_url.replace("/sh", "/psh")}' | iex"`);
}

async function cmdLs(): Promise<void> {
	const cfg = loadConfig();
	const { machines } = await apiGet<{ machines: Machine[] }>(cfg, "/api/machines");
	if (machines.length === 0) {
		console.log("(no machines registered)");
		return;
	}
	const rows: string[] = [`${"STATUS".padEnd(7)} ${"LABEL".padEnd(20)} ${"HOST".padEnd(20)} ${"OS/ARCH".padEnd(14)} TOOLS`];
	for (const m of machines) {
		const status = m.status === "online" ? "online" : "offline";
		const marker = m.status === "online" ? "*" : ".";
		rows.push(`${(marker + " " + status).padEnd(7)} ${m.label.padEnd(20)} ${m.hostname.padEnd(20)} ${(m.os + "/" + m.arch).padEnd(14)} ${m.capabilities.tools.join(",")}`);
	}
	console.log(rows.join("\n"));
}

async function cmdOperators(): Promise<void> {
	const cfg = loadConfig();
	const { operators } = await apiGet<{ operators: Array<{ name: string; secret: string; created_at: number }> }>(cfg, "/api/operators");
	for (const o of operators) {
		console.log(`${o.name.padEnd(20)} ${o.secret}  (created ${new Date(o.created_at).toISOString()})`);
	}
}

async function cmdConfig(): Promise<void> {
	const cfg = loadConfig(true);
	const statePath = process.env.OMP_REMOTE_STATE_DIR ?? join(homedir(), ".omp-teleport", "state.json");
	if (!cfg.token && existsSync(statePath)) {
		try {
			const data = JSON.parse(readFileSync(statePath, "utf8")) as { operatorTokens: Array<{ name: string; secret: string }> };
			const op = data.operatorTokens[0];
			if (op) {
				console.log(`relay:    ${cfg.relay}`);
				console.log(`operator: ${op.name}`);
				console.log(`token:    ${op.secret}`);
				return;
			}
		} catch {
			// fall through
		}
	}
	console.log(`relay:    ${cfg.relay}`);
	console.log(`operator: ${cfg.token || "(not set; OMP_REMOTE_TOKEN empty and no state.json)"}`);
}

function cmdStart(): void {
	const stateDir = process.env.OMP_REMOTE_STATE_DIR ?? join(homedir(), ".omp-teleport");
	mkdirSync(stateDir, { recursive: true });
	const relayEntry = resolve(import.meta.dir, "..", "relay", "src", "index.ts");
	if (!existsSync(relayEntry)) {
		console.error(`error: relay not found at ${relayEntry}`);
		process.exit(1);
	}
	const env: NodeJS.ProcessEnv = { ...process.env, OMP_REMOTE_STATE_DIR: stateDir };
	const port = process.env.OMP_REMOTE_PORT ?? "7777";
	const bind = process.env.OMP_REMOTE_BIND ?? "127.0.0.1";
	console.log(`[omp-teleport] starting relay on ${bind}:${port}, state dir ${stateDir}`);
	const child = spawn("bun", ["run", relayEntry], { stdio: "inherit", env });
	child.on("exit", (code) => process.exit(code ?? 0));
	process.on("SIGINT", () => child.kill("SIGINT"));
	process.on("SIGTERM", () => child.kill("SIGTERM"));
}

const HELP_TEXT = `usage: omp-teleport <subcommand> [args]

subcommands:
  start                            start the relay in the foreground
  token <label> [ttl_sec]          issue a join token; print the install URL
  install-url <label> [ttl_sec]    same as 'token' but only print the URL
  ls | machines                    list connected machines
  operators                        list operator tokens
  config                           print resolved relay URL + operator token

environment:
  OMP_REMOTE_RELAY      relay base URL (default: http://127.0.0.1:7777)
  OMP_REMOTE_TOKEN      operator token
  OMP_REMOTE_STATE_DIR  relay state dir (default: ~/.omp-teleport)
  OMP_REMOTE_PORT       port for 'start' (default: 7777)
  OMP_REMOTE_BIND       bind address for 'start' (default: 127.0.0.1)
`;

function help(): void {
	console.log(HELP_TEXT);
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: { help: { type: "boolean", short: "h" } },
	});
	if (values.help || positionals.length === 0) {
		help();
		return;
	}
	const [sub, ...rest] = positionals;
	switch (sub) {
		case "start":
			cmdStart();
			return;
		case "token": {
			const label = rest[0];
			if (!label) {
				console.error("usage: omp-teleport token <label> [ttl_sec]");
				process.exit(2);
			}
			const ttl = rest[1] ? Number.parseInt(rest[1], 10) : undefined;
			await cmdToken(label, ttl, false);
			return;
		}
		case "install-url": {
			const label = rest[0];
			if (!label) {
				console.error("usage: omp-teleport install-url <label> [ttl_sec]");
				process.exit(2);
			}
			const ttl = rest[1] ? Number.parseInt(rest[1], 10) : undefined;
			await cmdToken(label, ttl, true);
			return;
		}
		case "ls":
		case "machines":
			await cmdLs();
			return;
		case "operators":
			await cmdOperators();
			return;
		case "config":
			await cmdConfig();
			return;
		default:
			console.error(`unknown subcommand: ${sub}`);
			help();
			process.exit(2);
	}
}

main().catch((e: unknown) => {
	console.error("error:", e);
	process.exit(1);
});
