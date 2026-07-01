import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "./store";
import { safeLabel, parseToolName, toolNameFor } from "./util";
import { handleHttpRequest } from "./http";
import type { MachineRecord } from "./types";

const TMP = mkdtempSync("/tmp/relay-test-");

function tmpStore(): Store {
  const p = join(TMP, `state-${Math.random().toString(36).slice(2)}.json`);
  return new Store(p);
}

function makeMachine(overrides: Partial<MachineRecord> = {}): MachineRecord {
  return {
    id: "test-a1b2c3",
    label: "Test Machine",
    hostname: "test-host",
    os: "linux",
    arch: "x64",
    version: "0.1.0",
    capabilities: { tools: ["bash", "read"], max_concurrent: 4, supports_progress: false, supports_cancel: false },
    connected_at: Date.now(),
    last_seen_at: Date.now(),
    status: "online",
    ws: null,
    pendingCalls: new Map(),
    ...overrides,
  };
}

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("machine lookup pattern", () => {
  test("safeLabel(m.label) matches parsed tool name label", () => {
    const store = tmpStore();
    const m = makeMachine({ id: "web-server-a1b2c3", label: "Web Server" });
    store.upsertMachine(m);

    const parsed = parseToolName("web_server__bash");
    expect(parsed).toBeDefined();
    const label = parsed!.label; // "web_server"

    // OLD broken pattern: m.id === label
    const byId = store.listOnlineMachines().find((x) => x.id === label);
    expect(byId).toBeUndefined(); // machine_id ≠ safeLabel(label)

    // FIXED pattern: safeLabel(m.label) === label
    const byLabel = store.listOnlineMachines().find((x) => safeLabel(x.label) === label);
    expect(byLabel).toBeDefined();
    expect(byLabel!.id).toBe("web-server-a1b2c3");
    expect(byLabel!.label).toBe("Web Server");
  });

  test("toolNameFor round-trip: safeLabel(raw) matches parsed label", () => {
    const store = tmpStore();
    const rawLabel = "Prod DB / 01";
    const m = makeMachine({ id: "prod-db-xyz", label: rawLabel });
    store.upsertMachine(m);

    const toolName = toolNameFor(rawLabel, "grep");
    const parsed = parseToolName(toolName);
    expect(parsed).toBeDefined();

    const found = store.listOnlineMachines().find((x) => safeLabel(x.label) === parsed!.label);
    expect(found).toBeDefined();
    expect(found!.label).toBe(rawLabel);
  });

  test("multiple machines with different labels all resolve correctly", () => {
    const store = tmpStore();
    const machines: MachineRecord[] = [
      makeMachine({ id: "m1", label: "Alpha" }),
      makeMachine({ id: "m2", label: "Beta Server" }),
      makeMachine({ id: "m3", label: "Gamma-DB" }),
    ];
    for (const m of machines) store.upsertMachine(m);

    for (const m of machines) {
      const safed = safeLabel(m.label);
      const found = store.listOnlineMachines().find((x) => safeLabel(x.label) === safed);
      expect(found).toBeDefined();
      expect(found!.id).toBe(m.id);
    }
  });
});

describe("PS1 installer template", () => {
  test("rendered PS1 script contains $ prefix on RELAY_HTTP and RELAY_WS", async () => {
    const store = tmpStore();
    const req = new Request("http://localhost:7777/psh", { method: "GET" });
    const res = await handleHttpRequest(req, store, { publicUrl: "https://relay.example.com" });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('$RELAY_HTTP = "https://relay.example.com"');
    expect(body).toContain('$RELAY_WS = "wss://relay.example.com/ws/connector"');
  });
});

describe("store.onMachinesChange unsubscription", () => {
  test("returned unsubscribe function removes the listener", () => {
    const store = tmpStore();
    const calls: string[] = [];
    const unsub = store.onMachinesChange((reason) => {
      calls.push(reason);
    });

    const m = makeMachine({ id: "u1", label: "U1" });
    store.upsertMachine(m);
    expect(calls.length).toBe(1);
    expect(calls[0]).toBe("machine_connected");

    unsub();

    const m2 = makeMachine({ id: "u2", label: "U2" });
    store.upsertMachine(m2);
    expect(calls.length).toBe(1); // still 1 — listener was removed
  });

  test("multiple listeners are independent", () => {
    const store = tmpStore();
    const a: string[] = [];
    const b: string[] = [];
    const unsubA = store.onMachinesChange((r) => a.push(r));
    store.onMachinesChange((r) => b.push(r));

    const m = makeMachine({ id: "multi1", label: "Multi" });
    store.upsertMachine(m);
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);

    unsubA();

    const m2 = makeMachine({ id: "multi2", label: "Multi2" });
    store.upsertMachine(m2);
    expect(a.length).toBe(1); // unsubscribed
    expect(b.length).toBe(2); // still active
  });
});
