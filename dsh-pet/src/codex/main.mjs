#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, renameSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { apply } from '../host/index.ts';
import { readUserConfig, saveUserConfig, userConfigUnparsable } from '../host/config.ts';
import { createStandaloneContext, createStandaloneLogger } from '../standalone/context.ts';
import { ActivityStore, usageBalance } from './state.mjs';
import { CodexClient } from './client.mjs';
import { serve, readJson, json } from './server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = resolve(process.env.CODEX_PET_DATA || join(root, 'data'));
const codexHome = process.env.CODEX_HOME || join(process.env.USERPROFILE || process.env.HOME, '.codex');
mkdirSync(data, { recursive: true });
process.env.DSH_HOME = data;
process.env.CODEX_PET_DATA = data;
if (!process.env.DSH_PET_ELECTRON_PATH && existsSync(join(root, 'runtime', 'electron', 'electron.exe')))
  process.env.DSH_PET_ELECTRON_PATH = join(root, 'runtime', 'electron', 'electron.exe');
if (process.argv.includes('--headless')) process.env.DSH_PET_ELECTRON_PATH = join(data, 'no-electron');
const userFile = join(data, 'dsh-pet', 'main-config.jsonc');
mkdirSync(dirname(userFile), { recursive: true });
if (!existsSync(userFile))
  writeFileSync(
    userFile,
    JSON.stringify(
      {
        pets: [
          {
            id: 'main',
            name: 'Codex 桌宠',
            size: 360,
            display: process.argv.includes('--headless') ? 'none' : 'desktop',
            balanceEnabled: true,
            whisperEnabled: false,
            workStatusEnabled: true,
            fixedEnabled: false,
            position: { corner: 'bottom-right', marginX: 30, marginY: 30 },
          },
        ],
        notificationsEnabled: false,
        whisperPrompt: '你是桌面上的Q版蓝发小女仆。陪主人写代码，说话自然俏皮，简短温柔。',
        eventsRefreshSec: { balance: 1800, whisper: 1800 },
      },
      null,
      2,
    ),
  );
