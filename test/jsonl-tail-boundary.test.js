const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mergeLocalCommandEntries,
  computeSafeFrom,
  UNSETTLED_TOOL_WINDOW,
} = require('../public/jsonl-viewer');

// The two pure passes behind the live-tailing transcript view. `mergeLocalCommandEntries`
// reports the raw-index range behind each rendered element; `computeSafeFrom` reports the
// lowest index whose rendering can still change, which is where an append re-renders from.

function text(body) {
  return { type: 'user', message: { content: body } };
}

function toolUse(id, name = 'Bash') {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] } };
}

function toolResult(id) {
  return { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } };
}

// The three-entry shape a local command writes: caveat, then the command, then output.
function localCmdGroup(cmd, output) {
  return [
    text('<local-command-caveat>Caveat text</local-command-caveat>'),
    text(`<bash-input>${cmd}</bash-input>`),
    text(`<bash-stdout>${output}</bash-stdout>`),
  ];
}

// The tool_result ids present in a raw list — what computeSafeFrom is given.
function resultIdsOf(raw) {
  const ids = new Set();
  for (const entry of raw) {
    const blocks = entry.message?.content || entry.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block.type === 'tool_result' && block.tool_use_id) ids.add(block.tool_use_id);
    }
  }
  return ids;
}

function safeFrom(raw) {
  const merged = mergeLocalCommandEntries(raw);
  return computeSafeFrom(merged, resultIdsOf(raw), raw.length);
}

test('a plain entry spans exactly its own raw index', () => {
  const raw = [text('one'), text('two'), text('three')];

  const merged = mergeLocalCommandEntries(raw);

  assert.deepEqual(merged.map(el => [el.from, el.to]), [[0, 1], [1, 2], [2, 3]]);
});

test('a closed local-command group spans its raw entries as one element', () => {
  const raw = [text('before'), ...localCmdGroup('ls', 'a\nb'), text('after')];

  const merged = mergeLocalCommandEntries(raw);

  assert.equal(merged.length, 3);
  assert.deepEqual([merged[1].from, merged[1].to], [1, 4], 'the synthetic spans the group');
  assert.equal(merged[1].entry._localCmd.cmd, 'ls');
  assert.deepEqual([merged[2].from, merged[2].to], [4, 5], 'the next entry keeps its own index');
});

test('a closed group does not lower the boundary', () => {
  const raw = [text('before'), ...localCmdGroup('ls', 'a'), text('after')];

  assert.equal(safeFrom(raw), raw.length, 'nothing is unsettled');
});

test('a closed group at the very tail does not lower the boundary', () => {
  // The merge seals a group on its closing </bash-stdout>, so nothing appended after
  // it can join it — even with no entry following to prove the group ended.
  const raw = [text('before'), ...localCmdGroup('ls', 'a')];

  assert.equal(safeFrom(raw), raw.length);
});

test('a caveat with no command yet lowers the boundary to itself', () => {
  // The caveat alone does not parse into a command block, so these entries render as
  // raw XML until the <bash-input> that turns them into one arrives.
  const raw = [text('before'), text('<local-command-caveat>Caveat</local-command-caveat>')];

  assert.equal(safeFrom(raw), 1);
});

test('a group whose closing tag has not arrived lowers the boundary to its first entry', () => {
  const raw = [
    text('before'),
    text('<local-command-caveat>Caveat text</local-command-caveat>'),
    text('<bash-input>npm test</bash-input>'),
    // No </bash-stdout> yet: the group is still being written and renders as raw XML.
  ];

  assert.equal(safeFrom(raw), 1);
});

test('a group closed except for its stdout terminator lowers the boundary', () => {
  const raw = [
    text('before'),
    text('<local-command-caveat>Caveat</local-command-caveat>'),
    text('<bash-input>npm test</bash-input>'),
    text('<bash-stdout>partial output with no terminator'),
  ];

  assert.equal(safeFrom(raw), 1);
});

test('an unresolved tool_use lowers the boundary to its own entry', () => {
  const raw = [text('one'), toolUse('tool-1'), text('two')];

  assert.equal(safeFrom(raw), 1);
});

test('a resolved tool_use does not lower the boundary', () => {
  const raw = [text('one'), toolUse('tool-1'), toolResult('tool-1')];

  assert.equal(safeFrom(raw), raw.length);
});

test('an unresolved tool_use beyond the window is treated as abandoned', () => {
  const filler = [];
  for (let i = 0; i < UNSETTLED_TOOL_WINDOW + 10; i++) filler.push(text('filler ' + i));
  const raw = [toolUse('tool-1'), ...filler];

  assert.equal(safeFrom(raw), raw.length, 'a call that far back never settles the view');
});

test('an unresolved tool_use at the edge of the window still lowers the boundary', () => {
  const filler = [];
  for (let i = 0; i < UNSETTLED_TOOL_WINDOW - 1; i++) filler.push(text('filler ' + i));
  const raw = [toolUse('tool-1'), ...filler];

  assert.equal(safeFrom(raw), 0);
});

test('the boundary is the lowest of several unsettled things', () => {
  const raw = [
    text('one'),
    toolUse('tool-1'),
    text('two'),
    text('<bash-input>npm test</bash-input>'),
  ];

  // The unfinished group is at 3, the unresolved call at 1 — the earlier one wins.
  assert.equal(safeFrom(raw), 1);
});

test('an empty transcript has nothing unsettled', () => {
  assert.equal(safeFrom([]), 0);
  assert.deepEqual(mergeLocalCommandEntries([]), []);
});

test('an unparseable local-command run keeps its entries at their own indices', () => {
  // A caveat with no <bash-input> to parse: the entries are kept as they are. The run
  // is bounded by the entry that follows it, so nothing is left open.
  const raw = [
    text('<local-command-caveat>Caveat with no command</local-command-caveat>'),
    text('plain follow-up'),
  ];

  const merged = mergeLocalCommandEntries(raw);

  assert.deepEqual(merged.map(el => [el.from, el.to]), [[0, 1], [1, 2]]);
  assert.equal(safeFrom(raw), raw.length);
});
