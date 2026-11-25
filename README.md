# pi-agent-profiles

`@johnnywu/pi-agent-profiles` is a shared library for loading Markdown agent profiles and applying them to Pi's system prompt. It supports Pi 1.6 and later in the 1.x series.

## Agent definitions

`loadAgentDefinitions()` scans `~/.pi/agent/agents/*.md` and `<cwd>/.pi/agents/*.md`. A project definition overrides a global definition with the same `name`. Within one directory, the first valid definition in filename order wins. Invalid definitions are skipped and returned as warnings with their file paths. `PI_CODING_AGENT_DIR` changes the base directory for global definitions.

```markdown
---
name: reviewer
description: "Reviews changes for correctness and test coverage."
models: anthropic/claude-sonnet-4-6, magpie/claude/*, deep-*
thinking: high
tools: read, grep, find, ls, subagent
skills: review-*, tdd
allowedAgents: scout, test-writer
maxDepth: 2
systemPrompt: replace
debug: false
---

Review the changes. Report actionable findings with file and line references.

<pi-subagents-runtime-tools />
```

Start the file with a `---` block containing one `key: value` entry per line. The parser trims surrounding whitespace and strips quotes from the edges of a value. Blank lines and full-line `#` comments are ignored inside the block. Write lists as comma-separated values on one line (for example, `tools: read, grep`). The parser trims each item and skips empty items. Inline comments, YAML sequences, and multiline values have no special syntax. Field names are case-sensitive. A field name outside the reference below is an error, and the loader skips the definition with a warning, so a misspelled `maxDepth` or `allowedAgents` cannot silently lift a limit. The Markdown after the closing `---` is the agent prompt.

## Field reference

