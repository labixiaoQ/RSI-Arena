import type { ArenaBudget } from './budget.js'
import { digest, parseOutput, type AgentPhase, type ArenaProtocol, type ModelBackend } from './contracts.js'

/** Only raised after the model receipt and measured usage have been committed. */
export class InvalidAgentOutput extends Error {
  constructor(
    readonly reason: 'malformed_json' | 'truncated',
    readonly outputDigest: string,
    detail: string,
  ) {
    super(detail)
  }
}

export type AgentCall = (
  id: string,
  phase: AgentPhase,
  system: string,
  input: unknown,
  signal: AbortSignal,
) => Promise<unknown>

export function budgetedAgent(budget: ArenaBudget, model: ModelBackend, protocol: ArenaProtocol): AgentCall {
  return async (id, phase, system, input, signal) => {
    signal.throwIfAborted()
    const request = { phase, system, input: JSON.stringify(input) }
    const allowance = model.allowance(request)
    if (
      protocol.version >= 2 &&
      (allowance.model_requests > (model.kind === 'live' ? 1 : 0) ||
        allowance.tokens > (model.kind === 'live' ? protocol.learning!.maxTokensPerCall : 0))
    )
      throw new Error(
        `Request exceeds protocol v${protocol.version} per-call allowance; no model call dispatched`,
      )
    const reply = await budget.execute(
      id,
      { request, model: model.identity },
      { agent_calls: 1, ...allowance },
      async () => {
        const value = await model.complete(request, signal)
        if (
          protocol.version === 3 &&
          (!value.usage ||
            !Number.isSafeInteger(value.usage.model_requests) ||
            value.usage.model_requests < 0 ||
            !Number.isSafeInteger(value.usage.tokens) ||
            value.usage.tokens < 0)
        )
          throw new Error('Model response lacks measured usage; allowance remains reserved')
        // Preserve historical failure/accounting semantics for old protocols.
        if (protocol.version < 3 && value.invalid_output) throw new Error(value.invalid_output.detail)
        return { value, actual: value.usage }
      },
    )
    if (reply.invalid_output) {
      if (phase === 'lookahead')
        throw new InvalidAgentOutput(
          reply.invalid_output.reason,
          digest(reply.output),
          reply.invalid_output.detail,
        )
      return { invalid_output: reply.invalid_output.detail }
    }
    try {
      return parseOutput(reply.output)
    } catch (error) {
      // A confirmed malformed learning reply can use the single bounded repair slot.
      // Transport errors and missing usage never reach here and remain unresolved.
      if (protocol.version >= 2 && phase === 'learn')
        return { invalid_output: 'Expected JSON {policy:string}' }
      if (protocol.version >= 2 && phase === 'propose')
        return { invalid_output: 'Expected JSON harness proposal' }
      if (protocol.version === 3 && phase === 'lookahead')
        throw new InvalidAgentOutput('malformed_json', digest(reply.output), 'Expected JSON harness output')
      throw error
    }
  }
}
