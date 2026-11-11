import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { publishFile } from '../storage/atomic.js'
import { withFileLock } from '../storage/file-lock.js'
import { ArenaBudget, dimensions, zero, type Counts } from './budget.js'
import { budgetedAgent } from './agent.js'
import {
  boundedBundle,
  digest,
  type ArenaProtocol,
  type HarnessBundle,
  type MatchBackend,
  type ModelBackend,
} from './contracts.js'
import {
  implementationDigest,
  runArenaExperiment,
  validateProtocol,
  type ExperimentOptions,
} from './coordinator.js'
import { evaluateEpisode } from './episode.js'
import { readBundle } from './harness.js'
import { episodeBound, generationBound } from './planner.js'
import { publicResultMetadata } from './reporting.js'

function scale(counts: Counts, multiplier: number): Counts {
  return Object.fromEntries(dimensions.map((key) => [key, counts[key] * multiplier])) as Counts
}

export function comparisonPlan(
  protocol: ArenaProtocol,
  kind: ModelBackend['kind'],
  epochs: number,
  auditSeeds: number[],
) {
  validateProtocol(protocol)
  if (protocol.version < 2 || !Number.isSafeInteger(epochs) || epochs < 1 || epochs > 100)
    throw new Error('Comparison requires v2 or v3 and bounded generations')
  const occupied = new Set([...protocol.tasks.map((task) => task.seed), ...protocol.learning!.trainingSeeds])
  if (
    auditSeeds.length < 2 ||
    new Set(auditSeeds).size !== auditSeeds.length ||
    auditSeeds.some((seed) => !Number.isSafeInteger(seed) || seed < 0 || occupied.has(seed))
  )
    throw new Error('At least two unique audit seeds, disjoint from training and development, are required')
  const perGeneration = generationBound(protocol, kind),
    perArm = scale(perGeneration, epochs)
  const perAudit = scale(episodeBound(protocol, kind), auditSeeds.length)
  const total = zero()
  for (const key of dimensions) total[key] = 2 * (perArm[key] + perAudit[key])
  return {
    epochs,
    audit_seeds: auditSeeds,
    per_generation: perGeneration,
    per_arm: perArm,
    per_audit: perAudit,
    total,
    interpretation:
      'A paired pilot compares frozen harnesses; it does not establish statistical significance or general RSI superiority.',
  }
}

export interface FrozenOptions {
  root: string
  target: HarnessBundle
  protocol: ArenaProtocol
  seeds: number[]
  limits: Counts
  model: ModelBackend
  matches: MatchBackend
  durationMs: number
  signal?: AbortSignal
}

interface FrozenEpisodeSummary {
  seed: number
  score: number
  status: 'complete' | 'task_failed'
  failure_reason: string | null
}

interface FrozenEvaluationReport extends ReturnType<typeof publicResultMetadata> {
  identity: string
  status: 'completed'
  mean_score: number
  episodes: FrozenEpisodeSummary[]
  task_failures: number
  budget: ReturnType<ArenaBudget['summary']>
}

