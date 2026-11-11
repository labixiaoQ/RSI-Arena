import { readFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { comparisonPlan, runArenaComparison, HttpModel, MoneCraftDocker } from '../../lib/arena.js'
import { publishFile } from '../../lib/adapters/storage/atomic.js'
import { digest } from '../../lib/adapters/arena/contracts.js'

const { values } = parseArgs({
  options: {
    run: { type: 'boolean', default: false },
    output: { type: 'string' },
    'game-root': { type: 'string' },
    epochs: { type: 'string', default: '1' },
    context: { type: 'string', default: 'colima-gear-arena' },
    image: { type: 'string', default: 'gear-arena-monecraft:feedback-v2' },
    apparmor: { type: 'string', default: 'gear-arena-bwrap' },
    model: { type: 'string', default: 'deepseek-flash' },
    endpoint: { type: 'string', default: 'https://api.deepseek.com/chat/completions' },
    'key-env': { type: 'string', default: 'DEEPSEEK_API_KEY' },
  },
})
if (!values.output || !values['game-root'])
  throw new Error(
    'Provide --game-root PATH --output DIRECTORY; default is plan-only. --run executes paid calls.',
  )
const own = fileURLToPath(new URL('./', import.meta.url)),
  root = resolve(values.output),
  game = resolve(values['game-root'])
const stop = await readFile(join(own, 'policies/stop.cpp'), 'utf8')
const protocol = {
  version: 2,
  mode: 'recursive',
  lookaheadDepth: 1,
  initialPolicy: stop,
  sdk: await readFile(join(game, 'backend/logic/src/include/sdk.h'), 'utf8'),
  opponents: [stop, await readFile(join(game, 'public_sdk/ai.cpp'), 'utf8')],
  rounds: 1000,
  tasks: [
    { id: 'dev-7', family: 'dev', split: 'seed', seed: 7 },
    { id: 'gate-23', family: 'gate', split: 'held_out', seed: 23 },
  ],
  learning: {
    rules: await readFile(join(own, 'monecraft-contract.txt'), 'utf8'),
    trainingSeeds: [1],
    trainingOpponents: [stop],
    maxPolicyCalls: 3,
    maxTokensPerCall: 32768,
  },
}
const initial = {
  executor: {
    version: 1,
    instruction:
      'Improve the supplied C++14 MoneCraft policy using the authoritative game contract and SDK. At generate, make a short correct capture strategy. At repair, fix the reported compilation or output error. At revise, use the supplied training behavior and outcome feedback to fix the most consequential failure. Return JSON {policy:string} with full source under 12288 UTF-8 bytes. Initialize all Action fields. Do not access hidden state, files, processes or external tools.',
  },
  improver: {
    version: 1,
    instruction:
      'Improve reusable MoneCraft learning instructions. At propose, use only supplied candidate-attributed development feedback and memory; improve executor instructions and, only in recursive mode, improver instructions. In fixed-improver mode copy improver unchanged. At lookahead, improve executor once. Return exactly {executor:{version:1,instruction:string},improver:{version:1,instruction:string}}, each instruction under 2048 UTF-8 bytes. Diagnose failure modes from the verified rules and own behavior. Preserve the bounded generate/compile/train/revise workflow. Do not output policy source, invent outcomes, or change the evaluation, partitions or budgets.',
  },
}
const epochs = Number(values.epochs),
  auditSeeds = [31, 47]
const plan = comparisonPlan(protocol, 'live', epochs, auditSeeds)
const model = new HttpModel(values.endpoint, values.model, values['key-env'], 4096)
const proposal = {
  version: 2,
  model: values.model,
  endpoint: values.endpoint,
  model_identity: model.identity,
  protocol_digest: digest(protocol),
  initial_digest: digest(initial),
  image: values.image,
  plan,
  prior_authorization: { model_requests: 20, tokens: 150000, matches: 40 },
  prior_charged: { model_requests: 17, tokens: 27393, matches: 27 },
  authorization_scope:
    'The plan.total is a separate proposed new authorization, not a reset or reuse of prior limits.',
  outbound_data: [
    'E/I instructions',
    'public SDK and verified rules',
    'initial and generated policies',
    'own training summaries and compiler diagnostics',
    'candidate-attributed seed feedback',
  ],
  withheld: [
    'model credential body',
    'workspace files outside explicit inputs',
    'opponent source',
    'raw replays and hidden maps',
    'gate/audit feedback from later proposals',
  ],
}
await mkdir(root, { recursive: true })
await publishFile(join(root, 'plan.json'), JSON.stringify(proposal, null, 2), { immutable: true })
if (!values.run) {
  console.log(JSON.stringify({ mode: 'plan-only', plan: join(root, 'plan.json'), ...plan }, null, 2))
} else {
  if (!process.env[values['key-env']]) throw new Error('Configured model credential is absent')
  const matches = await MoneCraftDocker.create(
    values.image,
    join(root, 'jobs'),
    values.context,
    values.apparmor,
  )
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort(new Error('User interruption')))
  const report = await runArenaComparison({
    root,
    initial,
    protocol,
    epochs,
    auditSeeds,
    limitsPerArm: plan.per_arm,
    limitsPerAudit: plan.per_audit,
    durationMs: 3600000,
    model,
    matches,
    signal: controller.signal,
  })
  console.log(JSON.stringify(report, null, 2))
}
