/** Hermes built-in memory policy adapted for DSH. Source is pinned, not moving main.
 * Upstream: NousResearch/hermes-agent (MIT), tools/memory_tool.py,
 * agent/prompt_builder.py and agent/background_review.py.
 */
export const UPSTREAM_COMMIT = 'c0c4357744d1a6994d332b826aea4c77fcccaf38'

export const MEMORY_GUIDANCE =
  'You have persistent memory, carried across sessions and loaded into each new session\'s context; the memory tool\'s schema defines what belongs there. ' +
  'Task-specific knowledge — procedures, pitfalls, and the user\'s preferences and corrections for that kind of work — belongs in skills, not in memory, even when skill writing is unavailable. ' +
  'Memory is the narrow exception for facts that apply to EVERY session regardless of task (who the user is, environment facts, standing conventions with no task home); it has a hard character budget, so when it fills, replace or consolidate stale entries rather than skipping the save. ' +
  'Write entries as declarative facts, not instructions to yourself: \'User prefers concise responses\' ✓ — \'Always respond concisely\' ✗ (imperative phrasing gets re-read as a directive in later sessions and can override the user\'s current request). ' +
  'A fact stale within a week belongs in session history; procedures and workflows belong in skills.'

export const MEMORY_REVIEW_PROMPT =
  'Review the conversation above and consider saving to memory if appropriate.\n\n' +
  'Memory has TWO distinct stores — pick the right one for each fact:\n' +
  '  • USER.md (memory tool, target=\'user\'): who the user is — persona, preferences, communication and work style, personal details they revealed, and expectations about how you should behave.\n' +
  '  • MEMORY.md (memory tool, target=\'memory\'): facts about the ENVIRONMENT you operate in — tool quirks, project conventions, config gotchas, paths and endpoints that matter.\n\n' +
  'One fact goes to ONE store, never both — writing it to both bloats both files until they hit their size limits and crowds out the facts that matter; misrouting it puts it where the next session won\'t look. If the tool schema lists only one target, that store is the only one enabled — use it and skip the other.\n\n' +
  'Save only facts GROUNDED in this conversation — a user message or tool result you can point to. Never infer the user\'s traits, skill level, role, mood or preferences from topic, tone or tools used, and never turn a one-off request into a standing preference (in either store) unless the user marked it general (\'always\', \'from now on\', \'remember\') or stated a standing like/dislike (\'I hate X\', \'stop doing Y\'). If unsure, leave it out — a wrong fact misleads every future session.\n\n' +
  'If something stands out, save it once, in the right store, using the memory tool with the matching target. If nothing is worth saving, just say \'Nothing to save.\' and stop.'

const bankNames = enabledBanks => ['memory', 'user'].filter(bank => enabledBanks.includes(bank))

/** DSH Tool parameter representation: required is stored per property. */
export function createMemoryToolParameters(enabledBanks = ['memory', 'user']) {
  const banks = bankNames(enabledBanks)
  return {
    target: {
      type: 'string', required: true, enum: banks,
      description: banks.length === 1
        ? `The enabled store: '${banks[0]}'.`
        : "'user' = who the user is (preferences, role, style); 'memory' = environment facts and standing conventions.",
    },
    operations: {
      type: 'array', required: true,
      description: 'All changes to this target, applied together against the final character budget. Each item uses add, patch, or remove; use separate calls for different stores.',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', required: true, enum: ['add', 'patch', 'remove'] },
          content: { type: 'string', description: 'add: new entry. patch: replacement text for the old_text span; whitespace is preserved.' },
          old_text: { type: 'string', description: 'patch/remove: text from one entry. patch replaces only this exact, unique span; remove deletes the matching whole entry.' },
        },
        additionalProperties: false,
      },
    },
  }
}

export function createMemoryToolDescription(enabledBanks = ['memory', 'user']) {
  const banks = bankNames(enabledBanks)
  const routing = banks.length === 1
    ? `Only target='${banks[0]}' is enabled; never target the disabled store.`
    : "TARGETS: 'user' = who the user is (name, role, preferences, style). 'memory' = your notes (environment, conventions, tool quirks, lessons)."
  return [
    'Save compact, durable facts to persistent memory that survives across sessions.',
    "Make all changes to one target in ONE call through operations: [{action, content?, old_text?}]. The batch is atomic; only its final character count must fit, so remove or patch stale entries and add new facts together. A successful result completes the update; do not repeat it.",
    'Save only facts that apply to EVERY session regardless of task. Task procedures, pitfalls and task-specific preferences belong in skills, even when skill writing is unavailable. Transient progress, completed-work logs and TODOs belong in session history.',
    routing,
    "add creates one entry; patch edits exactly one unique old_text span and preserves the rest of that entry; remove deletes the matching entry. To replace a whole entry, patch with its full exact text as old_text. Write declarative facts grounded in a user message or tool result, never inferred traits or new instructions to yourself.",
  ].join('\n\n')
}
