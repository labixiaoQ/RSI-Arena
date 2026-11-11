import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProjectApplication } from '../../application/project-service.js'
import { publishFile } from '../storage/atomic.js'
import { withFileLock } from '../storage/file-lock.js'
import { ArenaBudget, BudgetError, dimensions, type Counts } from './budget.js'
import {
  boundedBundle,
  digest,
  type ArenaProtocol,
  type HarnessBundle,
  type ModelBackend,
  type MatchBackend,
} from './contracts.js'
import { ArenaProvider } from './provider.js'
import { readBundle, writeBundle } from './harness.js'
import { linearDriver } from './linear.js'
import { generationBound } from './planner.js'
import { publicResultMetadata } from './reporting.js'

export interface ExperimentOptions {
  root: string
  initial: HarnessBundle
  protocol: ArenaProtocol
  limits: Counts
  epochs: number
  durationMs: number
  model: ModelBackend
  matches: MatchBackend
  signal?: AbortSignal
}
export interface EpochResult {
  epoch: number
  run_id: string
  active_improver: string
  retained_improver: string
  exported_target: string
  retained_bundle: string
  gate: string
  report: string
  seed_feedback: Array<{ candidate_id: string; task: string; score: number | null; feedback: string }>
}
export async function implementationDigest() {
  const directory = fileURLToPath(new URL('./', import.meta.url))
  const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
  const names = (await readdir(directory)).filter((name) => name.endsWith(extension)).sort()
  return digest(
    await Promise.all(names.map(async (name) => [name, await readFile(join(directory, name), 'utf8')])),
  )
}
export function validateProtocol(protocol: ArenaProtocol) {
  if (
    ![1, 2, 3].includes(protocol.version) ||
    protocol.lookaheadDepth !== 1 ||
    !['fixed-improver', 'recursive'].includes(protocol.mode) ||
    !Number.isSafeInteger(protocol.rounds) ||
    protocol.rounds < 1 ||
    protocol.rounds > 1000 ||
    !protocol.initialPolicy.trim() ||
    !protocol.sdk.trim() ||
    !protocol.opponents.length
  )
    throw new Error('Invalid Arena protocol')
  const ids = new Set<string>(),
    families = new Map<string, string>()
  for (const task of protocol.tasks) {
    if (
      !/^[a-zA-Z0-9_-]+$/u.test(task.id) ||
      ids.has(task.id) ||
      !task.family ||
      !['seed', 'held_out'].includes(task.split) ||
      !Number.isSafeInteger(task.seed) ||
      task.seed < 0
    )
      throw new Error('Invalid or duplicate learning task')
    if (families.has(task.family) && families.get(task.family) !== task.split)
      throw new Error('Task families must not cross development splits')
    ids.add(task.id)
    families.set(task.family, task.split)
  }
  if (
    !protocol.tasks.some((task) => task.split === 'seed') ||
    !protocol.tasks.some((task) => task.split === 'held_out')
  )
    throw new Error('Both seed and development held-out tasks are required')
  if (protocol.version >= 2) {
    const learning = protocol.learning
    if (
      !learning ||
      !learning.rules.trim() ||
      learning.maxPolicyCalls !== 3 ||
      !Number.isSafeInteger(learning.maxTokensPerCall) ||
      learning.maxTokensPerCall < 1 ||
      !learning.trainingSeeds.length ||
      learning.trainingSeeds.length > 2 ||
      !learning.trainingOpponents.length ||
      learning.trainingOpponents.length > 2 ||
      learning.trainingOpponents.some((source) => !source.trim()) ||
      Buffer.byteLength(protocol.initialPolicy) > 12288
    )
      throw new Error('Invalid bounded learning protocol')
    const seeds = [...learning.trainingSeeds, ...protocol.tasks.map((task) => task.seed)]
    if (seeds.some((seed) => !Number.isSafeInteger(seed) || seed < 0) || new Set(seeds).size !== seeds.length)
      throw new Error('Training, seed and held-out seeds must be disjoint and unique')
  }
}

