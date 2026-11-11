"""Development runner: unchanged MoneCraft judge, isolated players and bounded jobs.

Uses upstream AI9's explicit unsupervised loader inside a separate Bubblewrap
filesystem/network namespace per player. This replaces ptrace for Rosetta
compatibility, and is NOT the AAArena reference timing/isolation profile.
"""
import json
import os
from pathlib import Path
import resource
import selectors
import shutil
import socket
import subprocess
import sys
import threading

GAME = Path('/opt/monecraft')


def limits():
    resource.setrlimit(resource.RLIMIT_CPU, (40, 40))
    resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024 * 1024, 64 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))


def isolated_command(library):
    return ['bwrap', '--die-with-parent', '--new-session', '--unshare-all',
            '--ro-bind', '/usr', '/usr', '--symlink', 'usr/lib', '/lib',
            '--symlink', 'usr/lib64', '/lib64', '--symlink', 'usr/bin', '/bin',
            '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/workspace',
            '--ro-bind', str(GAME / 'build/ailoader'), '/workspace/ailoader',
            '--ro-bind', str(library), '/workspace/player.so',
            '--ro-bind', '/opt/arena/relay.py', '/workspace/relay.py',
            '--chdir', '/workspace', '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin',
            'python3', '-I', '/workspace/relay.py', 'unsupervised']


class Player:
    def __init__(self, library, log):
        self.listener = socket.socket()
        self.listener.bind(('127.0.0.1', 0))
        self.listener.listen(1)
        self.listener.settimeout(30)
        self.port = self.listener.getsockname()[1]
        self.process = subprocess.Popen(isolated_command(library), stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=log, preexec_fn=limits)
        with selectors.DefaultSelector() as ready:
            ready.register(self.process.stdout, selectors.EVENT_READ)
            if not ready.select(20) or self.process.stdout.readline(32) != b'READY\n':
                self.close()
                raise RuntimeError('Player isolation/loader failed; see player log')
        self.thread = threading.Thread(target=self.bridge, daemon=True)
        self.thread.start()

    def bridge(self):
        try:
            peer, _ = self.listener.accept()
            peer.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            with peer, selectors.DefaultSelector() as selector:
                selector.register(peer, selectors.EVENT_READ)
                selector.register(self.process.stdout, selectors.EVENT_READ)
                while True:
                    for event, _ in selector.select(1):
                        if event.fileobj is peer:
                            data = peer.recv(65536)
                            if not data:
                                return
                            self.process.stdin.write(data)
                            self.process.stdin.flush()
                        else:
                            data = os.read(self.process.stdout.fileno(), 65536)
                            if not data:
                                return
                            peer.sendall(data)
        except (OSError, ValueError):
            return

    def close(self):
        self.listener.close()
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait(timeout=5)


def build(source, directory):
    directory.mkdir()
    (directory / 'ai.cpp').write_text(source)
    # The compiler also cannot read the opposing source, judge, or request file.
    command = ['bwrap', '--die-with-parent', '--new-session', '--unshare-all',
               '--ro-bind', '/usr', '/usr', '--symlink', 'usr/lib', '/lib',
               '--symlink', 'usr/lib64', '/lib64', '--symlink', 'usr/bin', '/bin',
               '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
               '--bind', str(directory), '/workspace',
               '--ro-bind', str(GAME / 'logic/src/include'), '/sdk/include',
               '--ro-bind', str(GAME / 'logic/src/lib_json'), '/sdk/json',
               '--ro-bind', str(GAME / 'platform_shared'), '/sdk/platform',
               '--ro-bind', '/opt/player-sdk', '/sdk/objects',
               '--chdir', '/workspace', '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin',
               'g++-14', '-std=c++14', '-O2', '-fPIC', '-shared', '-D_AI__', '-Wl,--no-undefined',
               '-I/sdk/include', '-I/sdk/platform/include', '/workspace/ai.cpp',
               *['/sdk/objects/' + p.name for p in sorted(Path('/opt/player-sdk').glob('*.o'))],
               '-o', '/workspace/player.so', '-pthread', '-ldl', '-lrt']
    result = subprocess.run(command, capture_output=True, timeout=90, preexec_fn=limits)
    (directory / 'compile.log').write_bytes(result.stderr)
    if any(line.startswith(b'bwrap: ') for line in result.stderr.splitlines()) or result.returncode < 0:
        raise RuntimeError('Compiler isolation failed or compiler terminated by signal')
    return directory / 'player.so' if result.returncode == 0 else None


