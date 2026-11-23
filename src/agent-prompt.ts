import type { NormalizedBuildSystemPromptOptions } from '@earendil-works/pi-coding-agent';
import type { AgentProfile } from './agent-profile.js';

const runtimeToolsMarker = '<pi-subagents-runtime-tools />';

export interface SkillSelection<T> {
  selected: T[];
  missing: string[];
}

export function selectAgentSkills<T extends { name: string }>(
  patterns: readonly string[],
  available: readonly T[],
): SkillSelection<T> {
  const byName = new Map<string, T>();
  for (const skill of available) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }
  const selected = new Map<string, T>();
  const missing = new Set<string>();
  for (const pattern of patterns) {
    const exact = byName.get(pattern);
    let matches = exact ? [exact] : [];
    if (pattern.includes('*')) {
      const matcher = wildcardMatcher(pattern);
      matches = [...byName.values()].filter((skill) => matcher.test(skill.name));
    }
    if (!matches.length) missing.add(pattern);
    for (const skill of matches) selected.set(skill.name, skill);
  }
  return { selected: [...selected.values()], missing: [...missing] };
}

function wildcardMatcher(pattern: string): RegExp {
  const expression = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${expression}$`);
}

type ToolPromptOptions = Pick<
  NormalizedBuildSystemPromptOptions,
  'selectedTools' | 'hiddenTools' | 'toolSnippets' | 'toolGuidelines' | 'promptGuidelines'
>;

export function formatRuntimeTools(options: ToolPromptOptions): string {
  const visible = options.selectedTools.filter((name) => !options.hiddenTools.includes(name));
  const toolLines = visible.map((name) => {
    const snippet = options.toolSnippets[name];
    return snippet ? `- ${name}: ${snippet}` : `- ${name}`;
  });
  const shellOnly =
    visible.includes('bash') && !['grep', 'find', 'ls'].some((name) => visible.includes(name));
  const guidelines = new Set(
    [
      ...(shellOnly ? ['Use bash for file operations like ls, rg, find'] : []),
      ...visible.flatMap((name) => options.toolGuidelines[name] ?? []),
      ...options.promptGuidelines,
      'Be concise in your responses',
      'Show file paths clearly when working with files',
    ]
      .map((line) => line.trim())
      .filter(Boolean),
  );
  return [
    'Available tools:',
    ...(toolLines.length ? toolLines : ['(none)']),
    '',
    'Guidelines:',
    ...[...guidelines].map((line) => `- ${line}`),
  ].join('\n');
}

export interface AgentPromptResult {
  missingSkills: string[];
}

export function applyAgentProfile(
  profile: Pick<AgentProfile, 'prompt' | 'systemPromptMode' | 'skills'>,
  options: NormalizedBuildSystemPromptOptions,
): AgentPromptResult {
  const { selected, missing } = selectAgentSkills(profile.skills ?? [], options.skills);
  options.skills = selected;

  if (profile.systemPromptMode === 'append') {
    const prompt = profile.prompt.replaceAll(runtimeToolsMarker, '').trim();
    if (prompt)
      options.appendSystemPrompt = [options.appendSystemPrompt, prompt]
        .filter(Boolean)
        .join('\n\n');
  } else {
    const tools = formatRuntimeTools(options);
    options.customPrompt = profile.prompt.includes(runtimeToolsMarker)
      ? profile.prompt
          .replace(runtimeToolsMarker, () => tools)
          .replaceAll(runtimeToolsMarker, '')
          .trim()
      : [profile.prompt.trim(), tools].filter(Boolean).join('\n\n');
    if (profile.systemPromptMode === 'replace-all') options.contextFiles = [];
  }

  return { missingSkills: missing };
}
