const test = require('node:test');
const assert = require('node:assert/strict');

const { findOwningApp, revealHolder, editorCli } = require('../reveal-holder');

const VSCODE = '/Applications/Visual Studio Code.app';

// The chain verified on a live `claude` in a VS Code integrated terminal, from the card:
//
//    3057  2939  claude
//    2939 57147  /bin/zsh
//   57147 57095  …/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/…
//   57095     1  /Applications/Visual Studio Code.app/Contents/MacOS/Code
//
// Note hop 57147: two `.app/` segments in one comm, which is why the bundle root has to be
// the first match and not the last.
const VSCODE_CHAIN = {
  2939: { ppid: 57147, comm: '/bin/zsh' },
  57147: { ppid: 57095, comm: VSCODE + '/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper' },
  57095: { ppid: 1, comm: VSCODE + '/Contents/MacOS/Code' },
};

// Fakes for the three things the module reaches outside itself. `ps` renders rows in the
// same shape `ps -o pid=,ppid=,lstart=,comm=` prints, so parsePsRows does the real parsing.
function harness({ rows = {}, fail = new Set(), files = new Set() } = {}) {
  const psCalls = [];
  const runCalls = [];
  return {
    psCalls,
    runCalls,
    deps: {
      platform: 'darwin',
      ps: async (pid) => {
        psCalls.push(pid);
        const row = rows[pid];
        if (!row) return '';
        return `${pid} ${row.ppid} Fri Aug 28 17:59:11 2026 ${row.comm}\n`;
      },
      run: async (cmd, args) => {
        runCalls.push([cmd, ...args]);
        return fail.has(cmd) ? 1 : 0;
      },
      exists: (p) => files.has(p),
    },
  };
}

test('findOwningApp takes the outer bundle when one comm holds two .app segments', async () => {
  const h = harness({ rows: VSCODE_CHAIN });
  assert.equal(await findOwningApp({ ppid: 2939, ps: h.deps.ps }), VSCODE);
  // Stopped at the first bundle rather than walking to the top of the tree.
  assert.deepEqual(h.psCalls, [2939, 57147]);
});

test('findOwningApp returns null when nothing above the holder is an app', async () => {
  const h = harness({
    rows: {
      2939: { ppid: 900, comm: '/bin/zsh' },
      900: { ppid: 1, comm: '/usr/bin/cron' },
    },
  });
  assert.equal(await findOwningApp({ ppid: 2939, ps: h.deps.ps }), null);
});

test('findOwningApp stops when a pid exits mid-walk', async () => {
  const h = harness({ rows: { 2939: { ppid: 57147, comm: '/bin/zsh' } } }); // 57147 missing
  assert.equal(await findOwningApp({ ppid: 2939, ps: h.deps.ps }), null);
});

test('findOwningApp gives up rather than looping on a pathological chain', async () => {
  // A cycle: without maxHops this never returns.
  const h = harness({ rows: { 10: { ppid: 11, comm: 'a' }, 11: { ppid: 10, comm: 'b' } } });
  assert.equal(await findOwningApp({ ppid: 10, ps: h.deps.ps, maxHops: 4 }), null);
  assert.equal(h.psCalls.length, 4);
});

test('revealHolder raises the app and points VS Code at the holders cwd', async () => {
  const h = harness({ rows: VSCODE_CHAIN, files: new Set([editorCli(VSCODE)]) });
  const out = await revealHolder({ pid: 3057, ppid: 2939, cwd: '/tmp/proj' }, h.deps);

  assert.deepEqual(out, { ok: true, bundlePath: VSCODE, focusedFolder: true });
  assert.deepEqual(h.runCalls, [
    ['open', '-a', VSCODE],
    [editorCli(VSCODE), '-r', '/tmp/proj'],
  ]);
});

test('revealHolder raises a non-editor app and attempts no folder hop', async () => {
  const h = harness({
    rows: {
      2939: { ppid: 500, comm: '/bin/zsh' },
      500: { ppid: 1, comm: '/Applications/Ghostty.app/Contents/MacOS/ghostty' },
    },
  });
  const out = await revealHolder({ pid: 3057, ppid: 2939, cwd: '/tmp/proj' }, h.deps);

  assert.deepEqual(out, { ok: true, bundlePath: '/Applications/Ghostty.app', focusedFolder: false });
  assert.deepEqual(h.runCalls, [['open', '-a', '/Applications/Ghostty.app']]);
});

test('revealHolder skips the folder hop when the holder has no cwd', async () => {
  const h = harness({ rows: VSCODE_CHAIN, files: new Set([editorCli(VSCODE)]) });
  const out = await revealHolder({ pid: 3057, ppid: 2939, cwd: null }, h.deps);

  assert.equal(out.focusedFolder, false);
  assert.deepEqual(h.runCalls, [['open', '-a', VSCODE]]);
});

test('revealHolder still reports ok when the folder hop fails', async () => {
  const cli = editorCli(VSCODE);
  const h = harness({ rows: VSCODE_CHAIN, files: new Set([cli]), fail: new Set([cli]) });
  const out = await revealHolder({ pid: 3057, ppid: 2939, cwd: '/tmp/proj' }, h.deps);

  // The window is forward, which is the point — only the folder was missed.
  assert.equal(out.ok, true);
  assert.equal(out.focusedFolder, false);
});

test('revealHolder reports no-app for a headless holder', async () => {
  const h = harness({
    rows: {
      2939: { ppid: 900, comm: '/bin/zsh' },
      900: { ppid: 1, comm: '/usr/sbin/cron' },
    },
  });
  const out = await revealHolder({ pid: 3057, ppid: 2939 }, h.deps);

  assert.deepEqual(out, { ok: false, reason: 'no-app' });
  assert.deepEqual(h.runCalls, []); // nothing raised
});

test('revealHolder reports no-app when ps never gave us a ppid', async () => {
  // Windows holders, and any row `ps` could not match, arrive with ppid null.
  const h = harness({ rows: VSCODE_CHAIN });
  assert.deepEqual(await revealHolder({ pid: 3057, ppid: null }, h.deps), { ok: false, reason: 'no-app' });
  assert.deepEqual(h.psCalls, []);
});

test('revealHolder reports unreachable when the raise fails', async () => {
  const h = harness({ rows: VSCODE_CHAIN, fail: new Set(['open']) });
  const out = await revealHolder({ pid: 3057, ppid: 2939, cwd: '/tmp/proj' }, h.deps);

  assert.deepEqual(out, { ok: false, reason: 'unreachable' });
  // Gave up at the raise — no folder hop attempted on an app that never came forward.
  assert.deepEqual(h.runCalls, [['open', '-a', VSCODE]]);
});

test('revealHolder reports unsupported off darwin without touching the process tree', async () => {
  for (const platform of ['win32', 'linux']) {
    const h = harness({ rows: VSCODE_CHAIN, files: new Set([editorCli(VSCODE)]) });
    const out = await revealHolder({ pid: 3057, ppid: 2939, cwd: '/tmp/proj' }, { ...h.deps, platform });

    assert.deepEqual(out, { ok: false, reason: 'unsupported' }, platform);
    assert.deepEqual(h.psCalls, [], platform);
    assert.deepEqual(h.runCalls, [], platform);
  }
});