def own_behavior(document, seat):
    """Allowlisted own-state aggregates only; no hidden terrain or opposing trajectory."""
    initial = next(p for p in document['init-players'] if p['id'] == seat)
    previous = (initial['x'], initial['y'])
    seen = {previous}
    moved = streak = longest = 0
    capture = None
    gold = mines = 0
    for turn in document['rounds-info']:
        player = next(p for p in turn['players'] if p['id'] == seat)
        position = (player['x'], player['y'])
        seen.add(position)
        if position != previous:
            moved += 1
            streak = 0
        else:
            streak += 1
            longest = max(longest, streak)
        previous = position
        info = next(p for p in turn['ginfo'] if p['id'] == seat)
        gold, mines = info['golds'], info['mine-num']
        if capture is None and mines > 0:
            capture = turn['rounds']
    return {'moved_turns': moved, 'unique_positions': len(seen),
            'longest_stationary_streak': longest, 'first_capture_round': capture,
            'final_gold': gold, 'final_mines': mines}


def main():
    root = Path('/work')
    request = json.loads((root / 'request.json').read_text())
    if request.get('mode') == 'compile':
        library = build(request['policy'], root / 'compile')
        diagnostics = (root / 'compile/compile.log').read_text(errors='replace')[:2048]
        return {'status': 'ready' if library else 'policy_failed', 'diagnostics': diagnostics}
    if request['rounds'] != 1000:
        raise ValueError('Upstream MoneCraft fight mode has a fixed 1000-round horizon')
    sources = [request['policy'], request['opponent']]
    if request['seat'] == 1:
        sources.reverse()
    libraries = [build(source, root / f'p{i}') for i, source in enumerate(sources)]
    if libraries[1 - request['seat']] is None:
        raise RuntimeError('Opponent failed to compile')
    if libraries[request['seat']] is None:
        return {'status': 'policy_failed', 'score': 0, 'replay': None,
                'details': {'reason': 'compile_error', 'profile': 'development-container-v1'}}
    (root / 'resources.res').write_text('{"mode":"fight"}')
    shutil.copy2(GAME / 'map.txt', root / 'map.txt')
    (root / 'sampleAi').mkdir()
    shutil.copy2(libraries[0], root / 'sampleAi/ai.so')
    players, logs = [], []
    try:
        for i, library in enumerate(libraries):
            log = (root / f'player-{i}.log').open('wb')
            logs.append(log)
            players.append(Player(library, log))
        command = [str(GAME / 'build/logic')]
        for player in players:
            command += ['--ai', f'127.0.0.1:{player.port}']
        with (root / 'judge.stdout').open('wb') as out, (root / 'judge.stderr').open('wb') as err:
            result = subprocess.run(command, cwd=root, stdout=out, stderr=err, timeout=90,
                                    env={'PATH': '/usr/bin:/bin', 'AA_ARENA_GAME_SEED': str(request['seed'])},
                                    preexec_fn=limits)
        if result.returncode < 0:
            raise RuntimeError('Judge terminated by signal')
        document = json.loads((root / 'result.txt').read_text())
        if len(document.get('init-players', [])) != 2 or len(document.get('init-mines', [])) != 6:
            raise RuntimeError('Pinned fight-mode SDK globals do not match the judge')
        terminal = document.get('result', {})
        winner = terminal.get('winner')
        if type(winner) is not int or winner not in (-1, 0, 1) or terminal.get('type') not in ('normal', 'error'):
            raise RuntimeError('Invalid official terminal result')
        if terminal['type'] == 'error' and winner == -1:
            raise RuntimeError('Unadjudicated game error')
        score = .5 if winner == -1 else float(winner == request['seat'])
        return {'status': 'complete', 'score': score, 'replay': 'result.txt',
                'details': {'terminal': terminal, 'rounds': len(document.get('rounds-info', [])),
                            'own_behavior': own_behavior(document, request['seat']),
                            'profile': 'development-container-v1', 'reference_profile': False}}
    finally:
        for player in players:
            player.close()
        for log in logs:
            log.close()


if __name__ == '__main__':
    try:
        result = main()
        Path('/work/receipt.json').write_text(json.dumps(result))
        print(json.dumps(result))
    except Exception as exc:
        print(json.dumps({'status': 'infrastructure_failed', 'error': str(exc)}), file=sys.stderr)
        sys.exit(1)
