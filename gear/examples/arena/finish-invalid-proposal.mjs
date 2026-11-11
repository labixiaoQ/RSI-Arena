// Narrow recovery: replay confirmed C receipts through the fixed invalid-proposal branch,
// then audit the actually retained B/C harnesses. Never replay an external side effect.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { readFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { runArenaExperiment, HttpModel, MoneCraftDocker } from '../../lib/arena.js'
import { frozenEvaluation } from '../../lib/adapters/arena/comparison.js'
import { implementationDigest } from '../../lib/adapters/arena/coordinator.js'
import { bundle, digest, parseOutput } from '../../lib/adapters/arena/contracts.js'
import { readBundle } from '../../lib/adapters/arena/harness.js'
import { publishFile } from '../../lib/adapters/storage/atomic.js'
import { withFileLock } from '../../lib/adapters/storage/file-lock.js'

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    audit: { type: 'boolean', default: false },
    context: { type: 'string', default: 'colima-gear-arena' },
    apparmor: { type: 'string', default: 'gear-arena-bwrap' },
  },
})
if (!values.root)
  throw new Error(
    'Provide --root ORIGINAL_COMPARISON; --audit continues the already authorized final evaluations',
  )
const root = resolve(values.root),
  recovery = join(root, 'invalid-proposal-recovery')
const read = async (path) => JSON.parse(await readFile(path, 'utf8'))
const dimensions = ['agent_calls', 'model_requests', 'tokens', 'episodes', 'matches']
const zero = () => Object.fromEntries(dimensions.map((key) => [key, 0]))
function ledger(path) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db
      .prepare('SELECT * FROM operations ORDER BY rowid')
      .all()
      .map((row) => ({
        ...row,
        reserved: JSON.parse(row.reserved),
        actual: row.actual === null ? null : JSON.parse(row.actual),
        result: row.result === null ? null : JSON.parse(row.result),
      }))
  } finally {
    db.close()
  }
}
function sum(rows) {
  const total = zero()
  for (const row of rows) {
    assert.equal(row.state, 'complete', 'Unconfirmed work cannot enter this recovery')
    assert.ok(row.actual)
    for (const key of dimensions) total[key] += row.actual[key]
  }
  return total
}

