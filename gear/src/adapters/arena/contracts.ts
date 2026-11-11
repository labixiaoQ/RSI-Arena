import { canonicalDigest } from '../../domain/canonical.js'

export interface Instruction {
  version: 1
  instruction: string
}
export interface HarnessBundle {
  executor: Instruction
  improver: Instruction
}
export type AgentPhase = 'propose' | 'lookahead' | 'learn'
export interface AgentRequest {
  phase: AgentPhase
  system: string
  input: string
}
export interface AgentReply {
  output: string
  usage: { model_requests: number; tokens: number }
  /** A confirmed response with measured usage whose output cannot be used. */
  invalid_output?: { reason: 'truncated'; detail: string }
}
export interface ModelBackend {
  readonly identity: string
  readonly kind: 'fixture' | 'live'
  allowance(request: AgentRequest): { model_requests: number; tokens: number }
  complete(request: AgentRequest, signal: AbortSignal): Promise<AgentReply>
}
export interface MatchRequest {
  id: string
  policy: string
  opponent: string
  seed: number
  seat: 0 | 1
  rounds: number
}
export interface MatchReceipt {
  status: 'complete' | 'policy_failed'
  score: number
  replay: string | null
  details: Record<string, unknown>
}
export interface CompileRequest {
  id: string
  policy: string
}
export interface CompileReceipt {
  status: 'ready' | 'policy_failed'
  diagnostics: string
}
export interface MatchBackend {
  readonly identity: string
  readonly kind: 'fixture' | 'monecraft'
  play(request: MatchRequest, signal: AbortSignal): Promise<MatchReceipt>
  compile?(request: CompileRequest, signal: AbortSignal): Promise<CompileReceipt>
}
export interface ArenaTask {
  id: string
  family: string
  split: 'seed' | 'held_out'
  seed: number
}
export interface ArenaProtocol {
  version: 1 | 2 | 3
  mode: 'fixed-improver' | 'recursive'
  lookaheadDepth: 1
  tasks: ArenaTask[]
  initialPolicy: string
  sdk: string
  opponents: string[]
  rounds: number
  learning?: {
    rules: string
    trainingSeeds: number[]
    trainingOpponents: string[]
    maxPolicyCalls: 3
    maxTokensPerCall: number
  }
}

export function boundedBundle(value: unknown, protocol: ArenaProtocol): HarnessBundle {
  const result = bundle(value)
  if (
    protocol.version >= 2 &&
    [result.executor, result.improver].some((entry) => Buffer.byteLength(entry.instruction) > 2048)
  )
    throw new Error(`Protocol v${protocol.version} instructions must fit in 2048 UTF-8 bytes each`)
  return result
}

/** The v3 clarification is part of model input, never retroactively added to v1/v2 runs. */
export function gameContract(protocol: ArenaProtocol): string {
  const rules = protocol.learning!.rules
  return protocol.version === 3
    ? rules +
        '\nRoundInfo.players contains only visible players; its vector index is not a player ID. Find your own player by matching Player.owner to RoundInfo.player_id. Never index ri.players[player_id]; handle a missing match without out-of-bounds access.'
    : rules
}

export function instruction(value: unknown): Instruction {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Instruction must be an object')
  const row = value as Record<string, unknown>
  if (
    Object.keys(row).some((key) => !['version', 'instruction'].includes(key)) ||
    row.version !== 1 ||
    typeof row.instruction !== 'string' ||
    !row.instruction.trim() ||
    Buffer.byteLength(row.instruction) > 32_768
  )
    throw new Error('Invalid or oversized instruction')
  return { version: 1, instruction: row.instruction }
}
export function bundle(value: unknown): HarnessBundle {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Harness must contain executor and improver')
  const row = value as Record<string, unknown>
  if (Object.keys(row).some((key) => !['executor', 'improver'].includes(key)))
    throw new Error('Harness contains an undeclared resource')
  return { executor: instruction(row.executor), improver: instruction(row.improver) }
}
export function digest(value: unknown): string {
  return canonicalDigest(value)
}
export function parseOutput(text: string): unknown {
  if (Buffer.byteLength(text) > 262_144) throw new Error('Agent output too large')
  return JSON.parse(
    text
      .trim()
      .replace(/^```(?:json)?\s*/u, '')
      .replace(/\s*```$/u, ''),
  )
}
