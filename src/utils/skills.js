// src/utils/skills.js
const fs = require('fs');
const path = require('path');
const { SKILLS_DIR } = require('./userPaths');
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
 * Formats skill metadata into an XML block for the system prompt.
 * Instructs the AI to read the full file if needed.
 */
function formatSkillsForPrompt(skills) {
  if (!skills || skills.length === 0) {
    return '';
  }

  let xml = '  <Skills>\n';
  xml += '    <Instruction>CRITICAL: If a skill matches the request, you MUST call `read_file` on its &lt;Source&gt; path IMMEDIATELY. DO NOT write manual scripts, guess code before reading the documentation or search images with save_to_disk=false.</Instruction>\n';
  for (const skill of skills) {
    xml += `    <Skill name="${skill.name}">\n      <Description>${skill.description}</Description>\n      <Source>skills:${skill.filename}</Source>\n    </Skill>\n`;
  }
  xml += '  </Skills>\n';
  return xml;
}

module.exports = {
  loadSkills,
  formatSkillsForPrompt
};
