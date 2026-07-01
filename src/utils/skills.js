// src/utils/skills.js
//
// Loads metadata from the SKILL.md files in src/data/skills/ and formats
// them into the <Skills> block that gets injected into the build sub-agent's
// system prompt. The actual skill recipes are read on-demand by the agent
// via read_file.

const fs = require('fs');
const path = require('path');
const { SKILLS_DIR } = require('./userPaths');
const { escapeXml } = require('./xmlEscape');
const { createLogger } = require('./logger');

const log = createLogger('Skills');

/**
 * Loads metadata from all .md skill files in the skills directory.
 * Extracts content between '---' markers.
 * Returns an array of { name: string, description: string }.
 */
function loadSkills() {
  if (!fs.existsSync(SKILLS_DIR)) {
    return [];
  }

  try {
    const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
    const skills = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillName = entry.name;
        const filePath = path.join(SKILLS_DIR, skillName, 'SKILL.md');

        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, 'utf-8');

          // Extract YAML frontmatter (more robust regex)
          const match = content.match(/^\s*---\r?\n([\s\S]*?)\r?\n---/);
          if (match) {
            const yaml = match[1];
            const nameMatch = yaml.match(/^name:\s*(.*)$/m);
            const descMatch = yaml.match(/^description:\s*(.*)$/m);

            if (nameMatch && descMatch) {
              const parsedName = nameMatch[1].trim();
              if (parsedName !== skillName) {
                log.warn(`Skill folder name '${skillName}' does not match name in frontmatter '${parsedName}'`);
              }
              skills.push({
                name: parsedName,
                description: descMatch[1].trim(),
                filename: `${skillName}/SKILL.md`
              });
            } else {
              log.warn(`Skill at '${filePath}' missing 'name' or 'description' in frontmatter`);
            }
          } else {
            log.warn(`Skill at '${filePath}' has invalid or missing frontmatter (must start with ---)`);
          }
        }
      }
    }

    return skills;
  } catch (err) {
    log.error(`Failed to load skills: ${err.message}`);
    return [];
  }
}

/**
 * Format the loaded skills into the <Skills> block injected into the build
 * sub-agent's system prompt. Dynamic: whatever skill folders exist on disk
 * (each with a SKILL.md whose frontmatter carries name + description) show up
 * here, so there is no static list to maintain. The description tells the
 * agent WHEN a skill applies; it reads SKILL.md and any companion guides in one
 * read_file call (path is a string array) only when it actually needs the recipe.
 *
 * Indentation matches the surrounding two-space prompt blocks.
 */
function formatSkillsForPrompt(skills) {
  if (!Array.isArray(skills) || skills.length === 0) {
    return '';
  }
  const lines = ['<Skills>'];
  lines.push('  Each skill below is a guided workflow with helper scripts. When a task matches a skill\'s purpose, read its SKILL.md and any companion guides you need before writing your own code, then follow it.');
  lines.push('  Templates under /skills/ are starting points: if the deliverable content differs heavily from the template (topic, language, slide text), write_file a fresh script using the skill\'s patterns — do not cp then many edit_file calls.');
  for (const s of skills) {
    lines.push(`  <Skill name="${escapeXml(s.name)}" doc="/skills/${escapeXml(s.filename)}">${escapeXml(s.description)}</Skill>`);
  }
  lines.push('</Skills>');
  return lines.join('\n');
}

/** Comma-separated skill names (frontmatter `name` only) for the build tool description. */
function formatSkillNamesList(skills) {
  const list = (Array.isArray(skills) ? skills : loadSkills()).map(s => s.name);
  return list.length ? list.join(', ') : '';
}

module.exports = {
  loadSkills,
  formatSkillsForPrompt,
  formatSkillNamesList,
};
