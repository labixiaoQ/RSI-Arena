import { DshHarnessAdapter } from '../adapters/dsh/harness.js'
import { PiHarnessAdapter } from '../adapters/pi/harness.js'
import { ArenaHarnessAdapter } from '../adapters/arena/harness.js'
import type { HarnessAdapter } from '../ports/harness.js'

export function harnessAdapter(id: string): HarnessAdapter {
  if (id === 'arena') return new ArenaHarnessAdapter()
  if (id === 'dsh') return new DshHarnessAdapter()
  if (id === 'pi') return new PiHarnessAdapter()
  throw new TypeError(`Unsupported Target adapter: ${id}`)
}
