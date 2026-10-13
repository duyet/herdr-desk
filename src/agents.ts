import { claudeReader } from './sessions/claude'
import { codexReader } from './sessions/codex'
import { geminiReader } from './sessions/gemini'
import { grokReader } from './sessions/grok'
import type { SessionReader } from './sessions/types'

/**
 * What the desk needs to know about one coding-agent kind.
 *
 * Launch, prompt and liveness are not per-kind here: Herdr owns all three.
 * `agent start --kind <k>` launches, `agent prompt <name>` sends, and
 * `agent list` reports a normalized `agent_status` for every kind. A row only
 * carries what actually differs between agents.
 */
type AgentKindSpec = {
  /** Reads this agent's own transcripts into the session index. */
  transcripts?: SessionReader
}

/** Kinds `herdr agent start --kind` accepts (from `herdr agent start --help`). */
export const AGENT_KINDS = {
  pi: {},
  claude: { transcripts: claudeReader },
  codex: { transcripts: codexReader },
  gemini: { transcripts: geminiReader },
  cursor: {},
  devin: {},
  agy: {},
  cline: {},
  omp: {},
  mastracode: {},
  opencode: {},
  copilot: {},
  kimi: {},
  kiro: {},
  droid: {},
  amp: {},
  grok: { transcripts: grokReader },
  hermes: {},
  kilo: {},
  qodercli: {},
  qwen: {},
  maki: {},
  muse: {},
} satisfies Record<string, AgentKindSpec>

export type AgentKind = keyof typeof AGENT_KINDS

export function isAgentKind(name: string): name is AgentKind {
  return Object.hasOwn(AGENT_KINDS, name)
}

export function agentKindNames(): AgentKind[] {
  return Object.keys(AGENT_KINDS) as AgentKind[]
}

/** Session readers for every kind whose transcripts the desk can index. */
export function transcriptReaders(): SessionReader[] {
  return Object.values(AGENT_KINDS).flatMap((s: AgentKindSpec) =>
    s.transcripts ? [s.transcripts] : [],
  )
}

/**
 * First ladder rung `herdr agent start --kind` accepts. Command rungs and
 * unknown names are skipped; a ladder with none throws before any worktree is
 * spawned, naming the rungs, instead of failing inside Herdr.
 */
export function launchKind(ladder: string[]): AgentKind {
  for (const rung of ladder) {
    const name = rung.trim()
    if (isAgentKind(name)) return name
  }
  throw new Error(
    `agent ladder [${ladder.join(', ')}] has no Herdr agent kind; use one of: ${agentKindNames().join(', ')}`,
  )
}
