// reveal-holder.js — where is the `claude` process holding this session, and can we go there?
//
// A resume refused because the session is live elsewhere (claude-sessions.js) leaves the
// user to find that window themselves. Walking the holder's ppid chain upward until an
// `.app/` bundle appears identifies the owning application, which `open -a` can raise.
//
// Two tiers, and the second only ever adds to the first:
//   1. Raise the owning app. Works for any windowed holder and needs no permissions.
//   2. For a VS Code-family holder, also point it at the holder's cwd, so the right
//      *window* comes forward rather than whichever one was last active.
// Tier 2 failing is not a failure — the app is already forward, which is most of the value.
//
// macOS only. `open` and app bundles have no equivalent elsewhere, so every other platform
// reports `unsupported` before a single subprocess runs, and the caller keeps its old
// behaviour. Everything else fails soft into a reason string: this is navigation, and never
// being able to reach the window is a worse outcome than not offering to.

const fsDefault = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { parsePsRows } = require('./claude-sessions');

// Same `ps` invocation as claude-sessions.js's, so parsePsRows can read the rows: pid,
// ppid, lstart's five tokens, then comm. lstart is unused here but its width is what makes
// the column split reliable.
function psDefault(pid) {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'pid=,ppid=,lstart=,comm=', '-p', String(pid)], (err, stdout) => {
      // A pid that died between hops exits 1 with no rows — an ordinary end to the walk.
      resolve(err ? (err.stdout || '') : (stdout || ''));
    });
  });
}

// Resolves to the exit code rather than rejecting, so every caller below branches on a
// number instead of wrapping each call in its own try.
function runDefault(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, (err) => resolve(err ? (typeof err.code === 'number' ? err.code : 1) : 0));
  });
}

function existsDefault(p) {
  try {
    return fsDefault.statSync(p).isFile();
  } catch {
    return false;
  }
}

const noopLog = { debug() {}, info() {}, warn() {} };

// The bundle root is the FIRST `.app` on the path, not the last. A helper process inside
// VS Code reports
//   /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/…
// and it is the outer bundle that `open -a` can raise; the inner one is not an app at all.
const BUNDLE_RE = /^(.*?\.app)\//;

/**
 * Walk up the process tree until an app bundle owns one of the ancestors.
 *
 * The holder itself is a `claude` binary and its parent a shell, so the bundle is
 * typically two or three hops up. `maxHops` only guards against a pathological chain;
 * reaching pid 1 ends the walk normally.
 *
 * @returns the bundle's absolute path, or null when nothing above the holder is an app
 */
async function findOwningApp({ ppid, ps = psDefault, maxHops = 12 } = {}) {
  let pid = ppid;
  for (let hop = 0; hop < maxHops; hop++) {
    if (!Number.isInteger(pid) || pid <= 1) return null;
    const row = parsePsRows(await ps(pid)).get(pid);
    if (!row) return null; // exited mid-walk, or a pid we cannot see
    const match = BUNDLE_RE.exec(row.comm);
    if (match) return match[1];
    pid = row.ppid;
  }
  return null;
}

// VS Code, Insiders and VSCodium all ship this CLI, and `-r` (--reuse-window) is what opens
// a folder in the window already showing it. Detecting the family by the CLI's presence
// rather than by bundle id means no allowlist to keep in step with the ecosystem — at the
// cost of missing forks that rename the binary (Cursor, Windsurf), which then get tier 1.
function editorCli(bundlePath) {
  return path.join(bundlePath, 'Contents', 'Resources', 'app', 'bin', 'code');
}

/**
 * Bring the window holding this session to the front.
 *
 * @param holder  a lock holder from getExternalSessions — needs `ppid`, optionally `cwd`
 * @returns { ok: true, bundlePath, focusedFolder } on success, otherwise
 *          { ok: false, reason: 'unsupported' | 'no-app' | 'unreachable' }
 */
async function revealHolder(holder, {
  platform = process.platform,
  ps = psDefault,
  run = runDefault,
  exists = existsDefault,
  log = noopLog,
} = {}) {
  // Before any subprocess: there is nothing to raise and nothing to run.
  if (platform !== 'darwin') return { ok: false, reason: 'unsupported' };
  if (!holder || !Number.isInteger(holder.ppid)) return { ok: false, reason: 'no-app' };

  const bundlePath = await findOwningApp({ ppid: holder.ppid, ps });
  if (!bundlePath) {
    // A headless `claude -p` from a script, cron, or another Switchboard: no window exists.
    log.debug(`[reveal] pid ${holder.pid} has no app ancestor`);
    return { ok: false, reason: 'no-app' };
  }

  if (await run('open', ['-a', bundlePath]) !== 0) {
    // Raced with the holder quitting, or the bundle went away since the walk.
    log.warn(`[reveal] could not raise ${bundlePath} for pid ${holder.pid}`);
    return { ok: false, reason: 'unreachable' };
  }

  // Tier 2. The app is already forward, so `ok` is earned whatever happens next.
  let focusedFolder = false;
  const cli = editorCli(bundlePath);
  if (holder.cwd && exists(cli)) {
    focusedFolder = await run(cli, ['-r', holder.cwd]) === 0;
    if (!focusedFolder) log.warn(`[reveal] ${cli} -r failed; ${bundlePath} raised without the folder`);
  }

  log.info(`[reveal] raised ${bundlePath} for pid ${holder.pid}${focusedFolder ? ' on ' + holder.cwd : ''}`);
  return { ok: true, bundlePath, focusedFolder };
}

module.exports = { findOwningApp, revealHolder, editorCli };
