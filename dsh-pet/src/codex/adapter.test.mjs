import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { ActivityStore, usageBalance } from './state.mjs';
import { metadata } from './hook.mjs';
import { serve, sameSecret, readJson, json } from './server.mjs';
import { execArgs } from './client.mjs';
import { mergeHooks, windowsHookCommand } from './install.mjs';
function harness() {
  let now = 1000000;
  const store = new ActivityStore({ now: () => now });
  let id = 0;
  return {
    store,
    advance: (ms) => (now += ms),
    send: (hook_event_name, extra = {}) =>
      store.accept({ hook_event_name, session_id: 'a', sent_at: now, id: String(++id), ...extra }),
    state: () => store.snapshot().state,
  };
}
test('new prompt -> working -> result -> completed -> idle', () => {
  const h = harness();
  h.send('UserPromptSubmit', { turn_id: 't' });
  assert.equal(h.state(), 'thinking');
  h.send('PreToolUse', { turn_id: 't' });
  assert.equal(h.state(), 'working');
  h.send('PostToolUse', { turn_id: 't' });
  assert.equal(h.state(), 'result');
  h.send('Stop', { turn_id: 't' });
  assert.equal(h.state(), 'success');
  h.advance(10001);
  assert.equal(h.state(), null);
});
test('waiting outranks other running sessions; active work outranks another completion/error', () => {
  const h = harness();
  h.send('PreToolUse');
  h.send('PermissionRequest', { session_id: 'b' });
  assert.equal(h.state(), 'waiting');
  h.send('Stop', { session_id: 'b' });
  assert.equal(h.state(), 'working');
  h.send('Error', { session_id: 'b' });
  assert.equal(h.state(), 'working');
});
test('questions wait, result resumes, interruption clears only its session', () => {
  const h = harness();
  h.send('PreToolUse', { tool_name: 'functions.request_user_input' });
  assert.equal(h.state(), 'waiting');
  h.send('PostToolUse');
  assert.equal(h.state(), 'result');
  h.send('PreToolUse', { session_id: 'b' });
  h.send('Interrupt');
  assert.equal(h.state(), 'working');
});
test('asynchronous question stays waiting across independent work until the next user message', () => {
  const h = harness();
  h.send('PreToolUse', { tool_name: 'functions.request_user_input_async' });
  h.send('PostToolUse');
  h.send('PreToolUse');
  h.send('Stop');
  assert.equal(h.state(), 'waiting');
  h.send('UserPromptSubmit');
  assert.equal(h.state(), 'thinking');
});
test('children must finish before a parent celebrates', () => {
  const h = harness();
  h.send('SubagentStart', { agent_id: 'x' });
  h.send('SubagentStart', { agent_id: 'y' });
  h.send('Stop');
  assert.equal(h.state(), 'working');
  h.send('SubagentStop', { agent_id: 'x' });
  assert.equal(h.state(), 'working');
  h.send('SubagentStop', { agent_id: 'y' });
  assert.equal(h.state(), 'success');
});
test('old turn and duplicate events cannot resurrect stale activity', () => {
  const h = harness();
  h.send('UserPromptSubmit', { turn_id: 'new' });
  assert.equal(h.send('Stop', { turn_id: 'old' }), false);
  h.send('PreToolUse', { id: 'duplicate' });
  h.send('Stop');
  assert.equal(h.send('PreToolUse', { id: 'duplicate' }), false);
  assert.equal(h.state(), 'success');
});
test('stale events and crashed sessions expire; SessionStart is idle', () => {
  const h = harness();
  h.send('SessionStart');
  assert.equal(h.state(), null);
  assert.equal(h.send('PreToolUse', { sent_at: -1 }), false);
  h.send('PreToolUse');
  h.advance(1800001);
  assert.equal(h.state(), null);
});
test('invalid lifecycle events are rejected', () => {
  const h = harness();
  assert.throws(() => h.send('ExecuteAnything'));
  assert.throws(() => h.send('Stop', { session_id: '' }));
});
test('hook strips prompts, arguments, answers, cwd and outputs', () => {
  const result = metadata({
    hook_event_name: 'PreToolUse',
    session_id: 'a',
    prompt: 'secret',
    cwd: 'private',
    tool_input: { secret: 'x' },
    tool_response: 'secret',
  });
  assert.equal(result.session_id, 'a');
  assert.deepEqual(Object.keys(result).sort(), ['hook_event_name', 'id', 'sent_at', 'session_id']);
});
test('usage preserves real duration, unknown reset and missing windows without fictional monthly values', () => {
  const result = usageBalance({
    rateLimitsByLimitId: {
      codex: {
        limitId: 'codex',
        primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: null },
        secondary: null,
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.limits.length, 1);
  assert.equal(result.data.limits[0].label, 'codex 5h');
  assert.equal(result.data.limits[0].percent, 0);
  assert.equal(result.data.monthly, undefined);
  assert.equal(result.data.limits[0].resetsAt, undefined);
  assert.equal(usageBalance({}).ok, false);
});
test('pet inference is ephemeral, read-only and excludes user config and shell', () => {
  const args = execArgs('model');
  for (const arg of [
    '--ephemeral',
    '--ignore-user-config',
    'read-only',
    'features.shell_tool=false',
    'features.multi_agent=false',
  ])
    assert.ok(args.includes(arg));
  assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
});
test('secret comparison rejects Unicode/length confusion', () => {
  assert.equal(sameSecret('a', 'a'), true);
  assert.equal(sameSecret('é', 'a'), false);
  assert.equal(sameSecret(undefined, 'x'), false);
});
test('hook install is idempotent and uninstall preserves other hooks and fields', () => {
  const original = {
    description: 'existing',
    custom: 1,
    hooks: { Stop: [{ matcher: 'existing', hooks: [{ type: 'command', command: 'other' }] }] },
  };
  const once = mergeHooks(original, 'pet');
  assert.equal(once.hooks.Stop.length, 2);
  assert.deepEqual(mergeHooks(once, 'pet'), once);
  assert.deepEqual(mergeHooks(once, 'pet', true), original);
  assert.equal(original.hooks.Stop.length, 1);
});
test('Windows launcher keeps spaces, Unicode and shell syntax inside literal path arguments', () => {
  const paths = [
    String.raw`C:\Program Files\node.exe`,
    String.raw`C:\宠物 O'Brien\hook.mjs`,
    String.raw`C:\data\$HOME; $(exit) & pets`,
  ];
  const command = windowsHookCommand(...paths);
  assert.match(command, /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
  const script = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le');
  assert.equal(
    script,
    "& 'C:\\Program Files\\node.exe' 'C:\\宠物 O''Brien\\hook.mjs' 'C:\\data\\$HOME; $(exit) & pets'",
  );
});
test('Windows override survives reinstall and is removed without touching other platform overrides', () => {
  const original = {
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other', commandWindows: 'other-windows' }] }] },
  };
  const once = mergeHooks(original, 'pet', false, 'pet-windows');
  assert.equal(once.hooks.Stop.at(-1).hooks[0].commandWindows, 'pet-windows');
  assert.deepEqual(mergeHooks(once, 'pet', false, 'pet-windows'), once);
  assert.deepEqual(mergeHooks(once, 'pet', true), original);
});
test('loopback server blocks missing auth, hostile Origin, Host, CSRF and oversized hook bodies', async () => {
  const service = await serve({
    port: 0,
    token: 'safe',
    routes: [],
    page: '<html>pet</html>',
    shutdown: () => {},
    api: async (path, req, res) => json(res, 200, await readJson(req, 10)),
  });
  try {
    assert.equal((await fetch(service.origin + '/api/status')).status, 401);
    assert.equal(
      (await fetch(service.origin + '/health', { headers: { origin: 'https://evil.invalid' } })).status,
      403,
    );
    const hostileHost = await new Promise((resolve, reject) => {
      const req = httpRequest(service.origin + '/health', { headers: { host: 'evil.invalid' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(hostileHost, 403);
    assert.equal((await fetch(service.origin + '/api/status', { headers: { cookie: 'codex_pet=safe' } })).status, 401);
    assert.equal(
      (
        await fetch(service.origin + '/api/session', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"token":"bad"}',
        })
      ).status,
      403,
    );
    const valid = await fetch(service.origin + '/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"token":"safe"}',
    });
    assert.equal(valid.status, 200);
    assert.match(valid.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    const huge = await fetch(service.origin + '/api/event', {
      method: 'POST',
      headers: { authorization: 'Bearer safe', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x'.repeat(100) }),
    });
    assert.equal(huge.status, 413);
  } finally {
    await service.close();
  }
});
