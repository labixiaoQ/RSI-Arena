import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IMAGE = 'sha256:363c67d8186b9a13cb4898f191389ade38d2d534f74dca7e2632659a341cf6f7';
const workspace = fileURLToPath(new URL('../../', import.meta.url));
export function config(env = process.env) {
  const siteUrl = env.ARENA_SITE_URL || 'http://127.0.0.1:3000';
  const url = new URL(siteUrl);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Site URL must be HTTPS, or localhost HTTP');
  const allowedJobId = env.ARENA_JOB_ID || null;
  if (allowedJobId && !/^run-[a-zA-Z0-9_-]{1,96}$/.test(allowedJobId)) throw new Error('Invalid pinned job ID');
  const transport=env.ARENA_HTTP_TRANSPORT||'native';
  if(!['native','windows-proxy'].includes(transport))throw new Error('Unsupported runner transport');
  return {
    transport, allowedJobId,
    siteUrl: url.origin, token: env.ARENA_RUNNER_TOKEN || '', workerId: env.ARENA_WORKER_ID || 'trusted-local-runner',
    root: resolve(env.ARENA_RUNNER_ROOT || resolve(workspace, 'rsi-arena/work/runner')),
    gearRoot: resolve(env.ARENA_GEAR_ROOT || resolve(workspace, 'gear')),
    gameRoot: resolve(env.ARENA_GAME_ROOT || resolve(workspace, 'aaarena/games/monecraft')),
    gearBuild: env.ARENA_GEAR_BUILD ? resolve(env.ARENA_GEAR_BUILD) : null,
    liveEnabled: env.ARENA_ENABLE_LIVE === '1', dockerContext: env.ARENA_DOCKER_CONTEXT || 'default',
    apparmor: env.ARENA_APPARMOR_PROFILE || 'gear-arena-bwrap', image: IMAGE,
    model: 'deepseek-flash', endpoint: 'https://api.deepseek.com/chat/completions', keyEnv: 'DEEPSEEK_API_KEY',
    heartbeatMs: 20_000, pollMs: 10_000, requestTimeoutMs: transport === 'windows-proxy' ? 20_000 : 10_000,
  };
}
