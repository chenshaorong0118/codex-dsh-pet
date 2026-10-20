#!/usr/bin/env node
// Fail-open hook: returns no instructions, never blocks Codex, strips all user content.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export function metadata(input) {
  const out = { id: randomUUID(), sent_at: Date.now() };
  for (const key of ['hook_event_name', 'session_id', 'turn_id', 'tool_name', 'agent_id'])
    if (typeof input[key] === 'string') out[key] = input[key].slice(0, 160);
  if (input.tool_response && typeof input.tool_response === 'object')
    out.tool_failed = input.tool_response.isError === true || input.tool_response.is_error === true;
  return out;
}
export async function forward(input, dataDir) {
  const report = (value) => {
    try {
      writeFileSync(
        join(dataDir, 'hook-delivery.json'),
        JSON.stringify({
          at: Date.now(),
          event: typeof input.hook_event_name === 'string' ? input.hook_event_name : null,
          ...value,
        }),
      );
    } catch {}
  };
  report({ phase: 'received' });
  if (process.env.CODEX_PET_CHILD === '1') return;
  const runtime = JSON.parse(readFileSync(join(dataDir, 'runtime.json'), 'utf8'));
  const url = new URL(runtime.origin);
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('Invalid local pet address');
  const response = await fetch(`${url.origin}/api/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${runtime.token}` },
    body: JSON.stringify(metadata(input)),
    signal: AbortSignal.timeout(650),
  });
  report({ phase: 'delivered', status: response.status });
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/hook.mjs')) {
  try {
    let raw = '';
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (raw.length > 1048576) throw new Error('Hook payload too large');
    }
    await forward(JSON.parse(raw), process.argv[2]);
  } catch {
    /* A missing/stopped pet must never affect the coding session. */
  }
  process.stdout.write('{}\n');
}
