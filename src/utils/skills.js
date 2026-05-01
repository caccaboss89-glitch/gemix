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
    const files = fs.readdirSync(SKILLS_DIR);
    const skills = [];

    for (const file of files) {
      if (file.endsWith('.md')) {
        const filePath = path.join(SKILLS_DIR, file);
        const content = fs.readFileSync(filePath, 'utf-8');

        // Extract YAML frontmatter
        const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (match) {
          const yaml = match[1];
          const nameMatch = yaml.match(/^name:\s*(.*)$/m);
          const descMatch = yaml.match(/^description:\s*(.*)$/m);

          if (nameMatch && descMatch) {
            skills.push({
              name: nameMatch[1].trim(),
              description: descMatch[1].trim(),
              filename: file
            });
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
  xml += '    <Instruction>If a skill matches the user request, call read_file on "skills:&lt;name&gt;.md" to get full technical instructions before proceeding.</Instruction>\n';
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
