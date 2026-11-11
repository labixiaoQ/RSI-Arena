import { zero, type Counts } from './budget.js'
import type { ArenaProtocol, ModelBackend } from './contracts.js'

export function episodeBound(protocol: ArenaProtocol, kind: ModelBackend['kind']): Counts {
  if (protocol.version < 2 || !protocol.learning)
    throw new Error('Budget planning requires protocol v2 or v3')
  const { learning } = protocol
  const calls = 1 + learning.maxPolicyCalls
  return {
    agent_calls: calls,
    model_requests: kind === 'live' ? calls : 0,
    tokens: kind === 'live' ? calls * learning.maxTokensPerCall : 0,
    episodes: 1,
    matches:
      2 * (learning.trainingSeeds.length * learning.trainingOpponents.length + protocol.opponents.length),
  }
}

/** Anchor + child across all seed and gate tasks, plus one proposal. No optimistic early-exit credit. */
export function generationBound(protocol: ArenaProtocol, kind: ModelBackend['kind']): Counts {
  const each = episodeBound(protocol, kind),
    count = protocol.tasks.length * 2,
    result = zero()
  for (const key of Object.keys(result) as Array<keyof Counts>) result[key] = each[key] * count
  result.agent_calls++
  if (kind === 'live') {
    result.model_requests++
    result.tokens += protocol.learning!.maxTokensPerCall
  }
  return result
}
