#!/usr/bin/env node
// Reproducible source-only overlay. Never runs experiments, installs dependencies, or mutates Gear.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const site = fileURLToPath(new URL('../', import.meta.url));
const workspace = resolve(site, '..');
const gear = join(workspace, 'gear');
const arena = join(workspace, 'aaarena');
const BASE = '11bad082e1163d12caf2f955125d596f40b395f1';
const AAA_BASE = 'fd52d2337b6711f0f3a239216f48720c125750be';
const sha = (data) => createHash('sha256').update(data).digest('hex');
const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const files = new Map();
const sensitive = /(?:\bsk-(?:proj-|ant-)?[a-z0-9_-]{12,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[a-z0-9]{20,}|\bgithub_pat_[a-z0-9_]{20,}|\bBearer\s+[a-z0-9._~+/=-]{8,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/i;
const hostPath = /\/(?:Users|home|private|Volumes)\/|[A-Z]:\\/u;
function checkPublic(path, text) {
  if (sensitive.test(text)) throw new Error(`Credential-shaped material in ${path}; refusing archive`);
  if (hostPath.test(text) || text.includes(workspace)) throw new Error(`Host-specific absolute path in ${path}; refusing archive`);
}
function safePath(path) {
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => !part || part === '..' || part === '.')) throw new Error('Unsafe archive path');
  if (/(^|\/)(?:node_modules|arena-runs|arena-assets|\.git|\.env[^/]*|\.venv|lib)(\/|$)/u.test(path)) throw new Error(`Private/generated payload path: ${path}`);
}
function add(path, bytes, scan = true) {
  safePath(path); if (files.has(path)) throw new Error('Duplicate package path');
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (scan) checkPublic(path, buffer.toString('utf8'));
  files.set(path, buffer);
}
function upstream(root, expectedUrl, commit) {
  if (git(root, ['rev-parse', 'HEAD']).trim() !== commit) throw new Error('Upstream commit changed; review package baseline first');
  const source = git(root, ['remote', 'get-url', 'origin']).trim();
  if (source !== expectedUrl) throw new Error('Unexpected upstream remote; review before publication');
  return { repository: source, commit };
}
const upstreamGear = upstream(gear, 'https://github.com/rsi-gear/gear.git', BASE);
const upstreamArena = upstream(arena, 'https://github.com/THU-CST-SAST/AAArena.git', AAA_BASE);
const modified = git(gear, ['diff', '--no-renames', '--name-only', '-z', BASE]).split('\0').filter(Boolean).sort();
for (const path of modified) {
  safePath(path);
  if (!/^(?:\.gitignore|package(?:-lock)?\.json|tsconfig(?:\.[a-z]+)?\.json|src\/.*\.[a-z]+|scripts\/.*\.[a-z]+)$/u.test(path)) throw new Error(`Unexpected tracked change needs manual review: ${path}`);
}
const patch = git(gear, ['diff', '--no-ext-diff', '--no-renames', '--full-index', BASE, '--', ...modified]);
if (!modified.length || patch.includes('GIT binary patch')) throw new Error('Expected reviewed text integration patch');
add('upgrade.patch', patch);
const tracked = [];
for (const path of modified) {
  try { const bytes = await readFile(join(gear, path)); tracked.push({ path, sha256: sha(bytes), deleted: false }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; tracked.push({ path, sha256: null, deleted: true }); }
}
const untracked = git(gear, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).sort();
const overlay = [];
for (const path of untracked) {
  if (!/^(?:src\/adapters\/arena\/|src\/arena\.ts$|tests\/unit\/arena[^/]*\.spec\.ts$|examples\/arena\/|docs\/arena[^/]*\.md$|docs\/validation\/arena[^/]*\.(?:md|json)$)/u.test(path)) continue;
  safePath(path);
  const info = await lstat(join(gear, path));
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error(`Unexpected overlay file: ${path}`);
  const source = await readFile(join(gear, path));
  let text = source.toString('utf8');
  if (Buffer.compare(Buffer.from(text), source) !== 0) throw new Error(`Non-text overlay source: ${path}`);
  if (path.startsWith('docs/')) {
    text = text.replaceAll(workspace + '/', '');
    text = text.replaceAll('/private/tmp/', 'temporary-directory/');
    if (path.endsWith('.json')) JSON.parse(text);
  }
  const content = Buffer.from(text);
  add(`overlay/${path}`, content);
  overlay.push({ path, source_sha256: sha(source), sha256: sha(content), transformation: content.equals(source) ? null : 'documentation_host_paths_replaced_with_relative_references' });
}
if (!overlay.some((entry) => entry.path === 'src/arena.ts') || !overlay.some((entry) => entry.path === 'tests/unit/arena-v3.spec.ts')) throw new Error('Required Arena source/test is absent');
add('LICENSE', await readFile(join(gear, 'LICENSE')));
add('README.zh-CN.md', await readFile(join(site, 'docs/reproduction.zh-CN.md')));

const verifier = `import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
export const bundleRoot = fileURLToPath(new URL('./', import.meta.url));
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function verify() {
  const manifest = JSON.parse(await readFile(join(bundleRoot, 'manifest.json'), 'utf8'));
  for (const entry of manifest.files) {
    if (!entry.path || entry.path.startsWith('/') || entry.path.includes('\\\\') || entry.path.split('/').some(part => part === '..' || part === '.')) throw new Error('Unsafe manifest path');
    const file = join(bundleRoot, entry.path), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || hash(await readFile(file)) !== entry.sha256) throw new Error('Payload verification failed: ' + entry.path);
  }
  return manifest;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const manifest = await verify();
  console.log(JSON.stringify({verifiedFiles:manifest.files.length, upstream:manifest.upstream.gear}));
}
`;
add('verify.mjs', verifier);
const applier = `import { execFileSync } from 'node:child_process';
import { access, copyFile, lstat, mkdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { verify, bundleRoot, hash } from './verify.mjs';
const manifest = await verify();
if (process.argv.length !== 3) throw new Error('Usage: node apply.mjs NEW_CLEAN_GEAR_CLONE');
const target = resolve(process.argv[2]);
const git = (args) => execFileSync('git', ['-C', target, ...args], {encoding:'utf8'});
if (git(['rev-parse','--show-toplevel']).trim() !== target || git(['rev-parse','HEAD']).trim() !== manifest.upstream.gear.commit || git(['status','--porcelain','--untracked-files=all']).trim()) throw new Error('Target must be a clean clone at the exact upstream commit');
for (const entry of manifest.overlay) {
  const destination = join(target, entry.path);
  try { await access(destination); throw new Error('Overlay destination already exists: ' + entry.path); } catch (error) { if(error.code !== 'ENOENT') throw error; }
  let parent = dirname(destination);
  while(parent !== target) { try { if ((await lstat(parent)).isSymbolicLink()) throw new Error('Symlink ancestor refused'); } catch(error) { if(error.code !== 'ENOENT') throw error; } parent = dirname(parent); }
}
const patch = join(bundleRoot, 'upgrade.patch');
git(['apply','--check',patch]);
git(['apply',patch]);
for (const entry of manifest.overlay) { const destination = join(target, entry.path); await mkdir(dirname(destination), {recursive:true}); await copyFile(join(bundleRoot,'overlay',entry.path), destination, constants.COPYFILE_EXCL); }
for (const entry of [...manifest.tracked_changes, ...manifest.overlay]) {
  if(entry.deleted) { try { await access(join(target,entry.path)); throw new Error('Expected deleted file still exists'); } catch(error) { if(error.code !== 'ENOENT') throw error; } }
  else if(hash(await readFile(join(target,entry.path))) !== entry.sha256) throw new Error('Applied source mismatch: ' + entry.path);
}
console.log(JSON.stringify({status:'applied_and_verified',tracked:manifest.tracked_changes.length,overlay:manifest.overlay.length,installsOrExperimentsRun:false}));
`;
add('apply.mjs', applier);
const gameArchive = JSON.parse(await readFile(join(arena, 'assets/manifest.json'), 'utf8')).games.find((game) => game.game === 'monecraft');
const manifest = {
  schema_version: 1, package: 'gear-arena-v3', format: 'upstream-git-patch-plus-overlay',
  upstream: { gear: upstreamGear, aaarena: upstreamArena },
  game: { id: 'monecraft', archive: `assets/${gameArchive.archive}`, sha256: gameArchive.sha256, included: false },
  evidence: { existing_live_evidence: 'v2 exploratory pilot with documented recovery amendment', v3: 'controlled validation only; no new paid-model or real-game claims' },
  exclusions: ['arena-runs/', 'arena-assets/', 'node_modules/', 'lib/', '.venv/', '.git/', 'credentials', 'raw model request/response logs', 'host-specific absolute paths'],
  tracked_changes: tracked, overlay,
  files: [...files.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha(bytes) })),
  manifest_hash_note: 'Payload hashes exclude manifest.json itself. Verify the complete archive hash through its publishing channel.',
};
add('manifest.json', JSON.stringify(manifest, null, 2) + '\n');