const logger = createStandaloneLogger();
const listeners = new Map();
const context = createStandaloneContext({ port: () => Number(new URL(service.origin).port), logger });
context.ctx.on = (name, fn) => {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
  return () => listeners.get(name).delete(fn);
};
const emit = (name, ...args) => {
  for (const fn of listeners.get(name) || []) fn(...args);
};
const client = new CodexClient({ cwd: data, codexHome });
context.ctx.agentDefaultModel.currentSelection = () => ({ provider: 'codex', model: 'current' });
context.ctx.llm = {
  listProviders: () => [{ id: 'codex', name: 'Codex' }],
  listModels: async () => [{ id: 'current', name: '当前 Codex 模型' }],
  resolveModelInfo: async () => undefined,
  async *stream(options) {
    yield { type: 'text', text: await client.chat(options) };
  },
};
let usageCache = null;
let usageAt = 0;
let usagePending;
context.ctx.codexUsage = async () => {
  if (usageCache && Date.now() - usageAt < 60000) return usageCache;
  if (usagePending) return usagePending;
  usagePending = (async () => {
    try {
      const raw = await client.rateLimits();
      usageCache = usageBalance(raw);
      usageAt = Date.now();
      return usageCache;
    } catch {
      return {
        ok: false,
        provider: 'codex',
        reason: 'fetch-error',
        message: 'Codex 额度查询失败，请检查账号登录或网络；没有用本地估计值替代。',
      };
    } finally {
      usagePending = null;
    }
  })();
  return usagePending;
};
const store = new ActivityStore();
let signature = '';
let seq = 0;
let closing = false;
function publish() {
  const snapshot = store.snapshot();
  const key = JSON.stringify([snapshot.state, snapshot.sessions.map((s) => [s.id, s.state, s.children])]);
  if (key === signature) return;
  signature = key;
  let notificationsEnabled = false;
  try {
    notificationsEnabled = readUserConfig({ userFile })?.notificationsEnabled === true;
  } catch {}
  writeFileSync(
    join(data, 'activity.tmp'),
    JSON.stringify({ state: snapshot.state, ts: Date.now(), notificationsEnabled }),
  );
  renameSync(join(data, 'activity.tmp'), join(data, 'activity.json'));
  const event = {
    thinking: { type: 'turn/start' },
    working: { type: 'tool/call', data: { name: 'codex' } },
    result: { type: 'tool/result' },
    waiting: { type: 'approval/asked' },
    success: { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    error: { type: 'turn/end', data: { reason: { kind: 'error' } } },
  }[snapshot.state] || { type: 'turn/end', data: { reason: { kind: 'aborted' } } };
  emit('session/event', { id: 'codex-display' }, { ...event, seq: ++seq });
}
const token = randomBytes(32).toString('hex');
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(ticker);
  client.close();
  await context.dispose();
  await service.close();
  try {
    const r = JSON.parse(readFileSync(join(data, 'runtime.json'), 'utf8'));
    if (r.pid === process.pid) unlinkSync(join(data, 'runtime.json'));
  } catch {}
  process.exit(0);
}
const service = await serve({
  port: Number(process.env.CODEX_PET_PORT || 31380),
  token,
  routes: context.routes,
  page: readFileSync(join(root, 'src', 'codex', 'settings.html'), 'utf8'),
  shutdown,
  async api(path, req, res) {
    if (path === '/api/status' && req.method === 'GET')
      return json(res, 200, {
        ...store.snapshot(),
        chatBusy: client.busy,
        chatModel: client.model || null,
        usage: usageCache,
        version: '1.0.1',
        upstream: '0.3.7',
      });
    if (path === '/api/event' && req.method === 'POST') {
      const body = await readJson(req, 4096);
      store.accept(body);
      publish();
      return json(res, 200, { ok: true });
    }
    if (path === '/api/preferences' && req.method === 'POST') {
      const body = await readJson(req);
      const paths = { userFile, defaultFile: join(root, 'assets', 'config.jsonc') };
      if (userConfigUnparsable(paths)) throw new Error('配置文件损坏，请先修复或还原备份');
      if (
        !Array.isArray(body.pets) ||
        !body.pets.length ||
        body.pets.length > 8 ||
        !body.pets.every(
          (p) =>
            typeof p.name === 'string' &&
            p.name.trim() &&
            p.name.length <= 40 &&
            Number.isFinite(p.size) &&
            p.size >= 180 &&
            p.size <= 900 &&
            ['desktop', 'none'].includes(p.display),
        )
      )
        throw new Error('宠物配置无效');
      if (new Set(body.pets.map((p) => p.id)).size !== body.pets.length) throw new Error('宠物标识不能重复');
      if (
        typeof body.whisperPrompt !== 'string' ||
        body.whisperPrompt.length > 4000 ||
        !Number.isFinite(body.eventsRefreshSec?.whisper) ||
        body.eventsRefreshSec.whisper < 300 ||
        body.eventsRefreshSec.whisper > 86400
      )
        throw new Error('偏好配置无效');
      const existing = readUserConfig(paths) || {};
      const clean = saveUserConfig(
        { pets: body.pets, notificationsEnabled: body.notificationsEnabled === true },
        {
          ...existing,
          whisperPrompt: body.whisperPrompt,
          eventsRefreshSec: { balance: 1800, whisper: body.eventsRefreshSec.whisper },
        },
      );
      if (!clean) throw new Error('宠物配置无效');
      writeFileSync(userFile + '.backup', readFileSync(userFile));
      writeFileSync(userFile + '.tmp', JSON.stringify(clean, null, 2));
      renameSync(userFile + '.tmp', userFile);
      const response = await fetch(service.origin + '/dsh-pet-7340/reload', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('设置已保存，但桌宠重载失败；请重新启动');
      return json(res, 200, { ok: true });
    }
    if (path === '/api/usage' && req.method === 'POST') return json(res, 200, await context.ctx.codexUsage());
    return json(res, 404, { error: '接口不存在' });
  },
});
context.ctx.connection.authenticatedUrl = () => `${service.origin}/#${token}`;
writeFileSync(
  join(data, 'runtime.json'),
  JSON.stringify({ pid: process.pid, origin: service.origin, token, startedAt: new Date().toISOString() }),
  { mode: 0o600 },
);
apply(context.ctx);
const ticker = setInterval(publish, 1000);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (e) => {
  logger.error(`宿主错误：${e.message}`);
  void shutdown();
});
logger.info(`Codex 桌宠已启动：${service.origin}（仅本机）。用 Open-Settings.ps1 打开设置。`);
