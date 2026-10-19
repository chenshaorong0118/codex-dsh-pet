#!/usr/bin/env node
import { readFileSync, existsSync, mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHooks } from './install.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const data = resolve(process.env.CODEX_PET_DATA || join(root, 'data'));
const codexHome = process.env.CODEX_HOME || join(process.env.USERPROFILE || process.env.HOME, '.codex');
mkdirSync(data, { recursive: true });
async function running() {
  try {
    const r = JSON.parse(readFileSync(join(data, 'runtime.json'), 'utf8'));
    const u = new URL(r.origin);
    if (u.hostname !== '127.0.0.1' || u.protocol !== 'http:') return null;
    const response = await fetch(u.origin + '/api/status', {
      headers: { authorization: `Bearer ${r.token}` },
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok || (await response.json()).version !== '1.0.0') return null;
    return r;
  } catch {
    return null;
  }
}
function openSettings(r) {
  const url = `${r.origin}/#${r.token}`;
  if (process.platform === 'win32') spawn('explorer.exe', [url], { windowsHide: true, stdio: 'ignore' }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' }).unref();
}
async function main() {
  const command = process.argv[2] || 'start';
  if (['install-hooks', 'uninstall-hooks'].includes(command)) {
    const result = installHooks({ root, data, codexHome, remove: command === 'uninstall-hooks' });
    console.log(`${command}: ${result.events} events; backup: ${result.backup}`);
    if (command === 'install-hooks') console.log('请在 Codex 中审核并信任新增的宠物 Hooks；未信任前不会执行。');
    return;
  }
  let r = await running();
  if (command === 'status') {
    console.log(r ? `Running: ${r.origin}` : 'Stopped');
    return;
  }
  if (command === 'stop') {
    if (r) {
      await fetch(r.origin + '/api/shutdown', {
        method: 'POST',
        headers: { authorization: `Bearer ${r.token}` },
        signal: AbortSignal.timeout(5000),
      });
      console.log('桌宠已关闭');
    } else console.log('桌宠未运行');
    return;
  }
  if (!['start', 'settings'].includes(command))
    throw new Error('Commands: start, stop, status, settings, install-hooks, uninstall-hooks');
  if (!r) {
    const log = openSync(join(data, 'pet.log'), 'w');
    const child = spawn(process.execPath, [join(root, 'lib', 'codex.js')], {
      cwd: root,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', log, log],
      env: { ...process.env, CODEX_PET_DATA: data },
    });
    child.once('error', (e) => console.error(e.message));
    child.unref();
    closeSync(log);
    for (let i = 0; i < 80; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      r = await running();
      if (r) break;
    }
    if (!r) throw new Error('桌宠启动失败，请查看 data/pet.log；端口可能已被其他程序占用。');
  }
  console.log(`桌宠运行中：${r.origin}`);
  if (command === 'settings') openSettings(r);
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
