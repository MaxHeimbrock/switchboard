const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readSessionTail, HEAD_BYTES } = require('../read-session-tail');

// One temp transcript per test, plus the write helpers the assertions read like
// prose. `line()` is the shape the real .jsonl carries: one JSON object, one \n.
function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-tail-'));
  const file = path.join(dir, 'session.jsonl');
  return {
    file,
    write: (text) => fs.writeFileSync(file, text, 'utf8'),
    append: (text) => fs.appendFileSync(file, text, 'utf8'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function line(obj) {
  return JSON.stringify(obj) + '\n';
}

test('a first read returns every entry with reset set', () => {
  const h = harness();
  try {
    h.write(line({ type: 'user', n: 1 }) + line({ type: 'assistant', n: 2 }));

    const result = readSessionTail(h.file, null);

    assert.equal(result.reset, true);
    assert.deepEqual(result.entries.map(e => e.n), [1, 2]);
    assert.equal(result.cursor.size, fs.statSync(h.file).size);
  } finally { h.cleanup(); }
});

test('an append yields only the new entries', () => {
  const h = harness();
  try {
    h.write(line({ n: 1 }) + line({ n: 2 }));
    const first = readSessionTail(h.file, null);

    h.append(line({ n: 3 }));
    const second = readSessionTail(h.file, first.cursor);

    assert.equal(second.reset, false);
    assert.deepEqual(second.entries.map(e => e.n), [3]);
  } finally { h.cleanup(); }
});

test('no change yields no entries and leaves the cursor where it was', () => {
  const h = harness();
  try {
    h.write(line({ n: 1 }));
    const first = readSessionTail(h.file, null);

    const second = readSessionTail(h.file, first.cursor);

    assert.equal(second.reset, false);
    assert.deepEqual(second.entries, []);
    assert.equal(second.cursor.size, first.cursor.size);
  } finally { h.cleanup(); }
});

test('a partial line is withheld, then returned whole once its newline lands', () => {
  const h = harness();
  try {
    h.write(line({ n: 1 }));
    const first = readSessionTail(h.file, null);

    // The other process is mid-write: the object is there, the newline is not.
    h.append('{"n":2}');
    const second = readSessionTail(h.file, first.cursor);
    assert.equal(second.reset, false);
    assert.deepEqual(second.entries, [], 'a line without its newline must wait');
    assert.equal(second.cursor.size, first.cursor.size, 'nothing was consumed');

    h.append('\n');
    const third = readSessionTail(h.file, second.cursor);
    assert.equal(third.reset, false);
    assert.deepEqual(third.entries.map(e => e.n), [2]);
  } finally { h.cleanup(); }
});

test('truncation gives reset with everything the file now holds', () => {
  const h = harness();
  try {
    h.write(line({ n: 1 }) + line({ n: 2 }) + line({ n: 3 }));
    const first = readSessionTail(h.file, null);

    h.write(line({ n: 9 }));
    const second = readSessionTail(h.file, first.cursor);

    assert.equal(second.reset, true);
    assert.deepEqual(second.entries.map(e => e.n), [9]);
  } finally { h.cleanup(); }
});

test('a rewritten first line gives reset even when the file has grown', () => {
  const h = harness();
  try {
    // Pad past HEAD_BYTES so the head fingerprint is fully populated on both reads.
    const pad = 'x'.repeat(HEAD_BYTES);
    h.write(line({ n: 1, pad }));
    const first = readSessionTail(h.file, null);

    // Compaction: the leading content is replaced, and the file ends up longer.
    h.write(line({ n: 7, pad }) + line({ n: 8, pad }));
    const second = readSessionTail(h.file, first.cursor);

    assert.equal(second.reset, true);
    assert.deepEqual(second.entries.map(e => e.n), [7, 8]);
  } finally { h.cleanup(); }
});

test('an in-place rewrite past the cursor is caught by the anchor fingerprint', () => {
  const h = harness();
  try {
    h.write(line({ tag: 'aaaa' }) + line({ tag: 'bbbb' }));
    const first = readSessionTail(h.file, null);

    // Same length, same head — only the bytes at the cursor moved.
    h.write(line({ tag: 'aaaa' }) + line({ tag: 'cccc' }));
    const second = readSessionTail(h.file, first.cursor);

    assert.equal(second.reset, true);
    assert.deepEqual(second.entries.map(e => e.tag), ['aaaa', 'cccc']);
  } finally { h.cleanup(); }
});

test('a file growing past HEAD_BYTES does not reset spuriously', () => {
  const h = harness();
  try {
    // Shorter than HEAD_BYTES, so the first head fingerprint is the whole file.
    h.write(line({ n: 1 }));
    const first = readSessionTail(h.file, null);
    assert.ok(fs.statSync(h.file).size < HEAD_BYTES);

    h.append(line({ n: 2, pad: 'y'.repeat(HEAD_BYTES) }));
    const second = readSessionTail(h.file, first.cursor);

    assert.equal(second.reset, false, 'the head is a prefix, not a change');
    assert.deepEqual(second.entries.map(e => e.n), [2]);
  } finally { h.cleanup(); }
});

test('an unparseable line is skipped, not fatal', () => {
  const h = harness();
  try {
    h.write(line({ n: 1 }) + 'not json at all\n' + line({ n: 2 }));

    const result = readSessionTail(h.file, null);

    assert.deepEqual(result.entries.map(e => e.n), [1, 2]);
  } finally { h.cleanup(); }
});

test('an empty file reads clean and does not reset on the next pass', () => {
  const h = harness();
  try {
    h.write('');
    const first = readSessionTail(h.file, null);
    assert.deepEqual(first.entries, []);
    assert.equal(first.cursor.size, 0);

    const second = readSessionTail(h.file, first.cursor);
    assert.equal(second.reset, false);
    assert.deepEqual(second.entries, []);
  } finally { h.cleanup(); }
});

test('a multi-byte character split across two appends survives', () => {
  const h = harness();
  try {
    h.write(line({ text: 'héllo — ünïcode' }));
    const first = readSessionTail(h.file, null);
    assert.equal(first.entries[0].text, 'héllo — ünïcode');

    const second = line({ text: '日本語のテキスト' });
    const bytes = Buffer.from(second, 'utf8');
    // Cut mid-character: the first chunk ends inside a 3-byte sequence.
    fs.appendFileSync(h.file, bytes.subarray(0, 20));
    const mid = readSessionTail(h.file, first.cursor);
    assert.deepEqual(mid.entries, []);

    fs.appendFileSync(h.file, bytes.subarray(20));
    const done = readSessionTail(h.file, mid.cursor);
    assert.equal(done.entries[0].text, '日本語のテキスト');
  } finally { h.cleanup(); }
});

test('a missing file throws, for the IPC handler to turn into an error shape', () => {
  const h = harness();
  try {
    assert.throws(() => readSessionTail(path.join(path.dirname(h.file), 'nope.jsonl'), null));
  } finally { h.cleanup(); }
});