export async function runArenaExperiment(options: ExperimentOptions) {
  validateProtocol(options.protocol)
  if (options.matches.kind === 'monecraft' && options.protocol.rounds !== 1000)
    throw new Error('Upstream MoneCraft fight mode requires exactly 1000 rounds')
  boundedBundle(options.initial, options.protocol)
  if (options.protocol.version >= 2 && !options.matches.compile)
    throw new Error(`Protocol v${options.protocol.version} requires a compiler backend`)
  if (
    !Number.isSafeInteger(options.epochs) ||
    options.epochs < 1 ||
    options.epochs > 100 ||
    !Number.isSafeInteger(options.durationMs) ||
    options.durationMs < 1 ||
    options.durationMs > 86_400_000
  )
    throw new Error('Invalid epoch or wall-clock limit')
  await mkdir(options.root, { recursive: true })
  return withFileLock(join(options.root, 'experiment.owner'), async () => {
    const implementation = await implementationDigest()
    const identity = digest({
      protocol: options.protocol,
      initial: options.initial,
      limits: options.limits,
      epochs: options.epochs,
      durationMs: options.durationMs,
      model: options.model.identity,
      matches: options.matches.identity,
      implementation,
    })
    const manifestPath = join(options.root, 'experiment.json')
    let manifest: { identity: string; deadline: number }
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      if (manifest.identity !== identity)
        throw new Error('Experiment inputs changed; use a new output directory')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      manifest = { identity, deadline: Date.now() + options.durationMs }
      await publishFile(
        manifestPath,
        JSON.stringify({
          ...manifest,
          version: 1,
          protocol: options.protocol,
          initial: options.initial,
          limits: options.limits,
          epochs: options.epochs,
          model_kind: options.model.kind,
          match_kind: options.matches.kind,
          implementation,
        }),
        { immutable: true },
      )
    }
    const budget = new ArenaBudget(join(options.root, 'budget.sqlite'), options.limits, manifest.deadline)
    const results: EpochResult[] = []
    let active = structuredClone(options.initial)
    let stopReason: string | null = null
    try {
      for (let epoch = 0; epoch < options.epochs; epoch++) {
        options.signal?.throwIfAborted()
        const root = join(options.root, 'epochs', String(epoch).padStart(3, '0'))
        const completion = join(root, 'epoch.json')
        try {
          const prior = JSON.parse(await readFile(completion, 'utf8')) as EpochResult
          if (prior.active_improver !== digest(active.improver)) throw new Error('Epoch inheritance mismatch')
          const retained = await readBundle(prior.exported_target)
          if (
            digest(retained) !== prior.retained_bundle ||
            digest(retained.improver) !== prior.retained_improver
          )
            throw new Error('Exported epoch was modified')
          results.push(prior)
          active = retained
          continue
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        const runId = `run_${digest([identity, epoch]).slice(7, 39)}`
        if (options.protocol.version >= 2) {
          const bound = generationBound(options.protocol, options.model.kind)
          const already = budget.summary(`${runId}/`).charged
          const remaining = { ...bound }
          for (const key of dimensions) remaining[key] = Math.max(0, bound[key] - already[key])
          try {
            budget.ensureAvailable(remaining)
          } catch (error) {
            if (!(error instanceof BudgetError)) throw error
            stopReason = error.message
            break
          }
          await mkdir(root, { recursive: true })
          await publishFile(join(root, 'admission.json'), JSON.stringify({ bound, run_id: runId }), {
            immutable: true,
          })
        }
        await mkdir(root, { recursive: true })
        try {
          await writeBundle(join(root, 'target'), active)
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
            digest(await readBundle(join(root, 'target'))) !== digest(active)
          )
            throw error
        }
        const memory = results.flatMap((result) => result.seed_feedback).slice(-8)
        await publishFile(
          join(root, 'start.json'),
          JSON.stringify({
            parent: epoch ? results[epoch - 1]!.run_id : null,
            active: digest(active),
            active_improver: digest(active.improver),
            memory,
          }),
          { immutable: true },
        )
        await publishFile(
          join(root, 'tasks.jsonl'),
          options.protocol.tasks
            .map((task) =>
              JSON.stringify({
                id: task.id,
                family: task.family,
                split: task.split,
                instruction: `MoneCraft bounded learning task ${task.id}; evaluated by the Arena match provider.`,
                expected: 'provider-scored',
              }),
            )
            .join('\n') + '\n',
          { immutable: true },
        )
        await publishFile(
          join(root, 'benchmark.yaml'),
          JSON.stringify({ version: 1, source: 'tasks.jsonl', template: 'text' }),
          { immutable: true },
        )
        await publishFile(
          join(root, 'gear.yaml'),
          JSON.stringify({
            version: 1,
            benchmark: 'benchmark.yaml',
            target: { adapter: 'arena', path: './target', profile: 'arena-target' },
            meta: { profile: 'arena-meta' },
            algorithm: { name: 'arena-linear-v1', options: {} },
            validation: { mode: 'holdout' },
            budget: {
              rounds: 1,
              max_candidates: 1,
              max_evaluations: 2 * options.protocol.tasks.length,
              repetitions: 1,
            },
            evaluation: { repair: { max_retries: 0, max_projections: 0, backoff_ms: [0] } },
            metrics: [
              {
                id: 'match_score',
                revision: options.protocol.version === 3 ? '3' : '1',
                unit: 'ratio',
                direction: 'maximize',
                source: { path: 'originalResult.match_score', extractor: 'number-v1' },
                range: { min: 0, max: 1 },
                granularity: 'trial',
                repetitionReducer: 'mean',
                taskReducer: 'weighted-mean',
                comparisonPrecision: 1e-9,
              },
            ],
            objective: { terms: [{ metric: 'match_score', weight: 1 }] },
          }),
          { immutable: true },
        )
        const activeSnapshot = structuredClone(active)
        const app = new ProjectApplication(root, {
          async provider(context) {
            return new ArenaProvider(
              {
                runRoot: join(context.stateRoot, 'runs', context.runId),
                active: activeSnapshot,
                protocol: options.protocol,
                memory,
                implementation,
              },
              budget,
              options.model,
              options.matches,
            )
          },
          async driver() {
            return linearDriver
          },
        })
        await app.admitRefine({ dependencies: [{ arena_implementation: implementation }] }, runId)
        const report = await app.resume(runId, options.signal ?? new AbortController().signal)
        const journal = await app.store.read(runId)
        const exported = await app.export(runId)
        const retained = await readBundle(join(exported.destination, 'target'))
        const result: EpochResult = {
          epoch,
          run_id: runId,
          active_improver: digest(active.improver),
          retained_improver: digest(retained.improver),
          retained_bundle: digest(retained),
          exported_target: join(exported.destination, 'target'),
          gate: journal.gate.status,
          report: join(root, 'report.json'),
          seed_feedback: journal.seedEvidence.map((cell) => ({
            candidate_id: cell.candidate_id,
            task: cell.task_id,
            score: cell.score,
            feedback: cell.feedback,
          })),
        }
        await publishFile(result.report, JSON.stringify(report), { immutable: true })
        await publishFile(completion, JSON.stringify(result), { immutable: true })
        results.push(result)
        active = retained
      }
      const report = {
        version: 1,
        ...publicResultMetadata(options.protocol, options.model.kind, options.matches.kind),
        status: stopReason ? 'budget_exhausted' : 'completed',
        stop_reason: stopReason,
        model_kind: options.model.kind,
        match_kind: options.matches.kind,
        formal_hidden_test: 'not_implemented',
        epochs: results,
        budget: budget.summary(),
        final_harness: digest(active),
      }
      await publishFile(join(options.root, 'report.json'), JSON.stringify(report, null, 2))
      return report
    } catch (error) {
      await publishFile(
        join(options.root, 'report.json'),
        JSON.stringify(
          {
            version: 1,
            ...publicResultMetadata(options.protocol, options.model.kind, options.matches.kind),
            status: 'needs_recovery',
            epochs: results,
            budget: budget.summary(),
            error: String(error),
          },
          null,
          2,
        ),
      )
      throw error
    } finally {
      budget.close()
    }
  })
}
