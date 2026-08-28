// Derives the display name for a skill from its SKILL.md.
//
// Every skill file is called SKILL.md, so the filename is useless as a label.
// The name comes from the `name:` key in the leading YAML frontmatter; anything
// missing, malformed or empty falls back to the skill's folder name so a row can
// never end up titled "SKILL.md".

function skillDisplayName(content, folderName) {
  try {
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content || '');
    if (frontmatter) {
      const nameLine = /^name:[^\S\r\n]*(.+)$/m.exec(frontmatter[1]);
      if (nameLine) {
        const name = nameLine[1].trim().replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
        if (name) return name;
      }
    }
  } catch {}
  return folderName;
}

module.exports = { skillDisplayName };
