const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The fake `ps` rows below are written in a fixed +2h zone, so run the whole suite as
// if the machine were there — otherwise the UTC-vs-local reconciliation only holds
// where the author happened to be sitting.
process.env.TZ = 'Europe/Berlin';

const { getExternalSessions, getSessionsDir, holderLabel, parsePsRows, LOCKED_TITLE } = require('../claude-sessions');

// Build an isolated registry dir and hand back a writer for <pid>.json files plus
// fakes for the two things the module reaches outside itself: liveness and `ps`.
function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-locks-'));
  const alive = new Set();
  const psRows = new Map(); // pid → { ppid, lstart, comm }
  const psCalls = [];

  return {
    dir,
    alive,
    psRows,
    psCalls,
    // A registry entry as Claude Code v2.1.250 writes it, with the fields the guard
    // reads. procStart is UTC; the matching ps row is local time.
    write(pid, entry) {
      fs.writeFileSync(path.join(dir, pid + '.json'), JSON.stringify({
        pid,
        sessionId: 'session-' + pid,
        cwd: '/tmp/proj',
        procStart: 'Fri Aug 28 15:59:11 2026',
        version: '2.1.250',
        kind: 'interactive',
        pidDomain: process.platform,
        name: 'holder ' + pid,
        status: 'idle',
        ...entry,
      }), 'utf8');
    },
    writeRaw(name, text) {
      fs.writeFileSync(path.join(dir, name), text, 'utf8');
    },
    // Register the process `ps` will report for a pid. lstart defaults to the same
    // instant as the entry's procStart above, expressed in a zone 2h ahead of UTC —
    // the CEST offset that makes a naive string compare always fail.
    proc(pid, { ppid = 999, lstart = 'Fri Aug 28 17:59:11 2026', comm = 'claude' } = {}) {
      this.alive.add(pid);
      this.psRows.set(pid, { ppid, lstart, comm });
    },
    opts(extra = {}) {
      return {
        dir: this.dir,
        isPidAlive: (pid) => this.alive.has(pid),
        ps: (pids) => {
          this.psCalls.push([...pids]);
          const out = pids
            .filter(p => this.psRows.has(p))
            .map(p => {
              const r = this.psRows.get(p);
              return `${p} ${r.ppid} ${r.lstart}     ${r.comm}`;
            })
            .join('\n');
          return Promise.resolve(out);
        },
        ...extra,
      };
    },
    cleanup() {
      fs.rmSync(this.dir, { recursive: true, force: true });
    },
  };
}

test('a live external session locks, carrying the holder details', async () => {
  const h = harness();
  try {
    h.write(4242, {});
    h.proc(4242);

    const locks = await getExternalSessions(h.opts());

    assert.deepEqual([...locks.keys()], ['session-4242']);
    const holder = locks.get('session-4242');
    assert.equal(holder.pid, 4242);
    assert.equal(holder.name, 'holder 4242');
    assert.equal(holder.status, 'idle');
    assert.equal(holder.kind, 'interactive');
  } finally {
    h.cleanup();
  }
});

// Criterion 8 — a headless `claude -p --resume <id>` holds the transcript exactly as
// firmly as an interactive one, so kind is never consulted.
test('a headless session locks just like an interactive one', async () => {
  const h = harness();
  try {
    h.write(4243, { kind: 'print', status: 'busy' });
    h.proc(4243);

    const locks = await getExternalSessions(h.opts());

    assert.equal(locks.size, 1);
    assert.equal(locks.get('session-4243').kind, 'print');
  } finally {
    h.cleanup();
  }
});

// Criterion 4 — a session Switchboard itself is running must never look locked.
test('our own sessions are excluded, by session id and by parent pid', async () => {
  const h = harness();
  try {
    h.write(4244, {});
    h.proc(4244, { ppid: 5000 });
    h.write(4245, {});
    h.proc(4245, { ppid: 5001 });

    const byId = await getExternalSessions(h.opts({ ownSessionIds: new Set(['session-4244']) }));
    assert.deepEqual([...byId.keys()], ['session-4245']);

    // The pty pid is the shell; `claude` is its child. A session we spawned that was
    // re-keyed mid-run is absent from ownSessionIds and only its parent gives it away.
    const byPpid = await getExternalSessions(h.opts({ ownPtyPids: new Set([5001]) }));
    assert.deepEqual([...byPpid.keys()], ['session-4244']);
  } finally {
    h.cleanup();
  }
});

// Criterion 6 — fail open. Nothing readable means nothing locked.
test('a missing or unreadable sessions dir locks nothing', async () => {
  const locks = await getExternalSessions({
    dir: path.join(os.tmpdir(), 'switchboard-locks-does-not-exist'),
    isPidAlive: () => true,
    ps: () => Promise.resolve(''),
  });
  assert.equal(locks.size, 0);
});

// Criterion 6, second half — one bad file must not cost the good ones.
test('a malformed file is skipped, not fatal, and non-json files are ignored', async () => {
  const h = harness();
  try {
    h.writeRaw('4246.json', '{ this is not json');
    h.writeRaw('4247.e168033.key', 'sk-not-a-session');
    h.write(4248, {});
    h.proc(4248);

    const locks = await getExternalSessions(h.opts());

    assert.deepEqual([...locks.keys()], ['session-4248']);
  } finally {
    h.cleanup();
  }
});

