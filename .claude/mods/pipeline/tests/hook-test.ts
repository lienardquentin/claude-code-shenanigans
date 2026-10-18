import { test as kitTest } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// A test that starts the session drives every part's clock: each runs in well under the kit's 5000 ms alone, but the
// files run side by side, and on a loaded machine the slowest neared it (cleanup's 31 s advance, 4.5 s on 2026-10-18).
// A hang still fails, four times later
const HOOK_TIMEOUT_MS = 20_000

/** A test of the hooks: the kit's test, with the time a full session start needs under load. */
export const test = (name: string, body: TestBody): void => kitTest(name, { timeoutMs: HOOK_TIMEOUT_MS }, body)
