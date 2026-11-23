import type { NormalizedBuildSystemPromptOptions, Skill } from '@earendil-works/pi-coding-agent';
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyAgentProfile,
  loadAgentDefinitions,
  loadAgentFromPath,
  parseAgentProfile,
  selectAgentSkills,
} from '../src/index.js';

function markdown(fields: string, body = 'Review the changes.\n') {
  return `---\n${fields}\n---\n${body}`;
}

function skill(name: string): Skill {
  return {
    name,
    description: `Skill ${name}`,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    sourceInfo: {
      path: `/skills/${name}/SKILL.md`,
      scope: 'user',
      origin: 'top-level',
      source: 'local',
    },
    disableModelInvocation: false,
  };
}

function promptOptions(): NormalizedBuildSystemPromptOptions {
  return {
    cwd: '/workspace',
    appendSystemPrompt: 'User addendum.',
    contextFiles: [{ path: '/workspace/AGENTS.md', content: 'Project instructions.' }],
    selectedTools: ['bash', 'grep', 'hc_send'],
    hiddenTools: ['grep'],
    toolSnippets: {
      bash: 'Run commands.',
      grep: 'Search text.',
      hc_send: 'Report $& to your parent.',
    },
    toolGuidelines: { hc_send: ['Report results.', ' Report results. '], grep: ['Hidden rule.'] },
    promptGuidelines: [],
    skills: [skill('tdd'), skill('unrelated')],
    sections: {},
  };
}

test('parses scalar frontmatter, bare wildcard lists, and existing markers', () => {
  const document = markdown(
    [
      'name: reviewer',
      'description: "Reviews: correctness"',
      'tools: read, subagent',
      'skills: *, obsidian-*',
      'model: test/model',
      'allowedAgents: scout, tester',
      'maxDepth: 0',
      'thinking: high',
      'systemPrompt: replace-all',
      'debug: true',
    ].join('\n'),
    'Body.\n<pi-runtime-tools />\n',
  ).replaceAll('\n', '\r\n');
  expect(parseAgentProfile(`\uFEFF${document}`, 'review.md')).toMatchObject({
    name: 'reviewer',
    description: 'Reviews: correctness',
    tools: ['read', 'subagent'],
    skills: ['*', 'obsidian-*'],
    model: 'test/model',
    allowedAgents: ['scout', 'tester'],
    maxDepth: 0,
    thinking: 'high',
    systemPromptMode: 'replace-all',
    debug: true,
    prompt: 'Body.\n\n',
    source: 'path',
  });
});

test('loads directories with project overrides and reports invalid definitions', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-agent-profiles-'));
  try {
    const globalDir = join(cwd, 'user', 'agents');
    const projectDir = join(cwd, '.pi', 'agents');
    await Promise.all([
      mkdir(globalDir, { recursive: true }),
      mkdir(projectDir, { recursive: true }),
    ]);
    const invalidPath = join(projectDir, 'invalid.md');
    await Promise.all([
      writeFile(join(globalDir, 'review.md'), markdown('name: reviewer', 'Global.')),
      writeFile(join(globalDir, 'solo.md'), markdown('name: solo')),
      writeFile(join(projectDir, 'a.md'), markdown('name: reviewer', 'Project.')),
      writeFile(join(projectDir, 'b.md'), markdown('name: reviewer', 'Duplicate.')),
      writeFile(invalidPath, markdown('name: invalid\nsystemPrompt: unknown')),
    ]);
    const { agents, warnings } = await loadAgentDefinitions({ cwd, agentDir: join(cwd, 'user') });
    expect(agents).toMatchObject([
      { name: 'reviewer', prompt: 'Project.', source: 'project', thinking: 'off', maxDepth: 10 },
      { name: 'solo', source: 'global', systemPromptMode: 'append' },
    ]);
    expect(warnings).toEqual([{ filePath: invalidPath, message: 'invalid systemPrompt: unknown' }]);
    expect(await loadAgentFromPath('.pi/agents/a.md', cwd)).toMatchObject({
      name: 'reviewer',
      source: 'path',
      filePath: join(projectDir, 'a.md'),
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('selects named and wildcard skills in request order and reports missing names', () => {
  const first = { name: 'review-security', location: 'project' };
  const duplicate = { name: first.name, location: 'user' };
  const second = { name: 'review-correctness', location: 'user' };
  const literal = { name: 'review[manual]', location: 'user' };
  expect(
    selectAgentSkills(
      [second.name, 'review-*', 'review[*]', 'missing'],
      [first, duplicate, second, literal],
    ),
  ).toEqual({
    selected: [second, first, literal],
    missing: ['missing'],
  });
});

test('append preserves Pi addenda and lets Pi render the filtered skill list', () => {
  const options = promptOptions();
  const profile = parseAgentProfile(markdown('name: reviewer\nskills: tdd, missing'), 'review.md');
  expect(applyAgentProfile(profile, options)).toEqual({ missingSkills: ['missing'] });
  expect(options.appendSystemPrompt).toBe('User addendum.\n\nReview the changes.');
  expect(options.customPrompt).toBeUndefined();
  expect(options.contextFiles).toHaveLength(1);
  expect(options.skills.map(({ name }) => name)).toEqual(['tdd']);
});

test('replacement modes inject runtime guidance and handle project context', () => {
  for (const mode of ['replace', 'replace-all']) {
    const options = promptOptions();
    const profile = parseAgentProfile(
      markdown(
        `name: reviewer\nsystemPrompt: ${mode}`,
        'Before\n<pi-subagents-runtime-tools />\nAfter',
      ),
      'review.md',
    );
    applyAgentProfile(profile, options);
    expect(options.customPrompt).toStartWith('Before\nAvailable tools:\n- bash');
    expect(options.customPrompt).toEndWith('\nAfter');
    expect(options.customPrompt).toContain('Report $& to your parent.');
    expect(options.customPrompt?.match(/Report results\./g)).toHaveLength(1);
    expect(options.customPrompt).not.toContain('Hidden rule.');
    expect(options.customPrompt).not.toContain('Search text.');
    expect(options.customPrompt).not.toContain('<pi-subagents-runtime-tools />');
    expect(options.contextFiles).toHaveLength(mode === 'replace' ? 1 : 0);
    expect(options.skills).toEqual([]);
  }
});
