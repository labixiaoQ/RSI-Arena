import { readFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { runArenaExperiment, HttpModel, MoneCraftDocker } from '../../lib/arena.js'
import { FixtureModel } from './fixture-model.mjs'
import { prepareContinuation } from './continuation.mjs'

const { values } = parseArgs({
  options: {
    fixture: { type: 'boolean', default: false },
    'continue-from': { type: 'string' },
    'game-root': { type: 'string' },
    output: { type: 'string' },
    epochs: { type: 'string', default: '3' },
    context: { type: 'string', default: 'colima-gear-arena' },
    image: { type: 'string', default: 'gear-arena-monecraft:dev' },
    apparmor: { type: 'string', default: 'gear-arena-bwrap' },
    model: { type: 'string', default: 'deepseek-flash' },
    endpoint: { type: 'string', default: 'https://api.deepseek.com/chat/completions' },
    'key-env': { type: 'string', default: 'DEEPSEEK_API_KEY' },
    'agent-calls': { type: 'string', default: '30' },
    tokens: { type: 'string', default: '150000' },
    matches: { type: 'string', default: '60' },
    episodes: { type: 'string', default: '20' },
    rounds: { type: 'string', default: '1000' },
    'output-tokens': { type: 'string', default: '4096' },
  },
})
if (!values['game-root'] || !values.output)
  throw new Error('Required: --game-root PATH --output NEW_DIRECTORY')
if (!values.fixture && !process.env[values['key-env']])
  throw new Error('Configured model credential is absent')
const own = fileURLToPath(new URL('./', import.meta.url)),
  game = resolve(values['game-root']),
  root = resolve(values.output)
const stop = await readFile(join(own, 'policies/stop.cpp'), 'utf8')
const miner = await readFile(join(own, 'policies/miner.cpp'), 'utf8')
const reference = await readFile(join(game, 'public_sdk/ai.cpp'), 'utf8')
const sdk = await readFile(join(game, 'backend/logic/src/include/sdk.h'), 'utf8')
await mkdir(root, { recursive: true })
const matches = await MoneCraftDocker.create(
  values.image,
  join(root, 'matches'),
  values.context,
  values.apparmor,
)
const model = values.fixture
  ? new FixtureModel([stop, miner, reference])
  : new HttpModel(values.endpoint, values.model, values['key-env'], Number(values['output-tokens']))
const initial = values.fixture
  ? {
      executor: { version: 1, instruction: 'fixture-stage:0' },
      improver: { version: 1, instruction: 'fixture-stage:0' },
    }
  : {
      executor: {
        version: 1,
        instruction:
          'You improve C++ MoneCraft game policies. Use the supplied SDK and initial code. Return JSON with policy containing complete C++14 source. Initialize all Action fields and use only visible game state. Prefer a short correct strategy.',
      },
      improver: {
        version: 1,
        instruction:
          'You improve a MoneCraft coding workflow and, in recursive mode, your own improvement instructions. Read the supplied phase, harness and allowed feedback. During propose improve reusable executor/improver instructions; during lookahead make one concrete executor improvement. Return JSON with exactly executor and improver, each {version:1,instruction:string}. Never output policy source at these two stages. Do not invent wins or change scoring. Keep each instruction under 1500 characters.',
      },
    }
const controller = new AbortController()
process.once('SIGINT', () => controller.abort(new Error('User interruption')))
const options = {
  root,
  initial,
  model,
  matches,
  epochs: Number(values.epochs),
  durationMs: 3_600_000,
  limits: {
    agent_calls: Number(values['agent-calls']),
    model_requests: values.fixture ? 0 : Number(values['agent-calls']),
    tokens: values.fixture ? 0 : Number(values.tokens),
    episodes: Number(values.episodes),
    matches: Number(values.matches),
  },
  protocol: {
    version: 1,
    mode: 'recursive',
    lookaheadDepth: 1,
    initialPolicy: stop,
    sdk,
    opponents: [stop, reference],
    rounds: Number(values.rounds),
    tasks: [
      { id: 'dev-7', family: 'dev', split: 'seed', seed: 7 },
      { id: 'gate-23', family: 'gate', split: 'held_out', seed: 23 },
    ],
  },
  signal: controller.signal,
}
let continuation
if (values['continue-from']) {
  if (values.fixture) throw new Error('Repair continuation is restricted to live pre-game failures')
  continuation = await prepareContinuation(
    values['continue-from'],
    root,
    model,
    options.limits,
    initial,
    options.protocol,
  )
  options.model = continuation.model
  options.limits = continuation.limits
}
try {
  const report = await runArenaExperiment(options)
  console.log(JSON.stringify(report, null, 2))
} finally {
  if (continuation) await continuation.writeSummary()
}