export async function frozenEvaluation(options: FrozenOptions) {
  const { root, target, protocol, model, matches, limits } = options
  await mkdir(root, { recursive: true })
  const identity = digest({
    target,
    protocol,
    seeds: options.seeds,
    limits,
    durationMs: options.durationMs,
    model: model.identity,
    matches: matches.identity,
    implementation: await implementationDigest(),
  })
  let manifest: { identity: string; deadline: number }
  try {
    manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
    if (manifest.identity !== identity) throw new Error('Frozen audit inputs changed')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    manifest = { identity, deadline: Date.now() + options.durationMs }
    await publishFile(
      join(root, 'manifest.json'),
      JSON.stringify({ ...manifest, target, protocol, seeds: options.seeds, limits }),
      { immutable: true },
    )
  }
  try {
    const prior = JSON.parse(await readFile(join(root, 'report.json'), 'utf8'))
    if (prior.identity !== identity || prior.status !== 'completed')
      throw new Error('Frozen audit report mismatch')
    return prior as FrozenEvaluationReport
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const budget = new ArenaBudget(join(root, 'budget.sqlite'), limits, manifest.deadline)
  try {
    const full = scale(episodeBound(protocol, model.kind), options.seeds.length),
      already = budget.summary().charged
    const remaining = { ...full }
    for (const key of dimensions) remaining[key] = Math.max(0, full[key] - already[key])
    budget.ensureAvailable(remaining)
    const signal = AbortSignal.any([
      options.signal ?? new AbortController().signal,
      AbortSignal.timeout(Math.max(1, manifest.deadline - Date.now())),
    ])
    const episodes: FrozenEpisodeSummary[] = []
    for (const seed of options.seeds) {
      const result = await evaluateEpisode({
        id: `audit/${digest(root)}/${seed}/`,
        target,
        protocol,
        memory: [],
        budget,
        matches,
        agent: budgetedAgent(budget, model, protocol),
        seed,
        signal,
      })
      await publishFile(join(root, `seed-${seed}.json`), JSON.stringify(result), { immutable: true })
      episodes.push({
        seed,
        score: result.score,
        status: result.status,
        failure_reason: result.failure?.reason ?? null,
      })
    }
    const report: FrozenEvaluationReport = {
      identity,
      status: 'completed',
      ...publicResultMetadata(protocol, model.kind, matches.kind),
      mean_score: episodes.reduce((sum, entry) => sum + entry.score, 0) / episodes.length,
      episodes,
      task_failures: episodes.filter((episode) => episode.status === 'task_failed').length,
      budget: budget.summary(),
    }
    await publishFile(join(root, 'report.json'), JSON.stringify(report, null, 2), { immutable: true })
    return report
  } finally {
    budget.close()
  }
}

export interface ComparisonOptions extends Omit<ExperimentOptions, 'limits'> {
  limitsPerArm: Counts
  limitsPerAudit: Counts
  auditSeeds: number[]
}

async function comparisonBudget(root: string) {
  const aggregate = { charged: zero(), observed: zero(), unknown: [] as string[] }
  for (const arm of ['B', 'C'])
    for (const stage of ['search', 'audit']) {
      const directory = join(root, arm, stage)
      try {
        await stat(join(directory, 'budget.sqlite'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      const manifest = JSON.parse(
        await readFile(join(directory, stage === 'search' ? 'experiment.json' : 'manifest.json'), 'utf8'),
      )
      const ledger = new ArenaBudget(join(directory, 'budget.sqlite'), manifest.limits, manifest.deadline)
      try {
        const summary = ledger.summary()
        for (const key of dimensions) {
          aggregate.charged[key] += summary.charged[key]
          aggregate.observed[key] += summary.observed[key]
        }
        aggregate.unknown.push(...summary.unknown.map((id) => `${arm}/${stage}/${id}`))
      } finally {
        ledger.close()
      }
    }
  return aggregate
}

/** Both search arms finish and freeze before either audit. No audit feedback returns to optimization. */
export async function runArenaComparison(options: ComparisonOptions) {
  const { root, initial, protocol, model, matches } = options
  const plan = comparisonPlan(protocol, model.kind, options.epochs, options.auditSeeds)
  boundedBundle(initial, protocol)
  if (!matches.compile) throw new Error('Comparison requires compiler preflight')
  for (const key of dimensions) {
    if (options.limitsPerArm[key] < plan.per_arm[key] || options.limitsPerAudit[key] < plan.per_audit[key])
      throw new Error(`Comparison ${key} allowance is insufficient for both complete arms and audits`)
  }
  await mkdir(root, { recursive: true })
  return withFileLock(join(root, 'comparison.owner'), async () => {
    const identity = digest({
      protocol,
      initial,
      plan,
      limitsPerArm: options.limitsPerArm,
      limitsPerAudit: options.limitsPerAudit,
      durationMs: options.durationMs,
      model: model.identity,
      matches: matches.identity,
      implementation: await implementationDigest(),
    })
    await publishFile(
      join(root, 'comparison.json'),
      JSON.stringify({
        identity,
        plan,
        protocol,
        initial,
        model: model.identity,
        matches: matches.identity,
        limitsPerArm: options.limitsPerArm,
        limitsPerAudit: options.limitsPerAudit,
        durationMs: options.durationMs,
      }),
      { immutable: true },
    )
    try {
      const arms = []
      for (const [label, mode] of [
        ['B', 'fixed-improver'],
        ['C', 'recursive'],
      ] as const) {
        const armProtocol = { ...protocol, mode }
        const result = await runArenaExperiment({
          ...options,
          root: join(root, label, 'search'),
          protocol: armProtocol,
          limits: options.limitsPerArm,
        })
        if (result.status !== 'completed' || result.epochs.length !== options.epochs)
          throw new Error('Incomplete search arm: no audit or comparison conclusion')
        const target = await readBundle(result.epochs.at(-1)!.exported_target)
        arms.push({ label, target, protocol: armProtocol, search: result })
      }
      await publishFile(
        join(root, 'frozen.json'),
        JSON.stringify(arms.map(({ label, target }) => ({ label, target, digest: digest(target) }))),
        { immutable: true },
      )
      const audits = []
      for (const arm of arms)
        audits.push({
          label: arm.label,
          target: digest(arm.target),
          result: await frozenEvaluation({
            ...options,
            root: join(root, arm.label, 'audit'),
            target: arm.target,
            protocol: arm.protocol,
            seeds: options.auditSeeds,
            limits: options.limitsPerAudit,
          }),
        })
      const report = {
        status: 'completed',
        identity,
        ...publicResultMetadata(protocol, model.kind, matches.kind),
        same_harness: digest(arms[0]!.target) === digest(arms[1]!.target),
        same_improver: digest(arms[0]!.target.improver) === digest(arms[1]!.target.improver),
        difference_attribution:
          digest(arms[0]!.target) === digest(arms[1]!.target)
            ? 'same_harness_difference_cannot_be_attributed_to_evolved_I'
            : 'search_procedure_comparison_not_an_isolated_I_effect',
        plan,
        arms: arms.map(({ label, target, search }) => ({
          label,
          frozen_harness: digest(target),
          epochs: search.epochs,
          budget: search.budget,
        })),
        audits,
        paired_C_minus_B: audits[1]!.result.mean_score - audits[0]!.result.mean_score,
        general_rsi_superiority: 'not_established',
        audit_scope:
          'disjoint fixed seeds, fresh learning, fixed opponent pool; not a formal hidden benchmark',
        budget: await comparisonBudget(root),
      }
      await publishFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
      return report
    } catch (error) {
      await publishFile(
        join(root, 'report.json'),
        JSON.stringify(
          {
            status: 'needs_recovery',
            identity,
            ...publicResultMetadata(protocol, model.kind, matches.kind),
            same_harness: null,
            same_improver: null,
            plan,
            error: String(error),
            budget: await comparisonBudget(root),
            paired_C_minus_B: null,
          },
          null,
          2,
        ),
      )
      throw error
    }
  })
}
