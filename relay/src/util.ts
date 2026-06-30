// Shared utilities.

export function safeLabel(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 40) || "machine";
}

export function toolNameFor(label: string, tool: string): string {
	return `${safeLabel(label)}__${tool}`;
}

export function parseToolName(name: string): { label: string; tool: string } | undefined {
	const idx = name.indexOf("__");
	if (idx <= 0) return undefined;
	return { label: name.slice(0, idx), tool: name.slice(idx + 2) };
}
