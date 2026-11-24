# pi-agent-profiles

`@johnnywu/pi-agent-profiles` is a shared library for loading Markdown agent profiles and applying them to Pi's system prompt. It supports Pi 1.6 and later in the 1.x series.

## Agent definitions

Name lookup uses the user's `~/.pi/agent/agents/` directory and the selected workspace's `.pi/agents/` directory. The project takes precedence by frontmatter `name`. Within one directory, the first file in filename order wins. Invalid files are reported with their paths.

```markdown
---
name: reviewer
description: Reviews code changes.
tools: read, grep, find, ls
skills: review-*, tdd
models: anthropic/claude-sonnet-4-6, magpie/claude/*, deep-*
systemPrompt: replace
thinking: high
---

Review the changes. Report actionable findings with file and line references.
```

The scalar frontmatter format also accepts `allowedAgents`, `maxDepth`, and `debug`. Only `name` is required. `thinking` defaults to `off`, `maxDepth` to `10`, and `systemPrompt` to `append`.

Use the comma-separated `models` field to allow model IDs and `*` patterns. A pattern such as `magpie/claude/*` matches a provider-qualified ID. A pattern such as `deep-*` can match the model ID alone. An omitted or empty list allows any model. Rename an existing `model` field to `models`. The loader warns and skips any profile that still contains `model`.

## Extension integration

```ts
import { applyAgentProfile, loadAgentDefinitions } from '@johnnywu/pi-agent-profiles';

const { agents, warnings } = await loadAgentDefinitions({ cwd: workspace });
const profile = agents.find((agent) => agent.name === selectedName);
// Report warnings and handle an unknown agent in the calling extension.
if (profile) {
  pi.on('before_agent_start', (event) => {
    const { missingSkills } = applyAgentProfile(profile, event.systemPromptOptions);
    // Report missingSkills through the extension's UI or tool result.
  });
}
```

Use `loadAgentFromPath(path, cwd)` for an explicit Markdown path, or `parseAgentProfile(content, path, source)` when the caller already has the contents. `loadAgentDefinitions` also accepts `agentDir`, `globalDir`, and `projectDir` overrides. By default it honors `PI_CODING_AGENT_DIR` for the user agent directory.

- `append` adds the profile body after Pi's existing append prompt.
- `replace` uses the profile body as Pi's custom preamble, injects visible tool descriptions and guidelines, and retains project context.
- `replace-all` also clears project context when assembling the prompt. A child launcher can pass Pi's `--no-context-files` option to skip loading those files entirely.

The optional `<pi-subagents-runtime-tools />` marker controls where the tool block appears in a replacement prompt. Pi renders the selected skills from the session's discovered skills. Patterns support `*`. A profile without `skills` supplies an empty skill list to the prompt. Callers can use `selectAgentSkills` to match a separate catalog or `formatRuntimeTools` to render the tool block independently.

Call `selectAgentModel(profile, requestedModel, getAvailableModels)` before launch. It rejects requests outside the list and defaults to the first entry. If that entry is a wildcard, it selects the first available model that matches or reports a missing match. When neither the request nor the profile specifies a model, it returns `undefined` so Pi can choose its default. The caller activates the selected model and tools, enforces delegation rules, and decides how to run and debug the session. Apply the profile after configuring tools so the descriptions reflect the active set.

## Development

```sh
bun install
bun run lint
bun test
bun run build
npm pack --dry-run
```
