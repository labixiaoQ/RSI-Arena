import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { publishFile } from '../storage/atomic.js'
import {
  digest,
  type MatchBackend,
  type MatchRequest,
  type MatchReceipt,
  type CompileRequest,
  type CompileReceipt,
} from './contracts.js'

const execute = promisify(execFile)
export class MoneCraftDocker implements MatchBackend {
  readonly kind = 'monecraft' as const
  readonly identity: string
  private constructor(
    private readonly imageId: string,
    private readonly root: string,
    private readonly context: string,
    private readonly apparmorProfile: string,
  ) {
    this.identity = digest({
      runner: 'monecraft-development-container-v2',
      imageId,
      cpus: 1,
      memory: '768m',
      pids: 128,
      timeoutMs: 180_000,
      referenceProfile: false,
      apparmorProfile,
      systempaths: 'unconfined-for-nested-proc',
    })
  }
  static async create(image: string, root: string, context = 'default', apparmorProfile = 'unconfined') {
    const { stdout } = await execute(
      'docker',
      ['--context', context, 'image', 'inspect', '--format', '{{.Id}}', image],
      { timeout: 15_000, maxBuffer: 4096 },
    )
    const id = stdout.trim()
    if (!/^sha256:[a-f0-9]{64}$/u.test(id)) throw new Error('Cannot resolve pinned MoneCraft image')
    await mkdir(root, { recursive: true })
    return new MoneCraftDocker(id, resolve(root), context, apparmorProfile)
  }
  async play(request: MatchRequest, signal: AbortSignal): Promise<MatchReceipt> {
    const receipt = (await this.invoke(request, signal)) as MatchReceipt
    if (!['complete', 'policy_failed'].includes(receipt.status) || ![0, 0.5, 1].includes(receipt.score))
      throw new Error('Invalid MoneCraft receipt')
    return {
      ...receipt,
      replay: receipt.replay ? join(this.root, digest(request.id).slice(7), receipt.replay) : null,
      details: { ...receipt.details, image_id: this.imageId, request_digest: digest(request) },
    }
  }
  async compile(request: CompileRequest, signal: AbortSignal): Promise<CompileReceipt> {
    const receipt = (await this.invoke({ ...request, mode: 'compile' }, signal)) as CompileReceipt
    if (!['ready', 'policy_failed'].includes(receipt.status) || typeof receipt.diagnostics !== 'string')
      throw new Error('Invalid compiler receipt')
    return receipt
  }
  private async invoke(
    request: MatchRequest | (CompileRequest & { mode: 'compile' }),
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted()
    const root = join(this.root, digest(request.id).slice(7))
    await mkdir(root, { recursive: true })
    await chmod(root, 0o777)
    await publishFile(join(root, 'request.json'), JSON.stringify(request), { immutable: true })
    await chmod(join(root, 'request.json'), 0o444)
    const name = `gear-arena-${digest([this.root, request.id]).slice(7, 31)}`
    const args = [
      '--context',
      this.context,
      'run',
      '--rm',
      '--name',
      name,
      '--platform',
      'linux/amd64',
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--security-opt',
      'seccomp=unconfined',
      '--security-opt',
      `apparmor=${this.apparmorProfile}`,
      '--security-opt',
      'systempaths=unconfined',
      '--pids-limit',
      '128',
      '--memory',
      '768m',
      '--cpus',
      '1',
      '--tmpfs',
      '/tmp:rw,nosuid,size=256m',
      '--mount',
      `type=bind,src=${root},dst=/work`,
      this.imageId,
    ]
    try {
      const result = await execute('docker', args, {
        signal,
        timeout: 180_000,
        maxBuffer: 1_048_576,
        // Model credentials never enter the game process or its container.
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      })
      await publishFile(join(root, 'docker.log'), result.stdout + '\n' + result.stderr)
      return JSON.parse(await readFile(join(root, 'receipt.json'), 'utf8')) as unknown
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? ''
      await publishFile(join(root, 'docker-error.log'), stderr)
      throw new Error(`MoneCraft infrastructure failed; inspect ${join(root, 'docker-error.log')}`)
    } finally {
      // Killing the CLI alone does not stop a Docker workload.
      await execute('docker', ['--context', this.context, 'rm', '-f', name], {
        timeout: 15_000,
        maxBuffer: 4096,
      }).catch(async () => {
        const { stdout } = await execute(
          'docker',
          ['--context', this.context, 'ps', '-aq', '--filter', `name=^/${name}$`],
          { timeout: 10_000 },
        )
        if (stdout.trim()) throw new Error('MoneCraft container termination is unconfirmed')
      })
    }
  }
}
