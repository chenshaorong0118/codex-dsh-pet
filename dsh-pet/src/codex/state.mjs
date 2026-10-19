// Only lifecycle metadata enters this store. Prompts, tool arguments and outputs never do.
export const EVENTS = new Set([
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
  'Error',
]);
const PRIORITY = { waiting: 60, working: 50, thinking: 40, result: 30, error: 20, success: 10 };
export class ActivityStore {
  constructor({ now = Date.now, terminalMs = 10000, staleMs = 1800000 } = {}) {
    this.now = now;
    this.terminalMs = terminalMs;
    this.staleMs = staleMs;
    this.sessions = new Map();
    this.seen = new Map();
    this.lastEventAt = null;
  }
  accept(event) {
    if (
      !event ||
      !EVENTS.has(event.hook_event_name) ||
      typeof event.session_id !== 'string' ||
      event.session_id.length > 160 ||
      !event.session_id
    )
      throw new Error('Invalid lifecycle event');
    if (event.id && this.seen.has(event.id)) return false;
    const now = this.now();
    const sent = Number(event.sent_at ?? now);
    if (!Number.isFinite(sent) || sent > now + 60000 || sent < now - 300000) return false;
    if (event.id) {
      this.seen.set(event.id, now);
      if (this.seen.size > 2000) this.seen.delete(this.seen.keys().next().value);
    }
    const key = event.session_id;
    let old = this.sessions.get(key);
    // Late events from a previous turn cannot resurrect a finished/newer turn.
    if (old && sent < old.sent) return false;
    if (
      old?.turn &&
      event.turn_id &&
      old.turn !== event.turn_id &&
      !['UserPromptSubmit', 'SessionStart'].includes(event.hook_event_name)
    )
      return false;
    const name = event.hook_event_name;
    if (name === 'SessionEnd') {
      this.sessions.delete(key);
      this.lastEventAt = now;
      return true;
    }
    if (name === 'SessionStart') {
      this.lastEventAt = now;
      return true;
    }
    if (name === 'UserPromptSubmit' || !old)
      old = { children: new Set(), state: 'thinking', turn: event.turn_id, sent: 0 };
    if (event.turn_id) old.turn = event.turn_id;
    old.sent = sent;
    old.updated = now;
    if (name === 'SubagentStart') {
      old.children.add(String(event.agent_id ?? 'child'));
      old.state = 'working';
    } else if (name === 'SubagentStop') {
      old.children.delete(String(event.agent_id ?? 'child'));
      if (old.finishing && old.children.size === 0) old.state = 'success';
    } else if (name === 'Stop') {
      old.finishing = true;
      old.state = old.children.size ? 'working' : 'success';
    } else if (name === 'Interrupt') {
      old.children.clear();
      old.state = null;
      old.finishing = false;
    } else if (name === 'Error' || (name === 'PostToolUse' && event.tool_failed === true)) old.state = 'error';
    else if (
      name === 'PermissionRequest' ||
      (name === 'PreToolUse' && /request_user_input|ask_user|request_input/.test(event.tool_name ?? ''))
    )
      old.state = 'waiting';
    else if (name === 'PreCompact' || name === 'PostCompact' || name === 'PostToolUse') old.state = 'result';
    else if (name === 'PreToolUse') old.state = 'working';
    else if (name === 'UserPromptSubmit') old.state = 'thinking';
    if (name === 'PreToolUse' && /request_user_input_async$/.test(event.tool_name ?? '')) old.pendingQuestion = true;
    if (old.pendingQuestion && name !== 'Interrupt') old.state = 'waiting';
    this.sessions.set(key, old);
    this.lastEventAt = now;
    return true;
  }
  snapshot() {
    const now = this.now();
    for (const [id, s] of this.sessions) {
      const ttl = ['success', 'error', null].includes(s.state) ? this.terminalMs : this.staleMs;
      if (now - s.updated >= ttl) this.sessions.delete(id);
    }
    const entries = [...this.sessions.entries()].filter(([, s]) => s.state);
    entries.sort((a, b) => PRIORITY[b[1].state] - PRIORITY[a[1].state] || b[1].updated - a[1].updated);
    return {
      state: entries[0]?.[1].state ?? null,
      sessions: entries.map(([id, s]) => ({ id, state: s.state, updated: s.updated, children: s.children.size })),
      lastEventAt: this.lastEventAt,
    };
  }
}

export function usageBalance(response) {
  const buckets = response?.rateLimitsByLimitId ? Object.values(response.rateLimitsByLimitId) : [response?.rateLimits];
  const limits = [];
  for (const bucket of buckets)
    for (const key of ['primary', 'secondary']) {
      const w = bucket?.[key];
      if (!w || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) continue;
      const mins = w.windowDurationMins;
      const duration =
        mins == null
          ? '窗口'
          : mins % 1440 === 0
            ? `${mins / 1440}天`
            : mins % 60 === 0
              ? `${mins / 60}h`
              : `${mins}分钟`;
      limits.push({
        label: `${bucket.limitName || bucket.limitId || 'Codex'} ${duration}`,
        percent: Math.min(100, Math.max(0, w.usedPercent)),
        ...(w.resetsAt == null ? {} : { resetsAt: new Date(w.resetsAt * 1000).toISOString() }),
      });
    }
  if (!limits.length)
    return {
      ok: false,
      provider: 'codex',
      reason: 'unsupported',
      message: '当前账号未提供额度窗口；API 计费账号没有套餐额度读数。',
    };
  return { ok: true, provider: 'codex', shape: 'windows', data: { limits } };
}
