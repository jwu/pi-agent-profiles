import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
const promptModes = ['append', 'replace', 'replace-all'] as const;

export type AgentSource = 'global' | 'project' | 'path';
export type ThinkingLevel = (typeof thinkingLevels)[number];
export type SystemPromptMode = (typeof promptModes)[number];

export interface AgentProfile {
  name: string;
  description?: string;
  models?: string[];
  thinking: ThinkingLevel;
  tools: string[];
  skills?: string[];
  allowedAgents?: string[];
  maxDepth: number;
  debug: boolean;
  systemPromptMode: SystemPromptMode;
  prompt: string;
  source: AgentSource;
  filePath: string;
}

export interface AgentDefinitionWarning {
  filePath: string;
  message: string;
}

export interface AgentDefinitions {
  agents: AgentProfile[];
  warnings: AgentDefinitionWarning[];
}

export interface LoadAgentDefinitionsOptions {
  cwd?: string;
  agentDir?: string;
  globalDir?: string;
  projectDir?: string;
  fs?: AgentDefinitionFs;
}

export interface AgentDefinitionFs {
  listFiles(dir: string): Promise<string[]>;
  readFile(filePath: string): Promise<string>;
}

const defaultFs: AgentDefinitionFs = {
  async listFiles(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() || entry.isSymbolicLink())
      .map((entry) => join(dir, entry.name));
  },
  readFile(filePath) {
    return readFile(filePath, 'utf8');
  },
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function csv(value = ''): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function choice<T extends string>(
  field: string,
  value: string | undefined,
  choices: readonly T[],
): T {
  const match = choices.find((item) => item === (value ?? choices[0]));
  if (!match) throw new Error(`invalid ${field}: ${value}`);
  return match;
}

export function parseAgentProfile(
  content: string,
  filePath: string,
  source: AgentSource = 'path',
): AgentProfile {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) throw new Error('missing frontmatter');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match) throw new Error('missing frontmatter terminator');

  // The original scalar format allows bare wildcards and comma-separated names.
  const fields = new Map<string, string>();
  for (const line of match[1].split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf(':');
    if (separator === -1) throw new Error(`invalid frontmatter line: ${line}`);
    const key = trimmed.slice(0, separator).trim();
    if (!key) throw new Error(`invalid frontmatter key: ${line}`);
    fields.set(
      key,
      trimmed
        .slice(separator + 1)
        .trim()
        .replace(/^['"]|['"]$/g, ''),
    );
  }

  if (fields.has('model'))
    throw new Error('The `model` field is no longer supported. Please use `models` instead.');

  const name = fields.get('name');
  if (!name) throw new Error('missing required field: name');
  const thinking = choice('thinking', fields.get('thinking'), thinkingLevels);
  const systemPromptMode = choice('systemPrompt', fields.get('systemPrompt'), promptModes);
  const maxDepth = Number(fields.get('maxDepth') ?? 10);
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new Error(`invalid maxDepth: ${fields.get('maxDepth')}`);
  }
  const debug = fields.get('debug');
  if (debug !== undefined && debug !== 'true' && debug !== 'false') {
    throw new Error(`invalid debug: ${debug}`);
  }
  const models = csv(fields.get('models'));
  const tools = csv(fields.get('tools'));
  validateToolList(tools);
  const skills = csv(fields.get('skills'));
  const allowedAgents = csv(fields.get('allowedAgents'));

  return {
    name,
    description: fields.get('description') || undefined,
    models: models.length ? models : undefined,
    thinking,
    tools,
    skills: skills.length ? skills : undefined,
    allowedAgents: allowedAgents.length ? allowedAgents : undefined,
    maxDepth,
    debug: debug === 'true',
    systemPromptMode,
    prompt: normalized
      .slice(match[0].length)
      .replace(/^\n+/, '')
      .replaceAll('<pi-runtime-tools />', ''),
    source,
    filePath,
  };
}

