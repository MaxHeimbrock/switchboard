const test = require('node:test');
const assert = require('node:assert/strict');

const { conversationText, countOccurrences } = require('../public/jsonl-viewer');

// `conversationText` is the single definition of what a keyword search counts and what
// the transcript's find bar searches. Its scope is the agreed one: user and assistant
// message text, and nothing else — so a badge can never point at a hit buried in a
// collapsed Thinking block or a tool result the reader would have to expand to find.

function user(content) {
  return { type: 'user', message: { content } };
}

function assistant(content) {
  return { type: 'assistant', message: { content } };
}

test('counts plain user and assistant message text', () => {
  const text = conversationText([
    user('the keyword appears here'),
    assistant([{ type: 'text', text: 'and the keyword again' }]),
  ]);
  assert.equal(countOccurrences(text, 'keyword'), 2);
});

test('a string content block counts the same as a text block', () => {
  assert.equal(conversationText([user('hello')]), conversationText([user([{ type: 'text', text: 'hello' }])]));
});

test('excludes thinking, tool calls and tool results', () => {
  const text = conversationText([
    assistant([
      { type: 'thinking', thinking: 'needle in a thought' },
      { type: 'text', text: 'needle on screen' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo needle' } },
    ]),
    user([{ type: 'tool_result', tool_use_id: 't1', content: 'needle in output' }]),
  ]);
  assert.equal(text, 'needle on screen');
  assert.equal(countOccurrences(text, 'needle'), 1);
});

test('excludes meta entries — turn duration, local command, bash progress', () => {
  const text = conversationText([
    { type: 'system', subtype: 'turn_duration', durationMs: 1200 },
    { type: 'system', subtype: 'local_command', content: '<command-name>needle</command-name>' },
    { type: 'progress', data: { type: 'bash_progress', output: 'needle' } },
    { type: 'custom-title', customTitle: 'needle' },
    user('needle'),
  ]);
  assert.equal(countOccurrences(text, 'needle'), 1);
});

test('excludes a local command group, which renders as a Bash block', () => {
  const text = conversationText([
    user('<local-command-caveat>Caveat</local-command-caveat>'),
    user('<bash-input>grep needle</bash-input>'),
    user('<bash-stdout>needle needle</bash-stdout>'),
    user('needle'),
  ]);
  assert.equal(countOccurrences(text, 'needle'), 1);
});

test('excludes an image block, which renders as an <img>', () => {
  const text = conversationText([
    user([{ type: 'text', text: '[Image: source: /tmp/needle.png]' }]),
    user('needle'),
  ]);
  assert.equal(countOccurrences(text, 'needle'), 1);
});

test('skips whitespace-only text blocks, as the renderer does', () => {
  assert.equal(conversationText([user([{ type: 'text', text: '   \n ' }, { type: 'text', text: 'kept' }])]), 'kept');
});

test('counting is case-insensitive and non-overlapping', () => {
  assert.equal(countOccurrences('Keyword keyword KEYWORD', 'keyword'), 3);
  // 'aaaa' holds two non-overlapping 'aa', not three — the rule the find bars walk.
  assert.equal(countOccurrences('aaaa', 'aa'), 2);
});

test('an empty query or empty text counts nothing', () => {
  assert.equal(countOccurrences('anything', ''), 0);
  assert.equal(countOccurrences('', 'anything'), 0);
  assert.equal(conversationText([]), '');
});
