const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionTransitions = require('../session-transitions');

// Build an isolated PROJECTS_DIR with one project folder, wire the module's
// injected context at it, and hand back the fakes the assertions need.
function harness(folder = 'proj') {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-transitions-'));
  const folderPath = path.join(projectsDir, folder);
  fs.mkdirSync(folderPath);

  const activeSessions = new Map();
  const forkedEvents = [];
  const rekeyed = [];
  const noop = () => {};

  sessionTransitions.init({
    PROJECTS_DIR: projectsDir,
    activeSessions,
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: { send: (channel, oldId, newId) => forkedEvents.push({ channel, oldId, newId }) },
    }),
    log: { info: noop, debug: noop, warn: noop, error: noop },
    rekeyMcpServer: (oldId, newId) => rekeyed.push({ oldId, newId }),
  });

  return { projectsDir, folder, folderPath, activeSessions, forkedEvents, rekeyed };
}

function addSession(h, sessionId, extra = {}) {
  const session = {
    exited: false,
    isPlainTerminal: false,
    projectFolder: h.folder,
    knownJsonlFiles: new Set(fs.readdirSync(h.folderPath).filter(f => f.endsWith('.jsonl'))),
    ...extra,
  };
  h.activeSessions.set(sessionId, session);
  return session;
}

function writeJsonl(h, id, entries) {
  const file = path.join(h.folderPath, id + '.jsonl');
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return file;
}

// The self-fork path is the one fork branch that survives the removal of
// Switchboard's own fork button: it reads the new JSONL's own forkedFrom field
// and never involves a forkFrom session option.
test('self-fork is detected when the new session file forks the active PTY', () => {
  const h = harness();
  try {
    const oldId = 'aaaaaaaa-0000-0000-0000-000000000001';
    const newId = 'bbbbbbbb-0000-0000-0000-000000000002';

    writeJsonl(h, oldId, [{ type: 'user', sessionId: oldId }]);
    const session = addSession(h, oldId);

    writeJsonl(h, newId, [
      { type: 'user', sessionId: newId, forkedFrom: { sessionId: oldId }, slug: 'forked-work' },
    ]);

    sessionTransitions.detectSessionTransitions(h.folder);

    assert.equal(session.realSessionId, newId, 'session should be re-keyed to the forked id');
    assert.equal(h.activeSessions.has(oldId), false, 'old key should be dropped');
    assert.equal(h.activeSessions.get(newId), session, 'session should be stored under the new id');
    assert.deepEqual(h.rekeyed, [{ oldId, newId }]);
    assert.deepEqual(h.forkedEvents, [{ channel: 'session-forked', oldId, newId }]);
  } finally {
    fs.rmSync(h.projectsDir, { recursive: true, force: true });
  }
});

test('a new file forked from an unrelated session does not match', () => {
  const h = harness();
  try {
    const oldId = 'aaaaaaaa-0000-0000-0000-000000000001';
    const newId = 'bbbbbbbb-0000-0000-0000-000000000002';
    const stranger = 'cccccccc-0000-0000-0000-000000000003';

    writeJsonl(h, oldId, [{ type: 'user', sessionId: oldId }]);
    const session = addSession(h, oldId);

    writeJsonl(h, newId, [
      { type: 'user', sessionId: newId, forkedFrom: { sessionId: stranger }, slug: 'someone-else' },
    ]);

    sessionTransitions.detectSessionTransitions(h.folder);

    assert.equal(session.realSessionId, undefined, 'no transition should be recorded');
    assert.equal(h.activeSessions.get(oldId), session, 'session should keep its original key');
    assert.deepEqual(h.forkedEvents, []);
  } finally {
    fs.rmSync(h.projectsDir, { recursive: true, force: true });
  }
});

test('plan-accept still re-keys on shared slug + planContent + ExitPlanMode', () => {
  const h = harness();
  try {
    const oldId = 'aaaaaaaa-0000-0000-0000-000000000001';
    const newId = 'bbbbbbbb-0000-0000-0000-000000000002';

    writeJsonl(h, oldId, [
      { type: 'user', sessionId: oldId, slug: 'shared-slug' },
      { type: 'assistant', sessionId: oldId, slug: 'shared-slug', tool: 'ExitPlanMode' },
    ]);
    const session = addSession(h, oldId);

    writeJsonl(h, newId, [
      { type: 'user', sessionId: newId, slug: 'shared-slug', planContent: 'the plan' },
    ]);

    sessionTransitions.detectSessionTransitions(h.folder);

    assert.equal(session.realSessionId, newId, 'plan-accept should re-key the session');
    assert.equal(session.sessionSlug, 'shared-slug');
    assert.deepEqual(h.forkedEvents, [{ channel: 'session-forked', oldId, newId }]);
  } finally {
    fs.rmSync(h.projectsDir, { recursive: true, force: true });
  }
});

// Behaviour change from removing the fork spawn path: a new file carrying only
// file-history-snapshot lines used to match immediately for a session awaiting a
// fork. With no forkFrom to await, it is deferred as "empty, retry next cycle" —
// and must stay out of knownJsonlFiles so the next cycle rechecks it.
test('a snapshot-only new file is deferred as empty, not matched', () => {
  const h = harness();
  try {
    const oldId = 'aaaaaaaa-0000-0000-0000-000000000001';
    const newId = 'bbbbbbbb-0000-0000-0000-000000000002';

    writeJsonl(h, oldId, [{ type: 'user', sessionId: oldId }]);
    const session = addSession(h, oldId);

    writeJsonl(h, newId, [{ type: 'file-history-snapshot', snapshot: 'x'.repeat(64) }]);

    sessionTransitions.detectSessionTransitions(h.folder);

    assert.equal(session.realSessionId, undefined, 'snapshot-only file must not match');
    assert.equal(h.activeSessions.get(oldId), session);
    assert.equal(
      session.knownJsonlFiles.has(newId + '.jsonl'),
      false,
      'the deferred file must be rechecked next cycle',
    );
    assert.deepEqual(h.forkedEvents, []);
  } finally {
    fs.rmSync(h.projectsDir, { recursive: true, force: true });
  }
});
