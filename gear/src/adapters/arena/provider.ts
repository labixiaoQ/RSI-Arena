import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Json } from '../../domain/algorithm-wire.js'
import type { OperationProvider, OperationReceipt, OperationRequest } from '../../ports/operations.js'
import { publishFile } from '../storage/atomic.js'
import type { ArenaBudget } from './budget.js'
import {
  boundedBundle,
  digest,
  gameContract,
  type ArenaProtocol,
  type HarnessBundle,
  type ModelBackend,
  type MatchBackend,
} from './contracts.js'
import { readBundle, writeBundle } from './harness.js'
import { budgetedAgent, type AgentCall } from './agent.js'
import { evaluateEpisode, feedback } from './episode.js'

interface Context {
  runRoot: string
  active: HarnessBundle
  protocol: ArenaProtocol
  memory: unknown
  implementation: string
}
export class ArenaProvider implements OperationProvider {
  readonly identity: string
  readonly evaluationIdentity: string
  private readonly agent: AgentCall
  readonly capabilities = {
    seeds: true,
    temperature: false,
    subsets: true,
    idempotentSubmission: true,
    inspect: true,
    cancel: true,
    physicalAttemptAccounting: true,
    hardDollarBudget: false,
    generationBudget: false,
    evidenceProjection: false,
  }
  private readonly running = new Map<string, { abort: AbortController; done: Promise<OperationReceipt> }>()
  constructor(
    private readonly context: Context,
    private readonly budget: ArenaBudget,
    private readonly model: ModelBackend,
    private readonly matches: MatchBackend,
  ) {
    this.agent = budgetedAgent(budget, model, context.protocol)
    if (context.protocol.lookaheadDepth !== 1) throw new Error('Only one-step lookahead is supported')
    this.evaluationIdentity = digest({
      protocol: context.protocol,
      memory: context.memory,
      model: model.identity,
      matches: matches.identity,
      implementation: context.implementation,
    })
    this.identity = digest({
      evaluation: this.evaluationIdentity,
      activeI: context.active.improver,
      memory: context.memory,
      limits: budget.limits,
      deadline: budget.deadline,
    })
  }
  private file(request: OperationRequest, name: string) {
    return join(this.context.runRoot, 'arena-operations', digest(request.operationId).slice(7), name)
  }
  private prefix(request: OperationRequest) {
    return `${request.runId}/${request.operationId}/`
  }
  private async readRecord(request: OperationRequest) {
    const record = JSON.parse(await readFile(this.file(request, 'receipt.json'), 'utf8')) as {
      request: string
      receipt: OperationReceipt
      digest: string
    }
    if (record.request !== digest(request) || record.digest !== digest(record.receipt))
      throw new Error('Arena receipt identity mismatch')
    return record.receipt
  }
  async inspect(request: OperationRequest) {
    try {
      return { state: 'complete' as const, receipt: await this.readRecord(request) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (this.running.has(request.operationId)) return { state: 'running' as const }
    if (this.budget.hasUnknown(this.prefix(request))) return { state: 'unknown' as const }
    try {
      const intent = JSON.parse(await readFile(this.file(request, 'intent.json'), 'utf8'))
      if (intent.request !== digest(request)) throw new Error('Operation intent mismatch')
      return { state: 'resumable' as const }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'not_submitted' as const }
      throw error
    }
  }
  async submit(request: OperationRequest, signal: AbortSignal): Promise<OperationReceipt> {
    const existing = await this.inspect(request)
    if (existing.state === 'complete') return existing.receipt
    if (existing.state === 'running') return this.running.get(request.operationId)!.done
    if (existing.state === 'unknown') throw new Error('Unresolved external work cannot be replayed')
    const remaining = this.budget.deadline - Date.now()
    if (remaining <= 0) throw new Error('Experiment deadline exhausted')
    const abort = new AbortController()
    const executionSignal = AbortSignal.any([signal, abort.signal, AbortSignal.timeout(remaining)])
    const done = this.execute(request, executionSignal)
    this.running.set(request.operationId, { abort, done })
    try {
      return await done
    } finally {
      this.running.delete(request.operationId)
    }
  }
  async cancel(request: OperationRequest) {
    const running = this.running.get(request.operationId)
    if (running) {
      running.abort.abort(new Error('Arena operation cancelled'))
      await running.done.catch(() => {})
    }
    if (this.budget.hasUnknown(this.prefix(request)))
      throw new Error('External termination or usage remains unconfirmed')
  }
  private async execute(request: OperationRequest, signal: AbortSignal): Promise<OperationReceipt> {
    await mkdir(join(this.context.runRoot, 'arena-operations', digest(request.operationId).slice(7)), {
      recursive: true,
    })
    await publishFile(this.file(request, 'intent.json'), JSON.stringify({ request: digest(request) }))
    const op = request.operation,
      prefix = this.prefix(request)
    const receipt: OperationReceipt = {
      result: {
        operation_id: request.operationId,
        kind: op.kind,
        status: 'complete',
        candidate_id: op.candidate_id,
        data: null,
      },
      evidence: [],
      candidate: null,
      physicalAttempts: 0,
      usage: {},
      provenance: null,
    }
    if (op.kind === 'generate_candidate') {
      if (request.partition !== 'seed' || !op.parent_id || !op.candidate_id)
        throw new Error('Invalid candidate generation request')
      const parent = await readBundle(join(this.context.runRoot, 'targets', op.parent_id))
      const seedTasks = new Set(
        this.context.protocol.tasks.filter((task) => task.split === 'seed').map((task) => task.id),
      )
      if (request.evidence.some((cell) => !seedTasks.has(cell.task_id)))
        throw new Error('Non-seed evidence cannot enter proposal generation')
      const output = await this.agent(
        prefix + 'propose',
        'propose',
        this.context.active.improver.instruction,
        {
          phase: 'propose',
          harness: parent,
          mode: this.context.protocol.mode,
          ...(this.context.protocol.version >= 2
            ? { game_contract: gameContract(this.context.protocol) }
            : {}),
          feedback: request.evidence.map((cell) => ({
            candidate_id: cell.candidate_id,
            task: cell.task_id,
            score: cell.score,
            feedback: cell.feedback,
          })),
          memory: this.context.memory,
          contract:
            'Return JSON {executor:{version:1,instruction:string},improver:{version:1,instruction:string}}. Improve the reusable workflow. Only recursive mode permits changing improver. Do not change the evaluator or budget. Each instruction must fit in 2048 UTF-8 bytes.',
        },
        signal,
      )
      let generated: HarnessBundle | null = null
      try {
        generated = boundedBundle(output, this.context.protocol)
        if (
          this.context.protocol.mode === 'fixed-improver' &&
          digest(generated.improver) !== digest(parent.improver)
        )
          throw new Error('Fixed-improver mode forbids changing I')
      } catch (error) {
        if (this.context.protocol.version < 2) throw error
        generated = null
        receipt.result.status = 'failed'
        receipt.result.data = {
          reason: 'invalid_harness_proposal',
          detail: String(error),
          output_digest: digest(output),
          produced_by_improver: digest(this.context.active.improver),
        }
      }
      if (generated) {
        const destination = join(this.context.runRoot, 'targets', op.candidate_id)
        try {
          await writeBundle(destination, generated)
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
            digest(await readBundle(destination)) !== digest(generated)
          )
            throw error
        }
        receipt.candidate = { id: op.candidate_id, parent_id: op.parent_id, digest: digest(generated) }
        receipt.result.data = {
          produced_by_improver: digest(this.context.active.improver),
          bundle_digest: digest(generated),
        }
      }
    } else if (op.kind === 'evaluate_seed') {
      if (!op.candidate_id) throw new Error('Evaluation requires a candidate')
      const target = await readBundle(join(this.context.runRoot, 'targets', op.candidate_id))
      for (const slot of request.slots) {
        const task = this.context.protocol.tasks.find((entry) => entry.id === slot.taskId)
        if (!task || task.split !== request.partition) throw new Error('Task partition mismatch')
        const episodeId = prefix + `${slot.taskId}/${slot.repetition}/`
        const { probe, policy, learning, games, score, status, failure, execution } = await evaluateEpisode({
          id: episodeId,
          target,
          protocol: this.context.protocol,
          memory: this.context.memory,
          budget: this.budget,
          matches: this.matches,
          agent: this.agent,
          seed: task.seed + slot.repetition,
          signal,
        })
        const trace = {
          version: 1,
          protocol_version: this.context.protocol.version,
          status,
          failure,
          execution,
          lookahead_depth: 1,
          task: task.id,
          partition: request.partition,
          repetition: slot.repetition,
          candidate_digest: digest(target),
          executed_improver: digest(target.improver),
          executed_executor: execution.executor.instruction_digest,
          discarded_probe_improver: probe ? digest(probe.improver) : null,
          policy,
          policy_digest: policy === null ? null : digest(policy),
          model_kind: this.model.kind,
          match_kind: this.matches.kind,
          learning,
          games,
          score,
        }
        const traceDigest = digest(trace)
        await publishFile(
          this.file(request, `${slot.taskId}-${slot.repetition}.json`),
          JSON.stringify(trace),
          { immutable: true },
        )
        const metric = request.metrics?.find((entry) => entry.id === 'match_score')
        receipt.evidence.push({
          candidate_id: op.candidate_id,
          task_id: task.id,
          repetition: slot.repetition,
          score,
          status: 'valid',
          scope: op.scope,
          feedback:
            this.context.protocol.version >= 2
              ? JSON.stringify({
                  candidate_id: op.candidate_id,
                  candidate_digest: digest(target),
                  task: task.id,
                  score,
                  ...(this.context.protocol.version === 3 ? { status, failure } : {}),
                  games: games.map(feedback),
                })
              : `One-step evaluation: average paired game score ${score}.`,
          ...(metric
            ? {
                raw_metrics: {
                  match_score: {
                    contractDigest: metric.digest,
                    unit: metric.unit,
                    status: 'available' as const,
                    value: score,
                    evidenceRefs: [traceDigest],
                  },
                },
              }
            : {}),
        })
        receipt.physicalAttempts++
      }
    } else throw new Error(`Unsupported Arena operation: ${op.kind}`)
    const usage = this.budget.summary(prefix)
    receipt.usage = { model_requests: usage.observed.model_requests, tokens: usage.observed.tokens }
    receipt.provenance = {
      provider: this.identity,
      protocol: digest(this.context.protocol),
      active_improver: digest(this.context.active.improver),
      model_kind: this.model.kind,
      match_kind: this.matches.kind,
      accounted: usage.observed,
    } as unknown as Json
    await publishFile(
      this.file(request, 'receipt.json'),
      JSON.stringify({ request: digest(request), receipt, digest: digest(receipt) }),
      { immutable: true },
    )
    return receipt
  }
}
