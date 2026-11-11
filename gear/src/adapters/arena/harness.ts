import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { HarnessAdapter } from '../../ports/harness.js'
import { publishFile } from '../storage/atomic.js'
import { bundle, type HarnessBundle } from './contracts.js'

export async function readBundle(directory: string): Promise<HarnessBundle> {
  return bundle({
    executor: JSON.parse(await readFile(join(directory, 'executor.json'), 'utf8')),
    improver: JSON.parse(await readFile(join(directory, 'improver.json'), 'utf8')),
  })
}
export async function writeBundle(directory: string, value: HarnessBundle): Promise<void> {
  const checked = bundle(value)
  await mkdir(directory, { recursive: true })
  for (const name of ['executor', 'improver'] as const)
    await publishFile(join(directory, `${name}.json`), JSON.stringify(checked[name]) + '\n', {
      immutable: true,
    })
}
export class ArenaHarnessAdapter implements HarnessAdapter {
  readonly mutationPolicy = {
    writableRoots: ['executor.json', 'improver.json'],
    protectedNames: ['.git', 'package.json', 'manifest.json'],
    allowedImports: [],
  }
  describe() {
    return {
      adapterRef: { id: 'arena', version: '1' },
      resources: ['executor', 'improver'],
      guide: 'Edit the two bounded instruction documents. The model, game, evaluator and budget are fixed.',
      runtimeSourceMutation: false,
    }
  }
  async prepare(directory: string) {
    await writeBundle(directory, {
      executor: {
        version: 1,
        instruction: 'Improve the supplied MoneCraft policy. Return JSON with policy containing C++ source.',
      },
      improver: {
        version: 1,
        instruction:
          'Use permitted game feedback to improve the executor and your own instruction. Return a complete JSON harness.',
      },
    })
  }
  async check(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true })
    if (
      entries.length !== 2 ||
      entries.some((entry) => !entry.isFile() || !['executor.json', 'improver.json'].includes(entry.name))
    )
      throw new Error('Arena targets contain exactly executor.json and improver.json')
    await readBundle(directory)
  }
  executionSpec(directory: string) {
    return {
      harnessId: 'arena',
      workingDirectory: directory,
      entrypoint: 'executor.json',
      resourcePaths: [...this.mutationPolicy.writableRoots],
    }
  }
}
