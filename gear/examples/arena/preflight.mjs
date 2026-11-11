import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'
import { MoneCraftDocker } from '../../lib/arena.js'

const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    context: { type: 'string', default: 'colima-gear-arena' },
    image: { type: 'string', default: 'gear-arena-monecraft:dev' },
    apparmor: { type: 'string', default: 'gear-arena-bwrap' },
  },
})
if (!values.output) throw new Error('Required: --output NEW_DIRECTORY')
const root = resolve(values.output)
await mkdir(root, { recursive: true })
const stop = await readFile(new URL('./policies/stop.cpp', import.meta.url), 'utf8')
const backend = await MoneCraftDocker.create(
  values.image,
  join(root, 'matches'),
  values.context,
  values.apparmor,
)
const signal = AbortSignal.timeout(360_000)
const receipts = []
for (const [id, policy] of [
  ['draw', stop],
  ['isolation', '#include "/work/request.json"\n' + stop],
]) {
  const receipt = await backend.play({ id, policy, opponent: stop, seed: 7, seat: 0, rounds: 1000 }, signal)
  if (id === 'draw' && (receipt.status !== 'complete' || receipt.score !== 0.5))
    throw new Error('Stop/stop game must draw')
  if (id === 'isolation' && receipt.status !== 'policy_failed')
    throw new Error('Compiler isolation check failed')
  receipts.push({ id, receipt })
}
await writeFile(
  join(root, 'preflight.json'),
  JSON.stringify({ kind: 'development-environment-preflight', match_invocations: 2, receipts }, null, 2),
  { flag: 'wx' },
)
console.log('Two preflight checks passed: real judge draw; compiler cannot read match request.')
