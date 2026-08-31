const fs = require('fs');

// Incremental reader for a session's .jsonl transcript. The read-only transcript
// view tails a file another `claude` process is appending to, so it must never
// re-read the whole thing on every change — it hands back the cursor it was given
// and gets only what has been added since.
//
// A transcript is append-only in practice, so two fingerprints are enough to tell
// "grown" from "replaced": the file's head, and the last bytes we consumed. If
// either moved, the file we read last time is gone and the caller has to start over.
const HEAD_BYTES = 256;
const ANCHOR_BYTES = 64;

function readRange(fd, start, end) {
  const length = Math.max(0, end - start);
  if (!length) return Buffer.alloc(0);
  const buf = Buffer.alloc(length);
  const read = fs.readSync(fd, buf, 0, length, start);
  return read === length ? buf : buf.subarray(0, read);
}

/**
 * Read the entries appended since `cursor`.
 *
 * @param jsonlPath absolute path to the transcript
 * @param cursor `{ size, head, anchor }` from a previous call, or null for a first read
 * @returns `{ reset, entries, cursor }` — `reset` means `entries` is the whole file
 *          again and the caller must discard what it had. Throws if the file cannot
 *          be opened or stat'd.
 */
function readSessionTail(jsonlPath, cursor) {
  const fd = fs.openSync(jsonlPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = readRange(fd, 0, Math.min(HEAD_BYTES, size)).toString('hex');

    let reset = !cursor;
    // Shrunk: truncated or rewritten shorter.
    if (!reset && size < cursor.size) reset = true;
    // Leading content changed. Compared as prefixes because hex is two chars per
    // byte, so a file that was shorter than HEAD_BYTES when we last read it still
    // matches once it has grown past that.
    if (!reset && !head.startsWith(cursor.head) && !cursor.head.startsWith(head)) reset = true;
    // Rewritten in place at the same length, or at least past our cursor.
    if (!reset) {
      const anchor = readRange(fd, Math.max(0, cursor.size - ANCHOR_BYTES), cursor.size).toString('hex');
      if (anchor !== cursor.anchor) reset = true;
    }

    const start = reset ? 0 : cursor.size;
    const chunk = readRange(fd, start, size);
    // Stop at the last newline: the writer may be mid-line, and half a line is not
    // parseable JSON. It comes back whole on the next call.
    const lastNewline = chunk.lastIndexOf(0x0A);
    const consumedEnd = start + lastNewline + 1;

    const entries = [];
    if (lastNewline >= 0) {
      for (const line of chunk.subarray(0, lastNewline).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        try { entries.push(JSON.parse(line)); } catch {}
      }
    }

    const anchor = readRange(fd, Math.max(0, consumedEnd - ANCHOR_BYTES), consumedEnd).toString('hex');
    return { reset, entries, cursor: { size: consumedEnd, head, anchor } };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readSessionTail, HEAD_BYTES, ANCHOR_BYTES };
