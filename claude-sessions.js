// claude-sessions.js — which Claude Code sessions are live in some other process?
//
// Claude Code writes one file per *running* session to <config>/sessions/<pid>.json.
// Indexing those by sessionId tells us whether resuming an id would collide with a
// process Switchboard does not own — two `claude` processes appending to one transcript.
//
// Everything here fails open. Any dir-level failure yields an empty map and a single
// malformed file is skipped rather than fatal: the registry is internal to Claude Code
// (observed on v2.1.250) and may change shape or vanish in an update, and resume must
// never stop working because we could not read it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// Mirrors claude-auth.js's getConfigDir(), plus the sessions subdir.
function getSessionsDir() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(configDir, 'sessions');
}

// process.kill(pid, 0) throws EPERM for a live process owned by someone else and
// ESRCH only when nothing holds the pid — so EPERM means alive, not dead.
function isPidAliveDefault(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function psDefault(pids) {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'pid=,ppid=,lstart=,comm=', '-p', pids.join(',')], (err, stdout) => {
      // A batch whose pids have all since died exits 1 with no rows — legitimate,
      // not an error, so take whatever stdout came with the rejection.
      resolve(err ? (err.stdout || '') : (stdout || ''));
    });
  });
}

// `ps` pads lstart to a fixed width with spaces (%e), so split on runs of whitespace
// rather than slicing fixed offsets. A row is: pid, ppid, lstart's own 5 tokens
// ("Fri Aug 28 17:59:11 2026"), then comm.
function parsePsRows(stdout) {
  const rows = new Map();
  for (const line of String(stdout).split('\n')) {
    const t = line.trim().split(/\s+/);
    if (t.length < 7) continue;
    const pid = Number(t[0]);
    if (!Number.isInteger(pid)) continue;
    rows.set(pid, {
      ppid: Number(t[1]),
      lstart: t.slice(2, 7).join(' '),
      comm: t.slice(7).join(' '),
    });
  }
  return rows;
}

function readRegistry(dir) {
  let names;
  try {
    // The dir also holds <pid>.<hash>.key files, which are not registry entries.
    names = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return []; // missing, unreadable, not a dir — resume exactly as before
  }
  const entries = [];
  for (const name of names) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (entry && typeof entry === 'object') entries.push(entry);
    } catch {} // one malformed file must not blank every other lock
  }
  return entries;
}

const noopLog = { debug() {}, info() {}, warn() {} };

/**
 * Sessions live in a process that is not one of ours.
 *
 * @returns Map sessionId → { pid, ppid, cwd, status, name, kind }
 */
async function getExternalSessions({
  dir = getSessionsDir(),
  ownSessionIds = new Set(),
  ownPtyPids = new Set(),
  ps = psDefault,
  isPidAlive = isPidAliveDefault,
  platform = process.platform,
  log = noopLog,
} = {}) {
  try {
    const candidates = [];
    for (const entry of readRegistry(dir)) {
      if (typeof entry.sessionId !== 'string' || !entry.sessionId) continue;
      if (!Number.isInteger(entry.pid) || entry.pid < 1 || entry.pid > 99999) continue;
      // A pid from a foreign namespace (a WSL session, say) is not ours to check.
      if (entry.pidDomain && entry.pidDomain !== platform) continue;
      if (ownSessionIds.has(entry.sessionId)) continue;
      if (!isPidAlive(entry.pid)) continue;
      candidates.push(entry);
    }
    if (candidates.length === 0) return new Map();

    // Windows has no `ps`, so liveness is all we get: pid reuse goes unverified and
    // the parent-pid check below cannot run.
    if (platform === 'win32') {
      return new Map(candidates.map(e => [e.sessionId, describe(e, null)]));
    }

    // Only live, in-range pids reach `ps`: one out-of-range pid makes macOS `ps` exit 1
    // with *zero* rows, blanking every lock instead of dropping the one bad entry.
    const rows = parsePsRows(await ps(candidates.map(e => e.pid)));

    const locks = new Map();
    for (const entry of candidates) {
      const row = rows.get(entry.pid);
      if (!row) continue;

      // Anti-PID-reuse: the registry's procStart is UTC while `ps -o lstart=` prints
      // local time, so a string compare silently never matches. Parse both.
      const started = Date.parse(String(entry.procStart) + ' UTC');
      if (!(Math.abs(Date.parse(row.lstart) - started) <= 2000)) continue;

      // The pty pid is the *shell*; `claude` runs as its child. So a session we spawned
      // that was re-keyed mid-run (session-transitions.js) — and is therefore missing
      // from ownSessionIds until the next detect flush — is caught by its parent.
      if (ownPtyPids.has(row.ppid)) continue;

      if (!/claude/.test(row.comm)) {
        log.debug(`[locks] ${entry.sessionId} pid ${entry.pid} comm=${row.comm} (start time matched)`);
      }
      locks.set(entry.sessionId, describe(entry, row));
    }
    return locks;
  } catch (err) {
    log.warn('[locks] lock scan failed, resuming unguarded:', err && err.message);
    return new Map();
  }
}

function describe(entry, row) {
  return {
    pid: entry.pid,
    ppid: row ? row.ppid : null,
    cwd: entry.cwd || null,
    status: entry.status || null,
    name: entry.name || null,
    kind: entry.kind || null,
  };
}

// What a blocked resume is called, wherever it is reported. The renderer keeps its own
// copy in public/utils.js (LOCKED_ELSEWHERE_TITLE) because it cannot require this file;
// change both together.
const LOCKED_TITLE = 'Already open in another shell';

// The one description of a lock holder, e.g. `pid 3057, "switchboard-5b" (busy)`.
// Built in main and shipped over IPC as holder.label so the renderer has no second copy
// of the name/status fallback rules.
function holderLabel(sessionId, holder) {
  const who = holder.name || String(sessionId).split('-')[0];
  return `pid ${holder.pid}, "${who}"` + (holder.status ? ` (${holder.status})` : '');
}

module.exports = { getSessionsDir, getExternalSessions, parsePsRows, holderLabel, LOCKED_TITLE };