export function wildcardMatcher(pattern: string): RegExp {
  const expression = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${expression}$`);
}

export function selectAgentModel(
  profile: Pick<AgentProfile, 'name' | 'models'> | undefined,
  requestedModel?: string,
  getAvailableModels?: () => readonly { provider: string; id: string }[],
): string | undefined {
  const requested = requestedModel?.trim() || undefined;
  const allowed = profile?.models;
  if (!profile || !allowed?.length) return requested;

  if (requested) {
    const modelId = requested.slice(requested.indexOf('/') + 1);
    if (
      !requested.includes('*') &&
      allowed.some((pattern) => {
        const matches = wildcardMatcher(pattern);
        return matches.test(requested) || (!pattern.includes('/') && matches.test(modelId));
      })
    ) {
      return requested;
    }
    throw new Error(
      `Model "${requested}" is not allowed for agent "${profile.name}". Allowed models: ${allowed.join(', ')}.`,
    );
  }

  const first = allowed[0];
  if (!first.includes('*')) return first;
  const matches = wildcardMatcher(first);
  for (const { provider, id } of getAvailableModels?.() ?? []) {
    const qualified = `${provider}/${id}`;
    if (matches.test(qualified) || (!first.includes('/') && matches.test(id))) return qualified;
  }
  throw new Error(
    `No available models match default pattern "${first}" for agent "${profile.name}".`,
  );
}

function isToolModifier(entry: string): boolean {
  return entry.startsWith('+') || entry.startsWith('-');
}

function validateToolList(entries: readonly string[]): void {
  const modifiers = entries.filter(isToolModifier);
  if (modifiers.length && modifiers.length !== entries.length) {
    throw new Error('invalid tools: tool names cannot be mixed with +name or -name entries');
  }
  const pattern = modifiers.find((entry) => entry.includes('*'));
  if (pattern) {
    throw new Error(
      `invalid tools: +name and -name entries take exact tool names, not patterns: ${pattern}`,
    );
  }
}

export function selectAgentTools(
  entries: readonly string[],
  available: readonly string[],
  active: readonly string[],
): { selected: string[]; missing: string[] } {
  validateToolList(entries);
  if (!entries.length) return { selected: [...active], missing: [] };

  const missing = new Set<string>();
  if (isToolModifier(entries[0])) {
    const availableNames = new Set(available);
    const selected = new Set(active);
    for (const entry of entries) {
      const name = entry.slice(1);
      if (!availableNames.has(name)) {
        missing.add(entry);
      } else if (entry.startsWith('+')) {
        selected.add(name);
      } else {
        selected.delete(name);
      }
    }
    return { selected: [...selected], missing: [...missing] };
  }

  const selected = new Set<string>();
  for (const entry of entries) {
    const pattern = wildcardMatcher(entry);
    const matches = available.filter((name) => pattern.test(name));
    if (!matches.length) missing.add(entry);
    for (const name of matches) selected.add(name);
  }
  return { selected: [...selected], missing: [...missing] };
}

/** Tools a Herdr agent uses to delegate to and manage its children. */
export const herdrDelegationTools = [
  'hc_subagent',
  'hc_renew',
  'hc_read',
  'hc_stop',
  'hc_rm',
] as const;
/** Tools every Herdr agent keeps for reporting and coordination. */
export const herdrReportingTools = ['hc_send', 'hc_agents'] as const;

/**
 * Translate a profile's tool list for a session that runs in Herdr Core. Each exact `subagent`
 * entry selects the Herdr delegation tools with the same `+` or `-` prefix, and keeps the
 * `subagent` entry itself when `keepSubagent` is set. A non-empty list also selects the reporting
 * tools, as `+` entries in modifier mode. An empty list stays empty.
 */
export function herdrAgentTools(
  entries: readonly string[],
  options: { keepSubagent?: boolean } = {},
): string[] {
  validateToolList(entries);
  if (!entries.length) return [];
  const tools = entries.flatMap((entry) => {
    const prefix = /^([+-]?)subagent$/.exec(entry)?.[1];
    if (prefix === undefined) return [entry];
    const delegation = herdrDelegationTools.map((tool) => `${prefix}${tool}`);
    return options.keepSubagent ? [entry, ...delegation] : delegation;
  });
  const modifiers = isToolModifier(entries[0]);
  for (const tool of herdrReportingTools) tools.push(modifiers ? `+${tool}` : tool);
  return tools;
}

export async function loadAgentFromPath(
  selector: string,
  cwd = process.cwd(),
): Promise<AgentProfile> {
  const input = selector.trim();
  const filePath = resolve(cwd, /^~[/\\]/.test(input) ? join(homedir(), input.slice(2)) : input);
  if (!filePath.toLowerCase().endsWith('.md'))
    throw new Error('agent path must point to a .md file');
  return parseAgentProfile(await readFile(filePath, 'utf8'), filePath);
}

export async function loadAgentDefinitions(
  options: LoadAgentDefinitionsOptions = {},
): Promise<AgentDefinitions> {
  const cwd = options.cwd ?? process.cwd();
  const agentDir =
    options.agentDir ?? (process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'));
  const dirs = [
    [resolve(options.globalDir ?? join(agentDir, 'agents')), 'global'],
    [resolve(cwd, options.projectDir ?? join('.pi', 'agents')), 'project'],
  ] as const;
  const warnings: AgentDefinitionWarning[] = [];
  const byName = new Map<string, AgentProfile>();

  const fileSystem = options.fs ?? defaultFs;
  for (const [dir, source] of dirs) {
    const files = await fileSystem.listFiles(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') warnings.push({ filePath: dir, message: errorMessage(error) });
      return [];
    });
    const seen = new Set<string>();
    for (const filePath of [...files].sort()) {
      if (!filePath.endsWith('.md')) continue;
      try {
        const agent = parseAgentProfile(await fileSystem.readFile(filePath), filePath, source);
        if (seen.has(agent.name)) continue;
        seen.add(agent.name);
        byName.set(agent.name, agent);
      } catch (error) {
        warnings.push({ filePath, message: errorMessage(error) });
      }
    }
  }
  return { agents: [...byName.values()], warnings };
}