function tarHeader(name, size) {
  const header = Buffer.alloc(512);
  const string = (value, offset, length) => { const bytes = Buffer.from(value); if(bytes.length > length) throw new Error('Tar field overflow'); bytes.copy(header, offset); };
  const octal = (value, offset, length) => string(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
  string(name, 0, 100); octal(0o644,100,8); octal(0,108,8); octal(0,116,8); octal(size,124,12); octal(0,136,12);
  header.fill(32,148,156); string('0',156,1); string('ustar\0',257,6); string('00',263,2);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  string(checksum.toString(8).padStart(6,'0') + '\0 ',148,8); return header;
}
const blocks = [];
for (const [path, bytes] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  blocks.push(tarHeader(`gear-arena-v3/${path}`, bytes.length), bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
}
blocks.push(Buffer.alloc(1024));
const archive = gzipSync(Buffer.concat(blocks), { level: 9 });
const output = join(site, 'public/downloads/gear-arena-v3.tar.gz');
await mkdir(dirname(output), { recursive: true }); await writeFile(output, archive);
console.log(JSON.stringify({ output: 'public/downloads/gear-arena-v3.tar.gz', bytes: archive.length, sha256: sha(archive), trackedChanges: tracked.length, overlayFiles: overlay.length, payloadFiles: files.size, sanitizedDocuments: overlay.filter(entry => entry.transformation).map(entry => entry.path), upstream: manifest.upstream }, null, 2));
