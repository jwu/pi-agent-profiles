import type { NormalizedBuildSystemPromptOptions, Skill } from '@earendil-works/pi-coding-agent';
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyAgentProfile,
  delegationDepthLimit,
  delegationScopeEvent,
  herdrAgentTools,
  loadAgentDefinitions,
  loadAgentFromPath,
  narrowAllowedAgents,
  parseAgentProfile,
  parseDelegationScope,
  selectAgentModel,
  selectAgentTools,
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

test('parses scalar frontmatter and bare wildcard lists', () => {
  const document = markdown(
    [
      'name: reviewer',
      'description: "Reviews: correctness"',
      'tools: read, subagent',
      'skills: *, obsidian-*',
      'models: test/model, magpie/claude/*, deep-*',
      'allowedAgents: scout, tester',
      'maxDepth: 0',
      'thinking: high',
      'systemPrompt: replace-all',
      'debug: true',
    ].join('\n'),
    'Body.\n',
  ).replaceAll('\n', '\r\n');
  expect(parseAgentProfile(`\uFEFF${document}`, 'review.md')).toMatchObject({
    name: 'reviewer',
    description: 'Reviews: correctness',
    tools: ['read', 'subagent'],
    skills: ['*', 'obsidian-*'],
    models: ['test/model', 'magpie/claude/*', 'deep-*'],
    allowedAgents: ['scout', 'tester'],
    maxDepth: 0,
    thinking: 'high',
    systemPromptMode: 'replace-all',
    debug: true,
    prompt: 'Body.\n',
    source: 'path',
  });
});

test('selects allowed models and uses the first configured entry by default', () => {
  const profile = parseAgentProfile(
    markdown('name: reviewer\nmodels: test/model, magpie/claude/*, deep-*'),
    'review.md',
  );
  expect(selectAgentModel(profile)).toBe('test/model');
  expect(selectAgentModel(profile, 'magpie/claude/sonnet')).toBe('magpie/claude/sonnet');
  expect(selectAgentModel(profile, 'deep-flash')).toBe('deep-flash');
  expect(selectAgentModel(profile, 'deepseek/deep-flash')).toBe('deepseek/deep-flash');
  expect(() => selectAgentModel(profile, 'other/magpie/claude/sonnet')).toThrow('is not allowed');
  expect(() => selectAgentModel(profile, 'other/model')).toThrow('is not allowed');
});

test('resolves a wildcard default against available models in catalog order', () => {
  const profile = { name: 'reviewer', models: ['magpie/claude/*', 'test/model'] };
  const available = () => [
    { provider: 'test', id: 'model' },
    { provider: 'magpie', id: 'claude/sonnet' },
    { provider: 'magpie', id: 'claude/opus' },
  ];
  expect(selectAgentModel(profile, undefined, available)).toBe('magpie/claude/sonnet');
  expect(() => selectAgentModel(profile, undefined, () => available().slice(0, 1))).toThrow(
    'No available models match default pattern "magpie/claude/*"',
  );
});

test('accepts any requested model with an omitted or empty list', () => {
  for (const fields of ['name: reviewer', 'name: reviewer\nmodels: ']) {
    const unrestricted = parseAgentProfile(markdown(fields), 'review.md');
    expect(selectAgentModel(unrestricted)).toBeUndefined();
    expect(selectAgentModel(unrestricted, 'other/model')).toBe('other/model');
  }
});

test('rejects the old model field even when models is also configured', () => {
  expect(() =>
    parseAgentProfile(markdown('name: reviewer\nmodel:\nmodels: new/model'), 'review.md'),
  ).toThrow('Please use `models` instead.');
});

test('selects exact and wildcard tools, reporting entries with no matches', () => {
  const available = ['read', 'write', 'hc_subagent', 'hc_send'];
  expect(selectAgentTools(['read', 'hc_*', 'read', 'missing*'], available, ['write'])).toEqual({
    selected: ['read', 'hc_subagent', 'hc_send'],
    missing: ['missing*'],
  });
  expect(selectAgentTools(['missing*'], available, ['write'])).toEqual({
    selected: [],
    missing: ['missing*'],
  });
});

test('modifies the active tools in order and leaves an omitted list unchanged', () => {
  const available = ['read', 'write', 'grep'];
  expect(
    selectAgentTools(['+grep', '-write', '-grep', '+grep', '+missing'], available, [
      'read',
      'write',
    ]),
  ).toEqual({
    selected: ['read', 'grep'],
    missing: ['+missing'],
  });
  expect(selectAgentTools([], available, ['read', 'write'])).toEqual({
    selected: ['read', 'write'],
    missing: [],
  });
});

test('rejects invalid tools syntax when loading a profile', () => {
  const parse = (tools: string) =>
    parseAgentProfile(markdown(`name: reviewer\ntools: ${tools}`), 'review.md');
  expect(parse('+grep, -write').tools).toEqual(['+grep', '-write']);
  expect(() => parse('read, -write')).toThrow('cannot be mixed');
  expect(() => parse('+hc_*')).toThrow('entries take exact tool names');
});

test('rejects unknown fields so a misspelled limit is not ignored', () => {
  const parse = (fields: string) =>
    parseAgentProfile(markdown(`name: reviewer\n${fields}`), 'review.md');
  expect(() => parse('maxdepth: 0')).toThrow('unknown field: maxdepth. Supported fields: name,');
  expect(() => parse('allowedagents: scout\ntool: read')).toThrow(
    'unknown fields: allowedagents, tool.',
  );
  expect(parse('maxDepth: 0\nallowedAgents: scout')).toMatchObject({
    maxDepth: 0,
    allowedAgents: ['scout'],
  });
});

