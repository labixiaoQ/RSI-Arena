import { InvalidAgentOutput, type AgentCall } from './agent.js'
import type { ArenaBudget } from './budget.js'
import {
  boundedBundle,
  digest,
  gameContract,
  type ArenaProtocol,
  type CompileReceipt,
  type HarnessBundle,
  type MatchBackend,
  type MatchReceipt,
} from './contracts.js'

const policyContract =
  'Return JSON {policy:string}, a complete C++14 MoneCraft policy implementing extern "C" void player_ai(Map&, GameInfo&, RoundInfo&, Action&). No main function. Initialize all Action fields. No files, processes, network, wall-clock randomness or extra dependencies. Source must fit in 12288 UTF-8 bytes.'

/** Only own public behavior summaries may cross into a model request. Never forward a replay or arbitrary details. */
export function feedback(game: MatchReceipt) {
  const raw = game.details.own_behavior as Record<string, unknown> | undefined
  const own: Record<string, number | null> = {}
  for (const key of [
    'moved_turns',
    'unique_positions',
    'longest_stationary_streak',
    'first_capture_round',
    'final_gold',
    'final_mines',
  ]) {
    const value = raw?.[key]
    if (value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0))
      own[key] = value
  }
  return { status: game.status, score: game.score, own_behavior: own }
}

export async function playAccounted(
  budget: ArenaBudget,
  matches: MatchBackend,
  id: string,
  policy: string,
  opponent: string,
  seed: number,
  seat: 0 | 1,
  rounds: number,
  signal: AbortSignal,
) {
  signal.throwIfAborted()
  const match = { id, policy, opponent, seed, seat, rounds }
  const result = await budget.execute(id, { match, backend: matches.identity }, { matches: 1 }, async () => ({
    value: await matches.play(match, signal),
  }))
  if (
    !['complete', 'policy_failed'].includes(result.status) ||
    !Number.isFinite(result.score) ||
    result.score < 0 ||
    result.score > 1
  )
    throw new Error('Invalid game receipt')
  return result
}

export async function learnWithFeedback(options: {
  prefix: string
  executor: string
  protocol: ArenaProtocol
  budget: ArenaBudget
  matches: MatchBackend
  agent: AgentCall
  signal: AbortSignal
}) {
  const { prefix, executor, protocol, budget, matches, agent, signal } = options
  if (protocol.version < 2 || !protocol.learning || !matches.compile)
    throw new Error('Bounded learning requires protocol v2 or v3 and a compiler')
  const learning = protocol.learning
  const steps: Array<{ stage: string; policy_digest: string | null; compile: CompileReceipt }> = []
  let policy = protocol.initialPolicy,
    calls = 0,
    repaired = false
  const compile = async (label: string, source: string) => {
    signal.throwIfAborted()
    const request = { id: prefix + label, policy: source }
    const result = await budget.execute(request.id, { request, backend: matches.identity }, {}, async () => ({
      value: await matches.compile!(request, signal),
    }))
    if (!['ready', 'policy_failed'].includes(result.status) || typeof result.diagnostics !== 'string')
      throw new Error('Invalid compile receipt')
    return { ...result, diagnostics: result.diagnostics.slice(0, 2048) }
  }
  const baseline = await compile('compile-initial', policy)
  if (baseline.status !== 'ready') throw new Error('Pinned initial policy does not compile')
  const attempt = async (
    stage: string,
    extra: Record<string, unknown>,
  ): Promise<{ source: string | null; compile: CompileReceipt }> => {
    if (++calls > learning.maxPolicyCalls) throw new Error('Learning call bound exceeded')
    const output = (await agent(
      prefix + `learn-${calls}`,
      'learn',
      executor,
      {
        phase: 'learn',
        stage,
        ...(stage === 'generate'
          ? { initial_policy: protocol.initialPolicy }
          : stage === 'revise'
            ? { current_policy: policy }
            : {}),
        sdk: protocol.sdk,
        game_contract: gameContract(protocol),
        ...extra,
        contract: policyContract,
      },
      signal,
    )) as { policy?: unknown } | null
    const source =
      typeof output?.policy === 'string' && output.policy.trim() && Buffer.byteLength(output.policy) <= 12_288
        ? output.policy
        : null
    const result: CompileReceipt =
      source === null
        ? {
            status: 'policy_failed',
            diagnostics: 'Expected JSON with nonempty policy source, at most 12288 UTF-8 bytes.',
          }
        : await compile(`compile-${calls}`, source)
    steps.push({ stage, policy_digest: source === null ? null : digest(source), compile: result })
    if (result.status === 'ready') policy = source!
    return { source, compile: result }
  }
  const repair = async (failed: { source: string | null; compile: CompileReceipt }) => {
    if (failed.compile.status === 'policy_failed' && !repaired && calls < learning.maxPolicyCalls) {
      repaired = true
      await attempt('repair', {
        failed_policy: failed.source ?? policy,
        compiler_diagnostics: failed.compile.diagnostics,
      })
    }
  }
  await repair(await attempt('generate', {}))
  const trainingPolicy = policy
  const training: Array<{ seed_index: number; opponent_index: number; seat: number; result: MatchReceipt }> =
    []
  for (let seed = 0; seed < learning.trainingSeeds.length; seed++) {
    for (let opponent = 0; opponent < learning.trainingOpponents.length; opponent++) {
      for (const seat of [0, 1] as const) {
        const result = await playAccounted(
          budget,
          matches,
          prefix + `train-${seed}-${opponent}-${seat}`,
          policy,
          learning.trainingOpponents[opponent]!,
          learning.trainingSeeds[seed]!,
          seat,
          protocol.rounds,
          signal,
        )
        training.push({ seed_index: seed, opponent_index: opponent, seat, result })
      }
    }
  }
  await repair(
    await attempt('revise', {
      training_feedback: training.map(({ seed_index, opponent_index, seat, result }) => ({
        seed_index,
        opponent_index,
        seat,
        ...feedback(result),
      })),
    }),
  )
  return {
    policy,
    trace: {
      calls,
      repaired,
      fallback: policy === protocol.initialPolicy,
      training_policy_digest: digest(trainingPolicy),
      steps,
      training,
    },
  }
}