| Field | Default | Syntax and behavior |
| --- | --- | --- |
| `name` | Required | Non-empty string used to look up the profile. It can differ from the filename. |
| `description` | Omitted | Optional single-line summary for callers that display profile information. The Markdown body supplies the prompt. |
| `models` | Any model allowed | Comma-separated model IDs, provider-qualified IDs, or `*` patterns. See [Model selection](#model-selection). |
| `thinking` | `off` | One of `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. The launcher requests this reasoning level for the session. Pi may clamp it to the selected model's capabilities. |
| `tools` | Entry point's existing tool selection | Comma-separated tool names and `*` patterns, or a list of `+name` and `-name` entries. See [Tool selection](#tool-selection). |
| `skills` | No skills in the profile prompt | Comma-separated skill names or `*` patterns such as `review-*`. Matches the skill's declared `name` against the entry point's discovered skills. |
| `allowedAgents` | No additional name restriction | Comma-separated exact profile names for delegation, such as `scout, test-writer`. See [Delegation](#delegation). |
| `maxDepth` | `10` | Non-negative safe integer for the levels of delegated sessions allowed below the agent. See [Delegation](#delegation). |
| `systemPrompt` | `append` | One of `append`, `replace`, or `replace-all`. See [Prompt composition](#prompt-composition). |
| `debug` | `false` | `true` or `false` in lowercase. With `true`, the launchers write `debug-system-prompt.md` in the session working directory when a turn starts, overwriting the previous copy. |

### Model selection

- `models: anthropic/claude-sonnet-4-6, magpie/claude/*, deep-*` allows three kinds of entries. A provider-qualified entry matches the full selection. An unqualified entry such as `deep-*` also matches the model ID portion of a qualified selection.
- `subagent` and `hc_subagent` accept an optional `model` argument. A selection outside a configured list fails before launch. Leave it out to use the first `models` entry. If that entry is a pattern, the launcher takes the first matching model in Pi's available catalog. A pattern with no available match produces an error even if later entries could match.
- `pi --agent` applies the first entry to the current session. If model selection or activation fails, it warns and keeps the current model.
- An omitted or empty `models` list allows any caller selection. With no explicit selection, Pi keeps its normal model selection. Rename old `model:` fields to `models:`. A profile that still contains `model:` is rejected with a migration message.

### Tool selection

| Example | Behavior |
| --- | --- |
| `tools: read, hc_*` | Select tools by exact name or by a `*` pattern. |
| `tools: +grep, -write` | Add and remove exact names in list order. Child Pi sessions start from their default selection. `pi --agent` starts from the current session's active tools. |
| `tools:` or omitted | Keep the entry point's existing tool selection. |
| `tools: read, -write` or `tools: +hc_*` | Reject the profile. Use names and patterns together, or modifiers exclusively. Modifiers require exact tool names. |

`pi-subagents` passes the list to the child Pi's `--tools`. `pi-herdr-agents` passes the result of `herdrAgentTools()`: each exact `subagent` entry becomes the Herdr delegation tools `hc_subagent`, `hc_renew`, `hc_read`, `hc_stop`, and `hc_rm`, keeping any `+` or `-` prefix. A non-empty list also gets `hc_send` and `hc_agents` for reporting, as `+` entries in modifier mode. Pi applies its own tool availability and MCP exposure rules.

`pi --agent` resolves names and patterns against registered tools. When `hc_subagent` is registered, it first applies `herdrAgentTools()` and keeps `subagent`, so a Herdr lead gets both delegation tools, warns about entries with no match, and applies the result to the current session's active tool list. A non-empty allowlist with zero matches clears the active selection.

### Skills

Use `skills: review-*, tdd` to select matching skills or `skills: *` to select all discovered skills. `*` matches zero or more characters. Names and patterns are case-sensitive. An empty or omitted list leaves the profile prompt's skill selection empty. The shared prompt helper returns unmatched entries so each extension can report them. Pi renders the selected skill metadata in the system prompt.

### Delegation

`allowedAgents` restricts which named profiles a delegation tool can launch. Omit it or leave it empty to add no name restriction. The applicable delegation tool must also be available in the session.

| Entry point | `allowedAgents` | `maxDepth` |
| --- | --- | --- |
| `pi-subagents` | Filters the named agents offered by the child `subagent` tool to the names in both the profile's list and the launcher's own. When no name is left, the child cannot delegate to any agent. | Applies the depth rule below. A child past its limit gets no `subagent` tool. |
| `pi-herdr-agents` | Intersects the profile list with any inherited list. When restricted, `hc_subagent` requires an allowed agent name. | Applies the depth rule below. A child past its limit gets none of the five delegation tools. |
| `pi --agent` | Emits `pi-subagents:configure`, which restricts `subagent` from `pi-subagents` and `hc_subagent` from `pi-herdr-agents` when they are loaded. | Emits the profile's `maxDepth` on the same event, so both extensions count it from the current session. With `maxDepth: 0`, `custom-agent` also removes the delegation tools from the session. |

`maxDepth` is the number of levels of delegated sessions allowed below the agent, counted from the agent's own level wherever it runs. With `maxDepth: 0` the agent cannot delegate. With `maxDepth: 1` it can launch children, and those children cannot delegate further.

The limit passes down the chain, and a descendant can tighten it but not widen it. If `a`, `b`, and `c` each declare `maxDepth: 3`, and `a` launches `b`, `b` launches `c`, and `c` launches `d`, then `d` cannot delegate: it is already three levels below `a`. `pi-subagents` and `pi-herdr-agents` apply the same rule, each to its own chain of children.

### Prompt composition

| `systemPrompt` | Base prompt | Project context | Profile body and tools |
| --- | --- | --- | --- |
| `append` | Keep Pi's base prompt | Keep | Append the Markdown body after any existing addendum. Pi renders its normal tool information. |
| `replace` | Use the profile's custom preamble | Keep | Render the Markdown body with the visible runtime tool list and guidelines. |
| `replace-all` | Use the profile's custom preamble | Omit | Render the same replacement prompt with the project context cleared. The child launchers also pass `--no-context-files`. |

All modes apply the profile's `skills` selection. In replacement modes, put `<pi-subagents-runtime-tools />` in the body to place the tool list and guidelines at that point. By default, they follow the body. In `append` mode, the marker is removed.

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

Use `loadAgentFromPath(path, cwd)` for an explicit Markdown path, or `parseAgentProfile(content, path, source)` when the caller already has the contents. `loadAgentDefinitions` also accepts `agentDir`, `globalDir`, and `projectDir` overrides.

Call `selectAgentModel(profile, requestedModel, getAvailableModels)` to select or validate a model before activation. Child launchers can pass `profile.tools` to Pi's `--tools`. Current-session extensions can call `selectAgentTools(entries, available, active)` to resolve the declared selection and get unmatched entries. `selectAgentSkills` and `formatRuntimeTools` expose the skill matching and tool formatting independently.

Delegation extensions share one scope contract. A session that runs as an agent emits `delegationScopeEvent` on `pi.events` with a `DelegationScope` payload (`{ allowedAgents?, maxDepth? }`), and listeners read it with `parseDelegationScope(payload)`. `delegationDepthLimit(depth, maxDepth, inherited)` returns the deepest level that may still delegate, and an agent delegates while its depth is at most that limit. `narrowAllowedAgents(names, inherited)` limits a profile's agents to the inherited list.

The integrating extension sets the model, thinking level, and tools, and handles delegation and debug output. Apply the profile after configuring the tools so the rendered tool descriptions reflect the active selection.

## Development

```sh
bun install
bun run lint
bun test
bun run build
npm pack --dry-run
```