test('counts maxDepth from the agent and passes the tightest limit down the chain', () => {
  const canDelegate = (depth: number, limit: number | undefined) =>
    limit === undefined || depth <= limit;

  // A lead at depth 0: maxDepth 0 forbids delegation, and maxDepth 1 allows one level.
  expect(canDelegate(0, delegationDepthLimit(0, 0))).toBe(false);
  const lead = delegationDepthLimit(0, 1);
  expect(canDelegate(0, lead)).toBe(true);
  expect(canDelegate(1, delegationDepthLimit(1, 10, lead))).toBe(false);

  // a, b, c, and d each declare maxDepth: 3, with a at depth 1. The budget of a runs out at d.
  const limits: number[] = [];
  for (let depth = 1; depth <= 4; depth++) {
    limits.push(delegationDepthLimit(depth, 3, limits.at(-1))!);
  }
  expect(limits).toEqual([3, 3, 3, 3]);
  expect(limits.map((limit, index) => canDelegate(index + 1, limit))).toEqual([
    true,
    true,
    true,
    false,
  ]);

  // The same maxDepth: 1 profile delegates one level wherever it runs.
  expect(delegationDepthLimit(2, 1, 10)).toBe(2);
  // A descendant can tighten the inherited limit, and a session without a profile keeps it.
  expect(delegationDepthLimit(3, 0, 5)).toBe(2);
  expect(delegationDepthLimit(3, undefined, 5)).toBe(5);
  expect(delegationDepthLimit(3, undefined)).toBeUndefined();
});

test('narrows allowed agents to the inherited list', () => {
  expect(narrowAllowedAgents(['worker', 'scout', 'worker'], ['scout', 'worker'])).toEqual([
    'worker',
    'scout',
  ]);
  expect(narrowAllowedAgents(['scout'], ['worker'])).toEqual([]);
  expect(narrowAllowedAgents(['scout'], undefined)).toEqual(['scout']);
  expect(narrowAllowedAgents(undefined, ['worker'])).toEqual(['worker']);
  expect(narrowAllowedAgents(undefined, undefined)).toBeUndefined();
});

test('reads the delegation scope event payload and drops malformed fields', () => {
  expect(delegationScopeEvent).toBe('pi-subagents:configure');
  expect(parseDelegationScope({ allowedAgents: ['scout', 1], maxDepth: 2 })).toEqual({
    allowedAgents: ['scout'],
    maxDepth: 2,
  });
  expect(parseDelegationScope({ allowedAgents: [], maxDepth: 0 })).toEqual({
    allowedAgents: [],
    maxDepth: 0,
  });
  for (const payload of [undefined, null, 'scout', { allowedAgents: 'scout', maxDepth: -1 }]) {
    expect(parseDelegationScope(payload)).toEqual({
      allowedAgents: undefined,
      maxDepth: undefined,
    });
  }
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
    const legacyPath = join(projectDir, 'legacy.md');
    await Promise.all([
      writeFile(join(globalDir, 'review.md'), markdown('name: reviewer', 'Global.')),
      writeFile(join(globalDir, 'solo.md'), markdown('name: solo')),
      writeFile(join(projectDir, 'a.md'), markdown('name: reviewer', 'Project.')),
      writeFile(join(projectDir, 'b.md'), markdown('name: reviewer', 'Duplicate.')),
      writeFile(invalidPath, markdown('name: invalid\nsystemPrompt: unknown')),
      writeFile(legacyPath, markdown('name: legacy\nmodel: test/model')),
    ]);
    const { agents, warnings } = await loadAgentDefinitions({ cwd, agentDir: join(cwd, 'user') });
    expect(agents).toMatchObject([
      { name: 'reviewer', prompt: 'Project.', source: 'project', thinking: 'off', maxDepth: 10 },
      { name: 'solo', source: 'global', systemPromptMode: 'append' },
    ]);
    expect(warnings).toEqual([
      { filePath: invalidPath, message: 'invalid systemPrompt: unknown' },
      {
        filePath: legacyPath,
        message: 'The `model` field is no longer supported. Please use `models` instead.',
      },
    ]);
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

test('maps subagent to the Herdr delegation tools and adds the reporting tools', () => {
  const delegation = ['hc_subagent', 'hc_renew', 'hc_read', 'hc_stop', 'hc_rm'];
  expect(herdrAgentTools([])).toEqual([]);
  expect(herdrAgentTools(['read', 'subagent'])).toEqual([
    'read',
    ...delegation,
    'hc_send',
    'hc_agents',
  ]);
  expect(herdrAgentTools(['read', 'subagent'], { keepSubagent: true })).toEqual([
    'read',
    'subagent',
    ...delegation,
    'hc_send',
    'hc_agents',
  ]);
  expect(herdrAgentTools(['-subagent', '+grep'])).toEqual([
    ...delegation.map((tool) => `-${tool}`),
    '+grep',
    '+hc_send',
    '+hc_agents',
  ]);
  expect(herdrAgentTools(['read', 'subagent*'])).toEqual([
    'read',
    'subagent*',
    'hc_send',
    'hc_agents',
  ]);
  expect(() => herdrAgentTools(['read', '-write'])).toThrow('cannot be mixed');
});