export interface EpisodeFailure {
  kind: 'invalid_lookahead'
  reason: 'malformed_json' | 'truncated' | 'invalid_harness'
  detail: string
  output_digest: string
}

/** Evaluate one frozen H. The temporary child I is recorded, never executed or inherited. */
export async function evaluateEpisode(options: {
  id: string
  target: HarnessBundle
  protocol: ArenaProtocol
  memory: unknown
  budget: ArenaBudget
  matches: MatchBackend
  agent: AgentCall
  seed: number
  signal: AbortSignal
}) {
  const { id, target, protocol, memory, budget, matches, agent, seed, signal } = options
  await budget.execute(id + 'admit', { seed, target: digest(target) }, { episodes: 1 }, async () => ({
    value: true,
  }))
  const failureResult = (failure: EpisodeFailure) => ({
    status: 'task_failed' as const,
    failure,
    execution: {
      improver: { status: 'executed' as const, instruction_digest: digest(target.improver) },
      executor: { status: 'not_executed' as const, instruction_digest: null },
    },
    probe: null,
    policy: null,
    learning: null,
    games: [] as MatchReceipt[],
    score: 0,
  })
  let output: unknown
  try {
    output = await agent(
      id + 'lookahead',
      'lookahead',
      target.improver.instruction,
      {
        phase: 'lookahead',
        harness: target,
        memory,
        ...(protocol.version >= 2 ? { game_contract: gameContract(protocol) } : {}),
        contract:
          'Make exactly one improvement to the executor. Return the full JSON harness. Each instruction must fit in 2048 UTF-8 bytes. This is a fresh evaluation copy; no evaluator or scheduling tools are available.',
      },
      signal,
    )
  } catch (error) {
    // Never classify transport, budget, cancellation or unknown usage as a zero-score task.
    if (protocol.version !== 3 || !(error instanceof InvalidAgentOutput)) throw error
    return failureResult({
      kind: 'invalid_lookahead',
      reason: error.reason,
      detail: error.message,
      output_digest: error.outputDigest,
    })
  }
  let probe: HarnessBundle
  try {
    probe = boundedBundle(output, protocol)
  } catch (error) {
    if (protocol.version !== 3) throw error
    return failureResult({
      kind: 'invalid_lookahead',
      reason: 'invalid_harness',
      detail: String(error),
      output_digest: digest(output),
    })
  }
  let policy: string,
    learningTrace: unknown = null
  if (protocol.version >= 2) {
    const learned = await learnWithFeedback({
      prefix: id,
      executor: probe.executor.instruction,
      protocol,
      budget,
      matches,
      agent,
      signal,
    })
    policy = learned.policy
    learningTrace = learned.trace
  } else {
    const learned = (await agent(
      id + 'learn',
      'learn',
      probe.executor.instruction,
      {
        phase: 'learn',
        initial_policy: protocol.initialPolicy,
        sdk: protocol.sdk,
        contract: policyContract,
      },
      signal,
    )) as { policy?: unknown }
    if (
      typeof learned.policy !== 'string' ||
      !learned.policy.trim() ||
      Buffer.byteLength(learned.policy) > 131_072
    )
      throw new Error('Learner did not return a bounded C++ policy')
    policy = learned.policy
  }
  const games: MatchReceipt[] = []
  for (let opponent = 0; opponent < protocol.opponents.length; opponent++) {
    for (const seat of [0, 1] as const)
      games.push(
        await playAccounted(
          budget,
          matches,
          id + `match-${opponent}-${seat}`,
          policy,
          protocol.opponents[opponent]!,
          seed,
          seat,
          protocol.rounds,
          signal,
        ),
      )
  }
  if (!games.length) throw new Error('Evaluation requires opponents')
  return {
    status: 'complete' as const,
    failure: null,
    execution: {
      improver: { status: 'executed' as const, instruction_digest: digest(target.improver) },
      executor: { status: 'executed' as const, instruction_digest: digest(probe.executor) },
    },
    probe,
    policy,
    learning: learningTrace,
    games,
    score: games.reduce((sum, game) => sum + game.score, 0) / games.length,
  }
}