// Criterion 7, first half — a stale file left behind by a SIGKILLed process.
test('a stale file for a dead pid does not lock', async () => {
  const h = harness();
  try {
    h.write(4249, {}); // written, but never registered as alive
    const locks = await getExternalSessions(h.opts());
    assert.equal(locks.size, 0);
    assert.deepEqual(h.psCalls, [], 'ps should not be called with no live candidates');
  } finally {
    h.cleanup();
  }
});

// Criterion 7, second half — the pid is alive but now belongs to something else.
test('a pid whose start time disagrees with procStart does not lock', async () => {
  const h = harness();
  try {
    h.write(4250, {});
    h.proc(4250, { lstart: 'Fri Aug 28 17:59:41 2026' }); // 30s off — a different process
    const locks = await getExternalSessions(h.opts());
    assert.equal(locks.size, 0);
  } finally {
    h.cleanup();
  }
});

// Gotcha 4 — procStart is UTC, `ps -o lstart=` is local. The 2h CEST offset in the
// fixtures above is the real measured one; a naive string compare is always false, so
// this asserts the parse actually reconciles them rather than the guard never firing.
test('a UTC procStart reconciles with a local-time ps row', async () => {
  const h = harness();
  try {
    h.write(4251, { procStart: 'Fri Aug 28 15:59:11 2026' });
    h.proc(4251, { lstart: 'Fri Aug 28 17:59:11 2026' });

    assert.notEqual('Fri Aug 28 15:59:11 2026', 'Fri Aug 28 17:59:11 2026');
    const locks = await getExternalSessions(h.opts());
    assert.equal(locks.size, 1, 'the two spellings of one instant must match');
  } finally {
    h.cleanup();
  }
});

// A pid from another namespace (a WSL session on Windows, say) cannot be checked with
// our own process.kill / ps, so it is not ours to judge.
test('an entry from a foreign pid domain is dropped', async () => {
  const h = harness();
  try {
    h.write(4252, { pidDomain: 'not-' + process.platform });
    h.proc(4252);
    const locks = await getExternalSessions(h.opts());
    assert.equal(locks.size, 0);
  } finally {
    h.cleanup();
  }
});

// An out-of-range pid makes macOS `ps` exit 1 with *zero* rows, which would blank every
// lock rather than dropping the one bad entry — so it must never reach the argv.
test('an out-of-range pid is dropped before ps is called', async () => {
  const h = harness();
  try {
    h.write(4253, {});
    h.proc(4253);
    h.writeRaw('999999.json', JSON.stringify({
      pid: 999999, sessionId: 'session-999999', procStart: 'Fri Aug 28 15:59:11 2026',
    }));
    h.alive.add(999999);

    const locks = await getExternalSessions(h.opts());

    assert.deepEqual([...locks.keys()], ['session-4253']);
    assert.deepEqual(h.psCalls, [[4253]], 'only the in-range pid should reach ps');
  } finally {
    h.cleanup();
  }
});

// Criterion 5 — CLAUDE_CONFIG_DIR moves the whole config tree, sessions dir included.
test('getSessionsDir honours CLAUDE_CONFIG_DIR', () => {
  const before = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = '/tmp/alt-claude';
    assert.equal(getSessionsDir(), path.join('/tmp/alt-claude', 'sessions'));
    delete process.env.CLAUDE_CONFIG_DIR;
    assert.equal(getSessionsDir(), path.join(os.homedir(), '.claude', 'sessions'));
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
  }
});

// `ps` pads lstart to a fixed width, so the row is split on whitespace runs.
test('parsePsRows splits a padded ps row', () => {
  const rows = parsePsRows(' 3057  2939 Fri Aug 28 17:59:11 2026     claude\n');
  assert.deepEqual(rows.get(3057), {
    ppid: 2939,
    lstart: 'Fri Aug 28 17:59:11 2026',
    comm: 'claude',
  });
});

// Plan decision: Windows has no `ps`, so liveness alone decides there and pid reuse
// goes unverified. Asserted so the platform branch is not silently lost.
test('on win32 liveness alone locks, without calling ps', async () => {
  const h = harness();
  try {
    h.write(4254, { pidDomain: 'win32' });
    h.alive.add(4254); // alive, but no ps row exists for it

    const locks = await getExternalSessions(h.opts({ platform: 'win32' }));

    assert.deepEqual([...locks.keys()], ['session-4254']);
    assert.equal(locks.get('session-4254').ppid, null, 'no parent pid is available there');
    assert.deepEqual(h.psCalls, []);
  } finally {
    h.cleanup();
  }
});

// The renderer cannot require claude-sessions.js, so public/utils.js carries its own
// copy of the title. Pin them together — a silent drift would put two different
// sentences in the dialog and the terminal pane.
test('the renderer copy of the locked title matches the main-process one', () => {
  const utils = fs.readFileSync(path.join(__dirname, '..', 'public', 'utils.js'), 'utf8');
  const match = utils.match(/const LOCKED_ELSEWHERE_TITLE = '([^']+)'/);
  assert.ok(match, 'public/utils.js should declare LOCKED_ELSEWHERE_TITLE');
  assert.equal(match[1], LOCKED_TITLE);
});

test('holderLabel names the holder, falling back to the short session id', () => {
  assert.equal(
    holderLabel('f9f6c8c1-1111-2222-3333-444444444444', { pid: 72397, name: 'Merge to main skill', status: 'idle' }),
    'pid 72397, "Merge to main skill" (idle)',
  );
  assert.equal(
    holderLabel('f9f6c8c1-1111-2222-3333-444444444444', { pid: 72397, name: null, status: 'busy' }),
    'pid 72397, "f9f6c8c1" (busy)',
  );
});
