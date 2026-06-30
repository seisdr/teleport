// Auth helpers: no-op open access. Every connection is allowed.
// Machine IDs use hostname_random format to prevent conflicts.

import type { Store } from "./store.ts";

export function requireOperator(_store: Store, _headers: Headers): { ok: true; name: string } {
	return { ok: true, name: "open" };
}
