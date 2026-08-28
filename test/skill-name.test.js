const test = require('node:test');
const assert = require('node:assert/strict');

const { skillDisplayName } = require('../skill-name');

test('reads the name out of the frontmatter', () => {
  const content = '---\nname: spec-card\ndescription: Turn a rough card into a spec.\n---\n\n# Spec a card\n';
  assert.equal(skillDisplayName(content, 'some-folder'), 'spec-card');
});

test('strips surrounding quotes from the name', () => {
  assert.equal(skillDisplayName('---\nname: "spec card"\n---\n', 'some-folder'), 'spec card');
  assert.equal(skillDisplayName("---\nname: 'spec card'\n---\n", 'some-folder'), 'spec card');
});

test('handles CRLF line endings', () => {
  const content = '---\r\nname: spec-card\r\ndescription: x\r\n---\r\n\r\n# Spec a card\r\n';
  assert.equal(skillDisplayName(content, 'some-folder'), 'spec-card');
});

test('falls back to the folder name when there is no frontmatter', () => {
  assert.equal(skillDisplayName('# Just a heading\n\nSome prose.\n', 'build-card'), 'build-card');
});

test('falls back when the frontmatter is never closed', () => {
  assert.equal(skillDisplayName('---\nname: spec-card\ndescription: x\n', 'build-card'), 'build-card');
});

test('falls back when the frontmatter has no name key', () => {
  assert.equal(skillDisplayName('---\ndescription: x\nallowed-tools: Bash\n---\n', 'build-card'), 'build-card');
});

test('falls back when the name is empty', () => {
  assert.equal(skillDisplayName('---\nname:\ndescription: x\n---\n', 'build-card'), 'build-card');
  assert.equal(skillDisplayName('---\nname:   \ndescription: x\n---\n', 'build-card'), 'build-card');
});

test('ignores a name that only appears in the body', () => {
  const content = '---\ndescription: x\n---\n\nname: not-the-skill-name\n';
  assert.equal(skillDisplayName(content, 'build-card'), 'build-card');
});

test('ignores frontmatter that does not start the file', () => {
  const content = '# Heading first\n\n---\nname: not-the-skill-name\n---\n';
  assert.equal(skillDisplayName(content, 'build-card'), 'build-card');
});

test('survives empty and missing content', () => {
  assert.equal(skillDisplayName('', 'build-card'), 'build-card');
  assert.equal(skillDisplayName(undefined, 'build-card'), 'build-card');
});
