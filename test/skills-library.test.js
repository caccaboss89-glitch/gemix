// test/skills-library.test.js
//
// The skill library as the prompt sees it: frontmatter parsing, what makes a
// skill installed, and the section built from it. A malformed SKILL.md must
// cost the library one entry, never the whole section.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import constants from '../src/config/constants.js';
import {
  _resetSkillsCacheForTests,
  listInstalledSkills,
  skillsLibraryPath
} from '../src/sandbox/skillsLibrary.js';

/** A throwaway skill directory, removed by the test that made it. */
function withSkill(name, contents, fn) {
  const dir = path.join(constants.SKILLS_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), contents, 'utf8');
  _resetSkillsCacheForTests();
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    _resetSkillsCacheForTests();
  }
}

test('the library lives with the code, not in a workspace', () => {
  assert.equal(skillsLibraryPath(), constants.SKILLS_DIR);
  assert.ok(fs.existsSync(constants.SKILLS_DIR), 'the bundled skills must ship with the repo');
});

test('the skills bundled in the repo are all readable', () => {
  _resetSkillsCacheForTests();
  const skills = listInstalledSkills();
  assert.ok(skills.length > 0, 'the repo ships at least one skill');
  for (const skill of skills) {
    assert.match(skill.name, /^[a-z0-9][a-z0-9-]*$/, skill.name);
    assert.ok(skill.description.trim().length > 0, skill.name);
    assert.equal(skill.path, `skills/${skill.name}/SKILL.md`);
  }
  assert.deepEqual(skills.map(s => s.name), [...skills.map(s => s.name)].sort());
});

test('a skill is its frontmatter description, and the directory names it', () => {
  withSkill('zz-test-frontmatter', [
    '---',
    'name: something-else',
    'description: What it does, and when to reach for it.',
    'extra: ignored',
    '---',
    '',
    '# Body the prompt never carries'
  ].join('\n'), () => {
    const skill = listInstalledSkills().find(s => s.name === 'zz-test-frontmatter');
    assert.ok(skill, 'the new skill is picked up');
    assert.equal(skill.description, 'What it does, and when to reach for it.');
    assert.equal(skill.path, 'skills/zz-test-frontmatter/SKILL.md');
  });
});

test('a SKILL.md with no usable frontmatter is skipped, the rest still load', () => {
  withSkill('zz-test-broken', '# No frontmatter here\n\nJust prose.\n', () => {
    const skills = listInstalledSkills();
    assert.equal(skills.some(s => s.name === 'zz-test-broken'), false);
    assert.ok(skills.length > 0, 'one bad skill does not empty the library');
  });
});

test('a directory without a SKILL.md is not a skill', () => {
  const dir = path.join(constants.SKILLS_DIR, 'zz-test-empty');
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'run.py'), '# nothing\n', 'utf8');
  _resetSkillsCacheForTests();
  try {
    assert.equal(listInstalledSkills().some(s => s.name === 'zz-test-empty'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    _resetSkillsCacheForTests();
  }
});

test('root files and nested assets cannot hide later skill manifests', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemix-skill-discovery-'));
  const original = constants.SKILLS_DIR;
  constants.SKILLS_DIR = root;
  try {
    for (let i = 0; i < 205; i++) fs.writeFileSync(path.join(root, `file-${i}.txt`), 'asset');
    withSkill('first', '---\ndescription: First skill\n---\n', dir => {
      for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(dir, `asset-${i}.txt`), 'asset');
      withSkill('zz-last', '---\ndescription: Last skill\n---\n', () => {
        assert.deepEqual(listInstalledSkills().map(skill => skill.name), ['first', 'zz-last']);
      });
    });
  } finally {
    constants.SKILLS_DIR = original;
    fs.rmSync(root, { recursive: true, force: true });
    _resetSkillsCacheForTests();
  }
});
