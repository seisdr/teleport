// Shared types for the relay.

export type TimerHandle = ReturnType<typeof setTimeout>;
export type ToolName = "bash" | "read" | "write" | "edit" | "glob" | "grep" | "ls" | "stat" | "env";

export const ALL_TOOLS: readonly ToolName[] = [
	"bash", "read", "write", "edit", "glob", "grep", "ls", "stat", "env",
] as const;

export interface ConnectorCapabilities {
	tools: ToolName[];
	max_concurrent: number;
	supports_progress: boolean;
	supports_cancel: boolean;
}

export interface RegisterFrame {
	type: "register";
	machine_id: string;
	hostname: string;
	os: string;
	arch: string;
	label: string;
	version: string;
	capabilities: ConnectorCapabilities;
}

export interface RegisteredFrame {
	type: "registered";
	machine_id: string;
	heartbeat_ms: number;
}

export interface ToolCallFrame {
	type: "tool.call";
	id: string;
	name: ToolName | string;
	args: Record<string, unknown>;
	timeout_ms?: number;
}

export interface ToolResultFrame {
	type: "tool.result";
	id: string;
	ok: boolean;
	content?: ContentBlock[];
	error?: string;
	duration_ms?: number;
}

export interface ToolProgressFrame {
	type: "tool.progress";
	id: string;
	delta: string;
}

export interface ToolCancelFrame {
	type: "tool.cancel";
	id: string;
}

export interface PingFrame {
	type: "ping";
	t: number;
}

export interface PongFrame {
	type: "pong";
	t: number;
}

export interface DisconnectFrame {
	type: "disconnect";
	reason: string;
}

export type ConnectorFrame =
	| RegisterFrame
	| RegisteredFrame
	| ToolCallFrame
	| ToolResultFrame
	| ToolProgressFrame
	| ToolCancelFrame
	| PingFrame
	| PongFrame
	| DisconnectFrame;

export interface ContentBlock {
	type: "text";
	text: string;
}

export type TokenKind = "join" | "operator";

export interface JoinToken {
	kind: "join";
	secret: string;
	label: string;
	created_at: number;
	expires_at?: number;
	used_at?: number;
}

export interface OperatorToken {
	kind: "operator";
	secret: string;
	created_at: number;
	name: string;
}

export type Token = JoinToken | OperatorToken;

export interface MachineRecord {
	id: string;
	label: string;
	hostname: string;
	os: string;
	arch: string;
	version: string;
	capabilities: ConnectorCapabilities;
	connected_at: number;
	last_seen_at: number;
	status: "online" | "offline";
	ws: unknown; // ServerWebSocket<unknown> - opaque to avoid bun-types leak
	pendingCalls: Map<string, PendingCall>;
}

export interface PendingCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
	timeoutMs: number;
	resolve: (frame: ToolResultFrame) => void;
	reject: (err: Error) => void;
	timer: TimerHandle | undefined;
	/** Called for each `tool.progress` WS frame the connector emits. */
	onProgress?: (delta: string) => void;
}

export interface RelayState {
	port: number;
	bind: string;
	publicBaseUrl: string;
	statePath: string;
	operatorTokens: OperatorToken[];
	joinTokens: JoinToken[];
}
