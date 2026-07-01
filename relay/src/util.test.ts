import { describe, expect, test } from "bun:test";
import { safeLabel, parseToolName, toolNameFor } from "./util";

describe("safeLabel", () => {
  test("lowercases and replaces non-alnum with underscores", () => {
    expect(safeLabel("Web Server")).toBe("web_server");
    expect(safeLabel("DB-Prod/01")).toBe("db_prod_01");
    expect(safeLabel("  hello world  ")).toBe("hello_world");
  });

  test("strips leading/trailing underscores", () => {
    expect(safeLabel("  leading")).toBe("leading");
    expect(safeLabel("trailing  ")).toBe("trailing");
    expect(safeLabel("  both  ")).toBe("both");
  });

  test("truncates to 40 chars", () => {
    const long = "a".repeat(50);
    expect(safeLabel(long).length).toBe(40);
  });

  test("falls back to 'machine' for empty result", () => {
    expect(safeLabel("___")).toBe("machine");
    expect(safeLabel("")).toBe("machine");
  });
});

describe("parseToolName", () => {
  test("splits on __", () => {
    const result = parseToolName("web_server__bash");
    expect(result).toBeDefined();
    expect(result!.label).toBe("web_server");
    expect(result!.tool).toBe("bash");
  });

  test("returns undefined when no __ separator", () => {
    expect(parseToolName("naked")).toBeUndefined();
  });

  test("returns undefined when __ is at the start", () => {
    expect(parseToolName("__bash")).toBeUndefined();
  });
});

describe("toolNameFor", () => {
  test("combines safeLabel with tool name", () => {
    expect(toolNameFor("Web Server", "bash")).toBe("web_server__bash");
    expect(toolNameFor("DB-Prod/01", "read")).toBe("db_prod_01__read");
  });
});

describe("round-trip: tool naming and parsing", () => {
  test("safeLabel(label) matches the parsed label from toolNameFor", () => {
    const labels = ["Web Server", "DB-Prod/01", "my.host.com", "simple"];
    for (const raw of labels) {
      const safed = safeLabel(raw);
      const name = toolNameFor(raw, "bash");
      const parsed = parseToolName(name);
      expect(parsed).toBeDefined();
      expect(parsed!.label).toBe(safed);
      expect(parsed!.tool).toBe("bash");
    }
  });

  test("label survives round-trip even with edge-case chars", () => {
    // The key property: whatever safeLabel produces must match
    // the label component of toolNameFor output after parsing.
    // This is the invariant that the relay depends on.
    const raw = "  Prod / DB @ #1  ";
    const safed = safeLabel(raw);
    expect(safed).toBe("prod_db_1"); // non-alnum become _, trim underscores
    const name = toolNameFor(raw, "grep");
    const parsed = parseToolName(name);
    expect(parsed!.label).toBe(safed);
  });
});
