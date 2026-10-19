import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'PreCompact',
  'PostCompact',
  'Stop',
  'Interrupt',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
];
export function mergeHooks(document, command, remove = false) {
  const result = structuredClone(document);
  result.hooks ||= {};
  for (const event of Object.keys(result.hooks)) {
    result.hooks[event] = result.hooks[event]
      .map((group) => ({ ...group, hooks: (group.hooks || []).filter((h) => h.command !== command) }))
      .filter((group) => group.hooks.length);
    if (!result.hooks[event].length) delete result.hooks[event];
  }
  if (!remove)
    for (const event of HOOK_EVENTS)
      (result.hooks[event] ||= []).push({ hooks: [{ type: 'command', command, timeout: 2 }] });
  return result;
}
export function installHooks({ codexHome, root, data, node = process.execPath, remove = false }) {
  const target = join(codexHome, 'hooks.json');
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(data, { recursive: true });
  const command = `"${node}" "${join(root, 'src', 'codex', 'hook.mjs')}" "${data}"`;
  const previous = existsSync(target) ? readFileSync(target, 'utf8').replace(/^\uFEFF/, '') : '{}';
  const document = JSON.parse(previous);
  // An invalid existing file is deliberately not overwritten.
  const updated = mergeHooks(document, command, remove);
  const backup = join(data, `hooks.${Date.now()}.backup.json`);
  writeFileSync(backup, previous);
  writeFileSync(target + '.codex-pet.tmp', JSON.stringify(updated, null, 2) + '\n');
  renameSync(target + '.codex-pet.tmp', target);
  return { target, backup, events: remove ? 0 : HOOK_EVENTS.length };
}