await withFileLock(join(root, 'comparison.owner'), async () => {
  const planBytes = await readFile(join(root, 'plan.json')),
    plan = JSON.parse(planBytes)
  const authorization = await read(join(root, 'authorization.json'))
  assert.equal(createHash('sha256').update(planBytes).digest('hex'), authorization.plan_sha256)
  const comparison = await read(join(root, 'comparison.json'))
  const originalFailure = await read(join(root, 'report.json'))
  assert.equal(originalFailure.status, 'needs_recovery')
  assert.match(originalFailure.error, /Protocol v2 instructions must fit in 2048 UTF-8 bytes each/u)
  assert.equal(plan.plan.epochs, 1)
  const b = await read(join(root, 'B/search/report.json')),
    c = await read(join(root, 'C/search/report.json'))
  assert.equal(b.status, 'completed')
  assert.equal(b.epochs.length, 1)
  assert.equal(c.status, 'needs_recovery')
  assert.equal(c.epochs.length, 0)
  const cManifest = await read(join(root, 'C/search/experiment.json'))
  const bRows = ledger(join(root, 'B/search/budget.sqlite')),
    cRows = ledger(join(root, 'C/search/budget.sqlite'))
  const charged = sum([...bRows, ...cRows])
  assert.deepEqual(charged, originalFailure.budget.observed)
  const proposals = cRows.filter((row) => row.id.endsWith('/propose'))
  assert.equal(proposals.length, 1)
  assert.equal(cRows.at(-1).id, proposals[0].id)
  const proposed = bundle(parseOutput(proposals[0].result.output))
  const sizes = [proposed.executor, proposed.improver].map((entry) => Buffer.byteLength(entry.instruction))
  assert.ok(sizes.some((size) => size > 2048))
  assert.equal(c.budget.observed.episodes, 1)
  const api = new HttpModel(plan.endpoint, plan.model, 'DEEPSEEK_API_KEY', 4096)
  assert.equal(api.identity, comparison.model)
  const originalBackend = comparison.matches
  const groups = {
    model: cRows.filter((row) => row.reserved.agent_calls === 1),
    compile: cRows.filter((row) => row.id.split('/').at(-1).startsWith('compile-')),
    game: cRows.filter((row) => row.reserved.matches === 1),
  }
  assert.equal(groups.model.length, 4)
  assert.equal(groups.game.length, 6)
  const replayRoot = join(recovery, 'reconstructed-C')
  const cursors = { model: 0, compile: 0, game: 0 }
  try {
    for (const row of ledger(join(replayRoot, 'budget.sqlite'))) {
      if (row.state !== 'complete') continue
      if (row.reserved.agent_calls === 1) cursors.model++
      else if (row.reserved.matches === 1) cursors.game++
      else if (row.id.split('/').at(-1).startsWith('compile-')) cursors.compile++
    }
  } catch (error) {
    if (!String(error).includes('unable to open database file')) throw error
  }
  const take = (kind, request) => {
    const row = groups[kind][cursors[kind]++]
    assert.ok(row, `No additional ${kind} operation is permitted during reconstruction`)
    const originalRequest =
      kind === 'model'
        ? { request, model: api.identity }
        : kind === 'game'
          ? { match: { ...request, id: row.id }, backend: originalBackend }
          : { request: { ...request, id: row.id }, backend: originalBackend }
    assert.equal(
      digest({ request: originalRequest, reserved: row.reserved }),
      row.request,
      'Replay input mismatch',
    )
    return row
  }
  const model = {
    kind: 'fixture',
    identity: digest(['confirmed-live-response-reconstruction', groups.model]),
    allowance() {
      return { model_requests: 0, tokens: 0 }
    },
    async complete(request) {
      const row = take('model', request)
      return { output: row.result.output, usage: { model_requests: 0, tokens: 0 }, replayed_from: row.id }
    },
  }
  const matches = {
    kind: 'fixture',
    identity: digest(['confirmed-real-game-reconstruction', groups.compile, groups.game]),
    async compile(request) {
      return take('compile', request).result
    },
    async play(request) {
      return take('game', request).result
    },
  }
  await mkdir(recovery, { recursive: true })
  await publishFile(
    join(recovery, 'manifest.json'),
    JSON.stringify({
      original_identity: comparison.identity,
      original_failure: digest(originalFailure),
      source_ledger_digest: digest(cRows),
      instruction_bytes: sizes,
      implementation: await implementationDigest(),
      amendment:
        'Invalid proposal is recorded as failed, never truncated/repaired/resubmitted; parent retained. Confirmed C inputs/results are replayed locally to exercise Gear stop/export. No model or game side effects are replayed.',
    }),
    { immutable: true },
  )
  const reconstructed = await runArenaExperiment({
    root: replayRoot,
    initial: cManifest.initial,
    protocol: cManifest.protocol,
    limits: { ...plan.plan.per_arm, model_requests: 0, tokens: 0 },
    epochs: 1,
    durationMs: 3600000,
    model,
    matches,
  })
  assert.equal(reconstructed.status, 'completed')
  assert.deepEqual(
    cursors,
    Object.fromEntries(Object.entries(groups).map(([key, rows]) => [key, rows.length])),
  )
  const cTarget = await readBundle(reconstructed.epochs[0].exported_target)
  const bTarget = await readBundle(b.epochs[0].exported_target)
  assert.equal(digest(cTarget), digest(cManifest.initial))
  const frozen = [
    { label: 'B', target: bTarget, provenance: 'original Gear export', search: b },
    {
      label: 'C',
      target: cTarget,
      provenance: 'Gear export after local confirmed-receipt reconstruction of invalid proposal',
      search: reconstructed,
    },
  ]
  await publishFile(
    join(recovery, 'frozen.json'),
    JSON.stringify(
      frozen.map(({ label, target, provenance }) => ({ label, target, digest: digest(target), provenance })),
    ),
    { immutable: true },
  )
  const remainingAudit = plan.plan.per_audit
  for (const key of dimensions) assert.ok(charged[key] + 2 * remainingAudit[key] <= plan.plan.total[key])
  await publishFile(
    join(recovery, 'reconstruction.json'),
    JSON.stringify(
      {
        status: 'passed',
        replayed: cursors,
        new_physical_model_requests: 0,
        new_physical_matches: 0,
        original_charged: charged,
        reconstruction_budget_is_logical_only: true,
        retained_C: digest(cTarget),
        gate: reconstructed.epochs[0].gate,
      },
      null,
      2,
    ),
    { immutable: true },
  )
  if (!values.audit) {
    console.log('Confirmed-receipt reconstruction passed; no model or game calls.')
    return
  }
  assert.ok(process.env.DEEPSEEK_API_KEY, 'Configured credential is absent')
  const liveMatches = await MoneCraftDocker.create(
    plan.image,
    join(root, 'jobs'),
    values.context,
    values.apparmor,
  )
  assert.equal(liveMatches.identity, originalBackend)
  const audits = []
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort(new Error('User interruption')))
  for (const arm of frozen) {
    audits.push({
      label: arm.label,
      frozen_harness: digest(arm.target),
      result: await frozenEvaluation({
        root: join(root, arm.label, 'audit'),
        target: arm.target,
        protocol: { ...comparison.protocol, mode: arm.label === 'B' ? 'fixed-improver' : 'recursive' },
        seeds: plan.plan.audit_seeds,
        limits: remainingAudit,
        model: api,
        matches: liveMatches,
        durationMs: 3600000,
        signal: controller.signal,
      }),
    })
  }
  const total = { ...charged }
  for (const audit of audits) for (const key of dimensions) total[key] += audit.result.budget.charged[key]
  for (const key of dimensions) assert.ok(total[key] <= plan.plan.total[key])
  const report = {
    status: 'completed_with_invalid_proposal',
    original_identity: comparison.identity,
    recovery_manifest: digest(await read(join(recovery, 'manifest.json'))),
    plan: plan.plan,
    original_search_failure: originalFailure.error,
    amendment:
      'Invalid C proposal retained the sealed parent; all prior consumption retained; no replacement proposal or candidate evaluation.',
    arms: frozen.map(({ label, target, provenance, search }) => ({
      label,
      frozen_harness: digest(target),
      provenance,
      gate: search.epochs[0].gate,
    })),
    audits,
    same_retained_harness: digest(bTarget) === digest(cTarget),
    paired_C_minus_B: audits[1].result.mean_score - audits[0].result.mean_score,
    general_rsi_superiority: 'not_established',
    interpretation:
      'Failure-aware exploratory pilot. If retained harnesses are identical, score differences measure repeat variability, not an improvement caused by I.',
    budget: {
      charged: total,
      observed: total,
      unknown: audits.flatMap((entry) => entry.result.budget.unknown),
    },
    prior_trial_charged: plan.prior_charged,
    reconstruction_physical_cost: { model_requests: 0, matches: 0 },
  }
  await publishFile(join(recovery, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
})
