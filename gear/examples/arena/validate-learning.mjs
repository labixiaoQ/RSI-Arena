// Controlled integration test using the real judge. No model endpoint or credential is used.
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { ArenaBudget, MoneCraftDocker } from '../../lib/arena.js'
import { budgetedAgent } from '../../lib/adapters/arena/agent.js'
import { evaluateEpisode } from '../../lib/adapters/arena/episode.js'
import { digest } from '../../lib/adapters/arena/contracts.js'
import { implementationDigest } from '../../lib/adapters/arena/coordinator.js'

const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    'game-root': { type: 'string' },
    context: { type: 'string', default: 'colima-gear-arena' },
    image: { type: 'string', default: 'gear-arena-monecraft:feedback-v2' },
    apparmor: { type: 'string', default: 'gear-arena-bwrap' },
  },
})
if (!values.output || !values['game-root']) throw new Error('Provide --output and --game-root')
const own = fileURLToPath(new URL('./', import.meta.url)),
  root = resolve(values.output),
  game = resolve(values['game-root'])
await mkdir(root, { recursive: true })
const stop = await readFile(join(own, 'policies/stop.cpp'), 'utf8'),
  miner = await readFile(join(own, 'policies/miner.cpp'), 'utf8')
const protocol = {
  version: 2,
  mode: 'recursive',
  lookaheadDepth: 1,
  initialPolicy: stop,
  sdk: await readFile(join(game, 'backend/logic/src/include/sdk.h'), 'utf8'),
  opponents: [stop, await readFile(join(game, 'public_sdk/ai.cpp'), 'utf8')],
  rounds: 1000,
  tasks: [
    { id: 'dev', family: 'dev', split: 'seed', seed: 7 },
    { id: 'gate', family: 'gate', split: 'held_out', seed: 23 },
  ],
  learning: {
    rules: await readFile(join(own, 'monecraft-contract.txt'), 'utf8'),
    trainingSeeds: [1],
    trainingOpponents: [stop],
    maxPolicyCalls: 3,
    maxTokensPerCall: 32768,
  },
}
const model = {
  kind: 'fixture',
  identity: digest(['feedback-controlled-v2', stop, miner]),
  calls: [],
  allowance() {
    return { model_requests: 0, tokens: 0 }
  },
  async complete(request) {
    this.calls.push(request)
    const input = JSON.parse(request.input)
    let output
    if (request.phase === 'lookahead')
      output = { ...input.harness, improver: { version: 1, instruction: 'must-never-execute' } }
    else if (input.stage === 'generate') output = { policy: 'deliberate syntax error for bounded repair' }
    else if (input.stage === 'repair') {
      assert.match(input.compiler_diagnostics, /error/u)
      output = { policy: stop }
    } else if (input.stage === 'revise') {
      assert.equal(input.training_feedback.length, 2)
      assert.ok(
        input.training_feedback.every(
          (entry) => entry.own_behavior.unique_positions === 1 && entry.own_behavior.final_mines === 0,
        ),
      )
      output = { policy: miner }
    } else throw new Error('Unexpected recursive call or learning stage')
    return { output: JSON.stringify(output), usage: { model_requests: 0, tokens: 0 } }
  },
}
const matches = await MoneCraftDocker.create(
  values.image,
  join(root, 'jobs'),
  values.context,
  values.apparmor,
)
const deadline = Date.now() + 900000
const budget = new ArenaBudget(
  join(root, 'budget.sqlite'),
  { agent_calls: 4, model_requests: 0, tokens: 0, episodes: 1, matches: 6 },
  deadline,
)
try {
  const options = {
    id: 'controlled-learning/',
    target: {
      executor: { version: 1, instruction: 'fixture-learning' },
      improver: { version: 1, instruction: 'fixture-lookahead' },
    },
    protocol,
    memory: [],
    budget,
    matches,
    agent: budgetedAgent(budget, model, protocol),
    seed: 23,
    signal: AbortSignal.timeout(900000),
  }
  const result = await evaluateEpisode(options)
  assert.equal(model.calls.length, 4)
  assert.ok(result.games.every((entry) => entry.status === 'complete' && entry.details.rounds === 1000))
  assert.ok(result.games.every((entry) => entry.details.own_behavior.unique_positions > 1))
  assert.ok(result.games.some((entry) => entry.details.own_behavior.final_mines > 0))
  const savedCalls = model.calls.length
  matches.compile = async () => {
    throw new Error('Compile replayed')
  }
  matches.play = async () => {
    throw new Error('Game replayed')
  }
  model.complete = async () => {
    throw new Error('Model replayed')
  }
  assert.deepEqual(await evaluateEpisode(options), result)
  assert.equal(model.calls.length, savedCalls)
  const report = {
    status: 'passed',
    evidence_kind: 'controlled-model-real-judge',
    autonomous_rsi_gain: 'not_tested',
    protocol_digest: digest(protocol),
    backend: matches.identity,
    implementation: await implementationDigest(),
    checks: [
      'one-I-call',
      'compile-repair',
      'training-feedback-used',
      'movement-and-capture-after-revision',
      'no-replay-on-resume',
    ],
    result,
    budget: budget.summary(),
  }
  await writeFile(join(root, 'validation.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ status: report.status, score: result.score, budget: report.budget.observed }))
} finally {
  budget.close()
}
