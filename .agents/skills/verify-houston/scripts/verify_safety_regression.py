#!/usr/bin/env python3
"""Exercise verifier main with a disposable, malicious candidate CLI.

The candidate implements only the offline envelopes needed by these fixtures.
It is not a Houston implementation or evidence of Houston CLI acceptance.
Historical runs execute the exact historical verifier, never copied predicates.
"""
import argparse
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch


SCRIPT = Path(__file__).with_name('verify.py')
# Exact 79b4d74 bin/houston, SHA-256 dcef1aa364320990f2e5ed0d468e24f5b4cfb04fc322e40f9c8640af273ee115.
# The Node adapter models dispatch, not the real TypeScript application.
DISPATCHER = b'#!/bin/sh\n# houston: the TypeScript build\'s entry.\n#\n# One implementation, so this file only finds the build and EXECS it. Never a spawn: the\n# build becomes this process, so its exit code IS the caller\'s, a signal sent to this pid\n# reaches it, and stdin, stdout and stderr (a TTY or not) are the descriptors the caller\n# gave. Node cannot execve; a shell can. The environment below is what the build needs\n# from the process that starts it.\nset -u\n\nself=$0\nwhile [ -h "$self" ]; do\n  link=$(readlink "$self") || break\n  case $link in\n    /*) self=$link ;;\n    *) self=$(dirname -- "$self")/$link ;;\n  esac\ndone\nroot=$(CDPATH=\'\' cd -P -- "$(dirname -- "$self")/.." && pwd -P) || {\n  printf \'houston: cannot find the directory %s is in. Nothing was run.\\n\' "$0" >&2\n  exit 252\n}\n\n# This file\'s own path, absolute and with its symlinks resolved as $root\'s are: the command\n# the owner installed, which `serve --print-service` names as its unit\'s ExecStart (systemd\n# refuses a relative one) rather than the build behind it, so the unit keeps working when\n# the build\'s location changes. Set on every run, so an inherited value never stands in.\nif here=$(CDPATH=\'\' cd -P -- "$(dirname -- "$self")" && pwd -P); then\n  HOUSTON_DISPATCHER=$here/${self##*/}\n  export HOUSTON_DISPATCHER\nelse\n  unset HOUSTON_DISPATCHER\nfi\n\n# The network earlier releases reached, by default: they honoured HTTP_PROXY, HTTPS_PROXY\n# and NO_PROXY, and trusted REQUESTS_CA_BUNDLE or CURL_CA_BUNDLE. Node\'s fetch honours the\n# proxy variables only under NODE_USE_ENV_PROXY, which it reads at startup -- so behind a\n# proxy `versions` fell back to the shipped map where it should have answered from\n# releases.rocket.chat, and doctor called the release endpoint unreachable. A bundle\n# those variables name is added to Node\'s as NODE_EXTRA_CA_CERTS, which is how a\n# TLS-inspecting proxy\'s CA reaches both. Either is left as the caller set it.\nNODE_USE_ENV_PROXY=${NODE_USE_ENV_PROXY-1}\nexport NODE_USE_ENV_PROXY\nif [ -z "${NODE_EXTRA_CA_CERTS-}" ]; then\n  ca=${REQUESTS_CA_BUNDLE:-${CURL_CA_BUNDLE:-}}\n  if [ -n "$ca" ]; then NODE_EXTRA_CA_CERTS=$ca; export NODE_EXTRA_CA_CERTS; fi\nfi\n\n# A CHECKOUT RUNS ITS SOURCE; AN INSTALLED PACKAGE RUNS THE EMITTED BUILD. The source is\n# what was edited, so on a tree that has src/ it is run through tools/cli.js (swc, no build\n# step); an installed tarball ships dist/ and no src/, so there the emitted build is the\n# only build. Preferring dist/ wherever it existed ran STALE code on a checkout: `yarn\n# build` from before a change left dist/ behind, and a fresh home was claimed with the old\n# marker while `--version`, read from package.json, said the new number. Both are the same\n# code: `tsc` emits dist/ from src/ with no bundler, and the tarball is what `yarn build`\n# is for.\nif [ -f "$root/src/cli/entry.ts" ] && [ -f "$root/tools/cli.js" ]; then\n  exec node "$root/tools/cli.js" "$@"\nfi\nif [ -f "$root/dist/cli/entry.js" ]; then exec node "$root/dist/cli/entry.js" "$@"; fi\nprintf \'houston: neither src/cli/entry.ts with tools/cli.js nor dist/cli/entry.js is under %s. Nothing was run.\\n\' "$root" >&2\nexit 252\n'

PROVENANCE = ('candidate-source.json', 'candidate-fingerprint-before.json',
              'fixture-manifest-before.json')
FEATURE_RECEIPTS = ('onboarding-persisted.json', 'setup-persisted.json',
                    'setup-interactive-persisted.json')

# This CLI is executed by main's real process runner with its scrubbed environment.
STUB = r'''
import hashlib, json, os, sys
from pathlib import Path
out = Path(OUT)
attack = ATTACK
args = sys.argv[1:]
home = Path(os.environ['HOUSTON_HOME'])

def emit(schema, data=None, error=None, code=0):
    value = dict(schema=schema, contract=2, ok=code == 0, houston_version='9.9.9')
    if attack.startswith('feature-schema:') and schema == 'houston.onboard.v1' and isinstance(data, dict) and data.get('schema') == 'houston.setup.v1':
        _, response, fault = attack.split(':')
        selected = ('save' if '--deployment' in args else 'defaults' if '--accept-defaults' in args else
                    'show' if args[1:2] == ['setup'] else
                    'prompt-readback' if data['selection']['seed_profile'] == 'small' else 'readback')
        if response == selected:
            if fault == 'missing':
                data.pop('schema')
            else:
                data['schema'] = 'houston.setup.wrong'
    value['error' if error else 'data'] = error if error else data
    print(json.dumps(value))
    sys.exit(code)

def descriptor(name, flags, schema):
    return dict(name=name, flags=flags, json=True, schema=schema)
if args == ['--version']:
    print('houston 9.9.9')
    sys.exit(0)
if args == ['capabilities']:
    commands = [descriptor('info', ['--name'], 'houston.info.v1'), descriptor('capabilities', [], 'houston.capabilities.v1')]
    if attack.startswith('inspect-'):
        commands.append(descriptor('inspect', ['--name'], 'houston.inspect.v1'))
    if attack.startswith(('bundle-', 'admin-')):
        commands.append(descriptor('evidence', ['--name', '--bundle'], 'houston.evidence.v1'))
    if attack == 'config-large' or attack.startswith('feature-'):
        commands.append(descriptor('onboard', ['--json'] + (['--show', '--deployment', '--scenario', '--seed-profile', '--retain-runs/--no-retain-runs', '--accept-defaults', '--reconfigure', '--section'] if attack.startswith('feature-') else []), 'houston.onboard.v1'))
        commands.append(descriptor('down', ['--name', '--yes'], 'houston.down.v1'))
    emit('houston.capabilities.v1', dict(houston_version='9.9.9', contract_versions=[2], default_bind_host='127.0.0.1', commands=commands))
if '--name' in args and args[args.index('--name') + 1] == 'verify-missing':
    emit('houston.error.v1', error=dict(code='NOT_FOUND'), code=4)
if args[0] == 'evidence':
    record = json.loads((home / 'repros/verify-fixture/repro.json').read_text())
    repro = {k: record[k] for k in ('name', 'preset', 'runtime', 'deployment', 'rc_version', 'mongo_tag', 'mongo_flavor', 'public_url', 'host_port', 'version_source', 'created_at') if k in record}
    repro.update(runtime='docker', deployment='monolith', rc_image='rocketchat/rocket.chat:8.5.1', root_url='http://127.0.0.1:39999', bind_host='127.0.0.1')
    admin = {'admin-null': None, 'admin-map': {}, 'admin-list': [], 'admin-int': 0}.get(attack, 'masked')
    compose = json.dumps(dict(services=dict(rocketchat=dict(image='rocketchat/rocket.chat:8.5.1', environment=dict(ADMIN_PASS=admin), labels={'support-note': 'masked'}, command='clean'))))
    if attack == 'bundle-compose':
        compose += ' ' * (2 * 1024 * 1024)
    raw = (home / 'repros/verify-fixture/docker-compose.yml').read_bytes()
    data = dict(repro=repro, seed=dict(profile='standard', planned=dict(users=1), actual=dict(users=1)), artifact=dict(name='docker-compose.yml', sha256=hashlib.sha256(raw).hexdigest(), sanitized=dict(name='docker-compose.yml', sha256=hashlib.sha256(compose.encode()).hexdigest())))
    if '--bundle' in args:
        bundle = Path(args[args.index('--bundle') + 1])
        bundle.mkdir()
        (bundle / 'manifest.json').write_text(json.dumps(data))
        (bundle / 'README.md').write_text('Workspace `verify-fixture` Rocket.Chat 8.5.1 http://127.0.0.1:39999')
        (bundle / 'docker-compose.yml').write_text(compose)
        if attack in ('bundle-manifest', 'bundle-readme'):
            name = {'bundle-manifest': 'manifest.json', 'bundle-readme': 'README.md', 'bundle-compose': 'docker-compose.yml'}[attack]
            with (bundle / name).open('ab') as stream:
                stream.write(b' ' * (2 * 1024 * 1024))
        data['bundle'] = dict(path=str(bundle), files=['manifest.json', 'README.md', 'docker-compose.yml'])
    emit('houston.evidence.v1', data)
if args[0] == 'down':
    config = json.loads((home / 'config.yaml').read_text())
    code = 'GATE_OWNED_CLUSTER' if config.get('onboarding', {}).get('completed') else 'GATE_NOT_ONBOARDED'
    approval = 'houston onboard grant owned-cluster' if code == 'GATE_OWNED_CLUSTER' else 'houston onboard'
    emit('houston.error.v1', error=dict(code=code, gate=dict(approve_with=approval)), code=6)
if args[0] == 'onboard':
    config_file = home / 'config.yaml'
    config = json.loads(config_file.read_text())
    if attack == 'config-large':
        with config_file.open('ab') as stream:
            stream.truncate(2 * 1024 * 1024)
        emit('houston.onboard.v1', dict(completed=False, grants=dict(owned_cluster=False), answered_grants=dict(owned_cluster=False)))
    if len(args) > 2 and args[1] in ('grant', 'revoke'):
        if args[2] != 'owned-cluster':
            emit('houston.error.v1', error=dict(code='VALIDATION_FAILED'), code=2)
        granted = args[1] == 'grant'
        config['grants']['owned_cluster'] = granted
        config['grants']['clusters'] = ['preserved-cluster'] + (['houston-local'] if granted else [])
        config['onboarding'].update(completed=True, completed_at='2026-01-01T00:00:00+00:00', rc_repro_version='9.9.9')
        config_file.write_text(json.dumps(config))
    setup = '--show' in args or '--deployment' in args or '--accept-defaults' in args or (args[1:2] == ['setup'])
    if setup:
        if '--json' in args and (args == ['onboard', 'setup', '--json'] or 'not-a-deployment' in args or ('--show' in args and '--seed-profile' in args)):
            emit('houston.error.v1', error=dict(code='VALIDATION_FAILED'), code=2)
        if '--reconfigure' in args:
            answer = sys.stdin.read()
            if 'yes' in answer:
                config['preferences']['seed_profile'] = 'small'
                config_file.write_text(json.dumps(config))
                print('Setup choices recorded.')
            else:
                print('No changes written.')
            sys.exit(0)
        if '--deployment' in args:
            config['default_deployment'] = 'microservices'
            config['preferences'].update(seed_profile='none', retain_runs=True)
            config_file.write_text(json.dumps(config))
        selection = dict(deployment='microservices' if config['default_deployment'] == 'microservices' else 'monolith', scenarios=[], seed_profile=config['preferences']['seed_profile'], retain_runs=config['preferences']['retain_runs'])
        if '--json' not in args:
            deployment = 'monolith' if attack == 'feature-human-wrong' else selection['deployment']
            print('deployment  ' + deployment)
            print('engine      microservices ready no')
            print('  GATE_OWNED_CLUSTER: permission denied')
            sys.exit(0)
        emit('houston.onboard.v1', dict(schema='houston.setup.v1', selection=selection, persisted=config, actions=[], capacity=dict(supported_action=None), gates=[dict(code='GATE_OWNED_CLUSTER')], action='unchanged', first_run_command='houston up --version 8.5.1 --name fixture --wait'))
    completed = config['onboarding'].get('completed', False)
    emit('houston.onboard.v1', dict(completed=completed, completed_at=config['onboarding'].get('completed_at'), grants=dict(owned_cluster=config['grants'].get('owned_cluster', False)), answered_grants=dict(owned_cluster=completed), clusters=config['grants']['clusters'], rc_repro_version='9.9.9'))
if args[0] == 'inspect':
    name = args[args.index('--name') + 1]
    runtime = 'kubernetes' if name == 'verify-kube-fixture' else 'docker'
    if '--json' in args:
        emit('houston.inspect.v1', dict(name=name, runtime=runtime,
             url='http://127.0.0.1:39999', bind_host='127.0.0.1',
             docker=dict(containers=[], networks=[], volumes=[], warnings=['engine unavailable']),
             kubernetes=dict(nodes=[], services=[], pods=[], warnings=['reads unavailable'],
                             context='verify-offline', namespace='houston-verify-kube-fixture', cluster_exists=None)))
    human_name, human_runtime = name, runtime
    if attack != 'inspect-clean':
        _, selected_runtime, field = attack.split(':')
        if selected_runtime == runtime:
            if field == 'name':
                human_name = 'another-' + name + '-copy'
            else:
                human_runtime = 'docker' if runtime == 'kubernetes' else 'kubernetes'
    # Match renderInspection/writePanel's title and label/value contract.
    print(f'+- {human_name} ----+\n|  Runtime  {human_runtime}  |\n+----------------+')
    for panel in ('nodes', 'services', 'pods') if runtime == 'kubernetes' else ('containers', 'networks', 'volumes'):
        print(f'+- {panel} ----+\n|  unknown  |\n+----------------+')
    sys.exit(0)
if args[0] != 'info':
    raise RuntimeError(args)
if attack.startswith('access-'):
    import shlex
    name = args[args.index('--name') + 1]
    record = json.loads((home / 'repros' / name / 'repro.json').read_text())
    runtime = record['extra']['runtime']
    remote = any(os.environ.get(key) for key in ('SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY'))
    sides = sorted(record['extra'].get('sidecar_ports', []) + record['extra'].get('monitoring_ports', []))
    host_port = record['host_port']
    port_text = os.environ.get('HOUSTON_SSH_LOCAL_PORT', str(host_port))
    try:
        port = int(port_text)
        assert 1024 <= port <= 65535 and port not in sides
    except (ValueError, AssertionError):
        emit('houston.error.v1', error=dict(code='VALIDATION_FAILED'), code=2)
    access = None
    if record['extra']['bind_host'] != '0.0.0.0':
        command = None
        if remote:
            target = '[::1]' if record['extra']['bind_host'] == '::1' else '127.0.0.1'
            forwards = ['-L', f'127.0.0.1:{port}:{target}:{host_port}']
            for side in sides:
                forwards += ['-L', f'127.0.0.1:{side}:{target}:{side}']
            command = shlex.join(['ssh', '-N', '-o', 'ExitOnForwardFailure=yes', *forwards, '--', os.environ['HOUSTON_SSH_USER'] + '@' + os.environ['HOUSTON_SSH_HOST']])
        access = dict(mode='remote_ssh' if remote else 'local', bind='loopback', host_port=host_port,
                      local_port=port if remote else host_port, browser_url=f'http://127.0.0.1:{port}' if remote else record['root_url'],
                      tunnel_command=command, side_ports=sides, note='synthetic remote guidance' if remote else None)
    if attack == 'access-public-local' and name == 'verify-public-fixture' and not remote:
        access = dict(mode='local', browser_url=record['root_url'], tunnel_command=None)
    if '--json' not in args:
        human_name = name
        if attack.startswith('access-human:'):
            _, stage, selected_runtime, field = attack.split(':')
            if (stage == ('remote' if remote else 'local') and selected_runtime == runtime
                    and (field == 'name' or not os.environ.get('HOUSTON_SSH_LOCAL_PORT'))):
                if field == 'name':
                    human_name = 'another-' + name + '-copy'
                else:
                    # Wrong runtime metadata with the requested title preserved.
                    # Historical fixtures shared this port, so old main falsely passes.
                    other = 'verify-access-fixture' if runtime == 'docker' else 'verify-docker-access-fixture'
                    other_record = json.loads((home / 'repros' / other / 'repro.json').read_text())
                    other_port = other_record['host_port']
                    access['browser_url'] = f'http://127.0.0.1:{other_port}'
                    if remote:
                        access['tunnel_command'] = access['tunnel_command'].replace(f':{host_port}', f':{other_port}')
        print(f'+- {human_name} ----+\n|  URL  {access["browser_url"] if access else "public"}  |\n+----------------+')
        print(' '.join(str(access[key] or '') for key in ('browser_url', 'tunnel_command')) if access else 'public')
        sys.exit(0)
    data = dict(name=name, runtime=runtime, access=access)
    if attack.startswith('access-identity:'):
        _, stage, selected_runtime, field = attack.split(':')
        actual_stage = ('public' if remote else 'public-local') if name == 'verify-public-fixture' else 'remote' if remote else 'discovery'
        if stage == actual_stage and runtime == selected_runtime:
            data[field] = 'another-workspace' if field == 'name' else 'docker' if runtime == 'kubernetes' else 'kubernetes'
    emit('houston.info.v1', data)
if 'verify-kube-fixture' not in args and 'verify-fixture' not in args:
    if 'verify-access-fixture' in args:
        if attack.startswith('cleanup-'):
            target = Path(os.environ['TMPDIR']) / 'cleanup-tree'
            target.mkdir(exist_ok=True)
            current = target
            for depth in range(0 if attack == 'cleanup-clean' else 40):
                current = current / 'deep'
                current.mkdir(exist_ok=True)
                for index in range(12):
                    (current / f'cleanup-leaf-{index}').write_text('synthetic cleanup input')
            (target / 'outside-link').symlink_to(OUTSIDE)
            if attack == 'cleanup-primary':
                print('candidate command failed', file=sys.stderr)
                sys.exit(3)
        elif attack == 'dispatch-ignored-regular-mutate':
            with (Path.cwd() / 'tools/cli.js').open('a') as stream:
                stream.write('\n// candidate changed ignored dispatcher code\n')
        elif attack.startswith(('entrypoint-', 'dispatch-')) and attack.endswith('mutate'):
            with Path(__file__).open('a') as stream:
                stream.write('\n# candidate changed executable bytes\n')
        elif attack.startswith('filter-') and 'during' in attack:
            with (Path.cwd() / '.git/config').open('a') as stream:
                stream.write('\n[include]\n\tpath = ' + FILTER_CONFIG + '\n')
        elif attack == 'git-helper-during':
            with (Path.cwd() / '.git/config').open('a') as stream:
                stream.write('\n[core]\n\tfsmonitor = ' + HELPER + '\n')
        elif attack.startswith('work-'):
            where = attack.split(':')[1]
            target = {'temp': Path(os.environ['TMPDIR']), 'fixture': home / 'repros/verify-fixture',
                      'retained': out, 'time': out, 'growing': out, 'inventory': out,
                      'aggregate': out, 'final-total': out, 'entries': out}.get(where)
            if target is not None:
                count = 6 if where == 'aggregate' else 2 if where == 'final-total' else 1
                for index in range(count):
                    with (target / f'budget-{index}.bin').open('wb') as stream:
                        stream.truncate(96 * 1024 if where in ('aggregate', 'final-total') else 64 * 1024 if where == 'growing' else 16 if where in ('time', 'inventory', 'entries') else 256 * 1024)
        elif attack.startswith('untracked-'):
            root = Path.cwd()
            if attack == 'untracked-new':
                (root / 'evidence.tmp').write_text('candidate root artifact\n')
            elif attack in ('untracked-colon-new', 'untracked-colon-existing', 'untracked-nested'):
                target = root / ('nested/new/artifact.txt' if attack == 'untracked-nested' else ':node_modules')
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('candidate artifact changed\n')
            elif attack == 'untracked-existing':
                (root / 'extension.ts').write_text('candidate changed existing source\n')
            elif attack == 'untracked-ignored':
                (root / 'ignored-build').mkdir(exist_ok=True)
                (root / 'ignored-build/generated.txt').write_text('ignored generated artifact\n')
        elif attack.startswith('receipt:'):
            _, name, kind = attack.split(':')
            target = out / name
            if target.exists():
                target.unlink()
            if kind == 'symlink':
                target.symlink_to(OUTSIDE)
            elif kind == 'fifo':
                os.mkfifo(target)
            elif kind == 'directory':
                target.mkdir()
                (target / 'marker').write_text('keep')
                target.chmod(0)
            elif kind == 'socket':
                import socket
                sock = socket.socket(socket.AF_UNIX)
                sock.bind(str(target))
            elif kind == 'hardlink':
                os.link(OUTSIDE, target)
        elif attack.startswith('command-forge:'):
            (out / attack.split(':')[1]).write_text('forged command bytes\n')
        elif attack == 'summary-planted':
            (out / 'summary.json').mkdir()
            for index in range(100):
                (out / f'summary.json.refused.{index}').write_text('{"result":"PASS_SCOPED"}')
        elif attack.startswith('manifest-decoy'):
            (out / 'sha256.json').mkdir()
            (out / 'sha256.json.refused.0').write_text('{"summary.json":"forged"}')
        elif attack in ('no-summary', 'failed-command-forge'):
            print('candidate command failed', file=sys.stderr)
            sys.exit(3)
        elif attack.startswith('delete:'):
            (out / attack.split(':')[1]).unlink()
        elif attack.startswith('symlink:'):
            target = out / attack.split(':')[1]
            target.unlink()
            target.symlink_to('missing-provenance')
        elif attack.startswith('forge:'):
            (out / attack.split(':')[1]).write_text('{}\n')
        elif attack == 'root-symlink':
            import shutil
            for source in out.iterdir():
                if source.is_file():
                    shutil.copyfile(source, Path(OTHER) / source.name)
            out.rename(out.with_name('original-evidence'))
            out.symlink_to(OTHER, target_is_directory=True)
        elif attack == 'outer-failure':
            (out / 'sha256.json').write_text('{"obsolete":true}')
        elif attack == 'stdout-hardlink':
            os.link(OUTSIDE, out / 'access-discovery-kubernetes.stdout')
    emit('houston.info.v1', {})
emit('houston.info.v1', {})
'''


def load(path):
    spec = importlib.util.spec_from_file_location('verifier_under_test', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def worker(path, checkout, out, attack):
    module = load(path)
    git_environments = []
    cleanup_unlinks = []
    if attack.startswith('git-'):
        run_command = module.run_command
        def observe_git(command, cwd, env, *args, **kwargs):
            if Path(command[0]).name == 'git':
                git_environments.append(dict(command=command, keys=sorted(env),
                                             sentinel=env.get('VERIFIER_CALLER_SENTINEL')))
            return run_command(command, cwd, env, *args, **kwargs)
        module.run_command = observe_git
    if attack.startswith('cleanup-'):
        module.FILE_WORK_ENTRIES = 256
        unlink = module.os.unlink
        real_clock = module.time.monotonic
        cleanup_offset = 0
        def observe_unlink(name, *args, **kwargs):
            nonlocal cleanup_offset
            if str(name).split('/')[-1].startswith('cleanup-leaf-'):
                cleanup_unlinks.append(str(name))
                if attack == 'cleanup-time':
                    cleanup_offset += 31
            return unlink(name, *args, **kwargs)
        module.os.unlink = observe_unlink
        if attack == 'cleanup-time':
            module.time.monotonic = lambda: real_clock() + cleanup_offset
    if attack.startswith('work-'):
        # Small limits exercise the production budget against real files and reads.
        module.FILE_WORK_LIMIT_BYTES = 128 * 1024
        module.TOTAL_WORK_LIMIT_BYTES = 512 * 1024
        if attack.endswith(':entries'):
            module.FILE_WORK_ENTRIES = 256
        if attack == 'work-before:aggregate':
            module.FILE_WORK_LIMIT_BYTES = 256 * 1024
        if attack in ('work-after:time', 'work-after:growing'):
            original_open = module.open_regular_file
            real_clock = module.time.monotonic
            offset = 0
            growth_reads = 0

            class ObservedRead:
                def __init__(self, handle, target):
                    self.handle, self.target = handle, target

                def __enter__(self):
                    return self

                def __exit__(self, *args):
                    return self.handle.__exit__(*args)

                def __getattr__(self, name):
                    return getattr(self.handle, name)

                def read(self, size=-1):
                    nonlocal offset, growth_reads
                    if self.target.name == 'budget-0.bin':
                        if attack.endswith(':growing') and growth_reads < 3:
                            with self.target.open('ab') as writer:
                                writer.write(b'A' * (64 * 1024))
                            growth_reads += 1
                        block = self.handle.read(size)
                        if attack.endswith(':time'):
                            offset += 31
                        return block
                    return self.handle.read(size)

            module.open_regular_file = lambda target: ObservedRead(original_open(target), target)
            module.time.monotonic = lambda: real_clock() + offset
        if attack in ('work-after:inventory', 'work-after:entries'):
            # Exhaust the final inventory's actual traversal/read work, after the
            # independent scans. Faults change input/limits, never its result.
            original_receipts = module.write_verification_receipts

            def inventory_input(out, summary):
                if attack.endswith(':inventory'):
                    with (out / 'budget-0.bin').open('ab') as stream:
                        stream.truncate(256 * 1024)
                else:
                    for index in range(200):
                        (out / f'entry-{index}').write_bytes(b'')
                return original_receipts(out, summary)

            module.write_verification_receipts = inventory_input
    if attack in ('outer-failure', 'manifest-decoy-outer'):
        # Fail at real inventory readback, after summary and inventory exist.
        original = module.require_regular_file

        def refuse_manifest_readback(target, message):
            if str(message).startswith('Evidence entry disappeared after cleanup:'):
                raise OSError('injected inventory readback failure')
            return original(target, message)

        module.require_regular_file = refuse_manifest_readback
    if attack == 'no-summary':
        original_write = module.atomic_receipt_bytes

        def deny_summary(destination, payload):
            if destination.name.startswith('summary.json'):
                raise OSError('injected summary write denial')
            return original_write(destination, payload)

        module.atomic_receipt_bytes = deny_summary
    if attack == 'failed-command-forge':
        fingerprint = module.candidate_fingerprint
        calls = 0

        def tamper_failed_command(root):
            nonlocal calls
            calls += 1
            if calls == 2:
                target = out / 'access-discovery-kubernetes.stderr'
                assert target.read_text() == 'candidate command failed\n'
                target.write_text('forged failure output\n')
            return fingerprint(root)

        module.candidate_fingerprint = tamper_failed_command
    if attack.startswith(('feature-delete:', 'feature-forge:')):
        fingerprint = module.candidate_fingerprint
        calls = 0

        def tamper_before_final_fingerprint(root):
            nonlocal calls
            calls += 1
            if calls == 2:
                name = attack.split(':')[1]
                target = out / name
                assert target.is_file(), f'feature drive did not emit {name}'
                if attack.startswith('feature-delete:'):
                    target.unlink()
                else:
                    target.write_text('{}\n')
            return fingerprint(root)

        # Model a retained-file mutation after the last CLI process, including
        # the interactive snapshot which has no subsequent candidate command.
        module.candidate_fingerprint = tamper_before_final_fingerprint
    sys.argv = [str(path), '--checkout', str(checkout), '--evidence-dir', str(out)]
    try:
        module.main()
    finally:
        if attack.startswith(('git-', 'cleanup-')):
            (out / 'boundary-observations.json').write_text(json.dumps(dict(
                git_environments=git_environments, cleanup_unlinks=cleanup_unlinks)))


def run_main_case(path, attack, proof_dir=None):
    with tempfile.TemporaryDirectory(prefix='hv9-') as directory:
        base = Path(directory).resolve()
        candidate = base / 'candidate'
        (candidate / 'bin').mkdir(parents=True)
        out = base / 'out'
        outside = base / 'outside'
        outside.write_bytes(b'outside source unchanged\n')
        other = base / 'other'
        other.mkdir()
        forged_summary = b'{"result":"PASS_SCOPED"}'
        (other / 'summary.json').write_bytes(forged_summary)
        stub = candidate / 'bin/houston'
        stub.write_text(
            f'#!{sys.executable}\nOUT={str(out)!r}\nATTACK={attack!r}\n'
            f'FILTER_CONFIG={str(base / "filter-config")!r}\nOUTSIDE={str(outside)!r}\nOTHER={str(other)!r}\nHELPER={str(base / "git-helper")!r}\n' + STUB)
        stub.chmod(0o700)
        executable_before = stub.read_bytes()
        executable_target = stub
        if attack.startswith('dispatch-'):
            layout = candidate / 'ignored-build/copy' if 'relocated' in attack else candidate
            (layout / 'src/cli').mkdir(parents=True)
            (layout / 'tools').mkdir()
            (layout / 'src/cli/entry.ts').write_text('// synthetic entry marker\n')
            target_dir = base / 'external-tools' if 'external' in attack else layout / 'tools'
            if 'fallback' in attack:
                target_dir = candidate / 'dist/cli'
            if 'ignored' in attack and 'ignored-regular' not in attack:
                target_dir = candidate / 'ignored-build/source'
            target_dir.mkdir(parents=True, exist_ok=True)
            executable_target = target_dir / 'stub.py'
            stub.rename(executable_target)
            adapter = "const r=require('child_process').spawnSync(%s,[%s,...process.argv.slice(2)],{stdio:'inherit'});process.exit(r.status===null?1:r.status);" % (json.dumps(sys.executable), json.dumps(str(executable_target)))
            if 'parent' in attack:
                (layout / 'tools').rmdir()
                (layout / 'tools').symlink_to(target_dir, target_is_directory=True)
                (target_dir / 'cli.js').write_text(adapter)
            elif 'source' in attack:
                (layout / 'tools/cli.js').write_text("require('../src/adapter.js');")
                (target_dir / 'adapter.js').write_text(adapter)
                (layout / 'src/adapter.js').symlink_to(target_dir / 'adapter.js')
            elif 'external' in attack or ('ignored' in attack and 'ignored-regular' not in attack):
                (target_dir / 'cli.js').write_text(adapter)
                (layout / 'tools/cli.js').symlink_to(target_dir / 'cli.js')
            else:
                (layout / 'tools/cli.js').write_text(adapter)
            if attack == 'dispatch-bin-clean':
                (candidate / 'bin/real-dispatcher').write_bytes(DISPATCHER)
                (candidate / 'bin/real-dispatcher').chmod(0o700)
                stub.symlink_to('real-dispatcher')
            elif layout != candidate:
                (layout / 'bin').mkdir()
                (layout / 'bin/houston').write_bytes(DISPATCHER)
                (layout / 'bin/houston').chmod(0o700)
                stub.symlink_to('../ignored-build/copy/bin/houston')
            else:
                stub.write_bytes(DISPATCHER)
                stub.chmod(0o700)
            if 'fallback' in attack:
                (layout / 'src/cli/entry.ts').unlink()
                (candidate / 'dist/cli/entry.js').write_text(adapter)
            executable_before = executable_target.read_bytes()
            adapter_before = (layout / 'tools/cli.js').read_bytes()
        elif attack.startswith('entrypoint-'):
            # Track the link, but leave the real bytes ignored or outside.
            executable_target = (base / 'external-cli' if 'external' in attack else
                                 candidate / 'ignored-build/real-cli')
            executable_target.parent.mkdir(exist_ok=True)
            stub.rename(executable_target)
            stub.symlink_to(executable_target)
            if 'parent' in attack:
                stub.unlink()
                (candidate / 'bin').rmdir()
                directory_target = executable_target.parent / 'entry-bin'
                directory_target.mkdir()
                executable_target.rename(directory_target / 'houston')
                executable_target = directory_target / 'houston'
                (candidate / 'bin').symlink_to(directory_target, target_is_directory=True)
        if attack == 'entrypoint-bin-clean':
            stub.unlink()
            executable_target.rename(candidate / 'bin/real-cli')
            executable_target = candidate / 'bin/real-cli'
            stub.symlink_to('real-cli')
        if not attack.startswith('dispatch-'):
            (candidate / 'src/cli').mkdir(parents=True)
            (candidate / 'tools').mkdir()
            (candidate / 'src/cli/entry.ts').write_text('// synthetic source layout\n')
            (candidate / 'tools/cli.js').write_text('// synthetic source layout\n')
        (candidate / 'package.json').write_text(
            '{"version":"9.9.9"}' + (' ' * (2 * 1024 * 1024) if attack == 'package-large' else ''))
        # The synthetic CLI writes JSON, a YAML subset. This parser dependency
        # supplies transport only; no receipt or finalizer logic is stubbed.
        yaml = candidate / 'node_modules/yaml'
        yaml.mkdir(parents=True)
        (yaml / 'index.js').write_text('exports.parse=JSON.parse;')
        (candidate / '.gitignore').write_text('node_modules/\nignored-build/\ndist/\n' + ('tools/cli.js\n' if attack == 'dispatch-ignored-regular-mutate' else ''))
        (candidate / 'notes.tmp').write_bytes(b'unrelated dirty file\n')
        if attack.startswith('untracked-'):
            (candidate / 'extension.ts').write_text('existing untracked source\n')
        if attack in ('untracked-colon-existing', 'untracked-colon-clean'):
            (candidate / ':node_modules').write_text('existing colon artifact\n')
        if attack == 'untracked-symlink':
            (candidate / 'candidate-link').symlink_to(outside)
        if attack == 'untracked-fifo':
            os.mkfifo(candidate / 'candidate-pipe')
        if attack.startswith('work-before:'):
            count = 160 if attack.endswith(':entries') else 6 if attack.endswith(':aggregate') else 1
            for index in range(count):
                with (candidate / f'budget-{index}.bin').open('wb') as stream:
                    stream.truncate(0 if attack.endswith(':entries') else 96 * 1024 if count > 1 else 256 * 1024)
        environment = {
            'PATH': os.environ.get('PATH', os.defpath), 'HOME': str(base),
            'LANG': 'C.UTF-8', 'GIT_CONFIG_NOSYSTEM': '1',
            'GIT_CONFIG_GLOBAL': os.devnull,
        }
        for command in (
            ['git', 'init', '-q', str(candidate)],
            ['git', '-C', str(candidate), 'add', 'bin', 'package.json', '.gitignore', *(['src', 'tools'] if 'relocated' not in attack else [])],
            ['git', '-C', str(candidate), '-c', 'user.name=Verifier test',
             '-c', 'user.email=verifier@invalid', '-c', 'commit.gpgsign=false',
             '-c', f'core.hooksPath={os.devnull}', 'commit', '-qm', 'fixture'],
        ):
            subprocess.run(command, check=True, env=environment,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if attack.startswith('work-before:'):
            (candidate / 'src').mkdir(exist_ok=True)
            for item in candidate.glob('budget-*.bin'):
                item.rename(candidate / 'src' / item.name)
        if attack.startswith('filter-'):
            helper = base / 'filter-helper'
            helper.write_text('#!/bin/sh\necho ran >> %s\n%s' % (base / 'helper-marker', 'exit 1\n' if 'process' in attack else 'cat >/dev/null\nexec %s -C %s show HEAD:package.json\n' % (__import__('shutil').which('git'), candidate)))
            helper.chmod(0o700)
            driver = 'process' if 'process' in attack else 'clean'
            config = base / 'filter-config'
            config.write_text('[filter "x"]\n\t%s = %s\n' % (driver, helper))
            (candidate / '.git/info/attributes').write_text('package.json filter=x\n')
            (candidate / 'package.json').write_text('{"version":"9.9.9","dirty":true}')
            if 'during' not in attack:
                with (candidate / '.git/config').open('a') as stream:
                    if 'worktree' in attack:
                        stream.write('\n[extensions]\n\tworktreeConfig = true\n')
                        (candidate / '.git/config.worktree').write_text(config.read_text())
                    elif 'include' in attack:
                        stream.write('\n[include]\n\tpath = ' + str(config) + '\n')
                    else:
                        stream.write('\n' + config.read_text())
        if attack.startswith('git-'):
            helper = base / 'git-helper'
            helper.write_text(f'#!{sys.executable}\nimport os,json,sys\nfrom pathlib import Path\n'
                              f'Path({str(base / "helper-marker")!r}).write_text(json.dumps(dict(sentinel=os.environ.get("VERIFIER_CALLER_SENTINEL"))))\n'
                              'sys.stdout.buffer.write(b"token\\0")\n')
            helper.chmod(0o700)
            environment['VERIFIER_CALLER_SENTINEL'] = 'SYNTHETIC_NONSECRET_R13'
            if attack == 'git-helper-initial':
                with (candidate / '.git/config').open('a') as stream:
                    stream.write('\n[core]\n\tfsmonitor = ' + str(helper) + '\n')
        command = [sys.executable, '-I', '-B', str(Path(__file__).resolve()),
                   '--worker', str(path.resolve()), str(candidate), str(out), attack]
        try:
            result = subprocess.run(command, capture_output=True, text=True,
                                    env=environment, timeout=12)
        except subprocess.TimeoutExpired as error:
            raise AssertionError(f'actual main timed out after 12s: {attack}') from error
        if proof_dir is not None:
            retained = proof_dir / attack.replace(':', '_')
            retained.mkdir(parents=True, exist_ok=False)
            (retained / 'worker.stdout').write_text(result.stdout)
            (retained / 'worker.stderr').write_text(result.stderr)
            (retained / 'invocation.json').write_text(json.dumps(dict(
                command=command, exit=result.returncode, attack=attack,
                verifier_sha256=hashlib.sha256(path.read_bytes()).hexdigest()), indent=2) + '\n')
            names = ['boundary-observations.json', *PROVENANCE, 'candidate-fingerprint-after.json', 'fixture-manifest-after.json', 'commands.json']
            # Retain actual synthetic outputs at the new CLI boundaries, including
            # baseline false passes. These files contain no real workspace data.
            for label in ('access-public-local', 'access-public', 'inspect-docker',
                          'inspect-kubernetes', 'inspect-docker-human', 'inspect-kubernetes-human'):
                names.extend((label + '.stdout', label + '.stderr'))
            if attack.startswith('feature-'):
                names.extend(p.name for p in out.glob('setup-*.stdout'))
            if attack.startswith('dispatch-'):
                (retained / 'executed-code-before.bin').write_bytes(executable_before)
                (retained / 'executed-code-after.bin').write_bytes(executable_target.read_bytes())
                (retained / 'dispatcher.bin').write_bytes(DISPATCHER)
                (retained / 'adapter-before.js').write_bytes(adapter_before)
                (retained / 'adapter-after.js').write_bytes((layout / 'tools/cli.js').read_bytes())
            if attack.startswith('access-human:') or attack == 'access-clean':
                names.extend(p.name for p in out.glob('access-*.stdout'))
            if attack.startswith('filter-'):
                for name in ('config', 'config.worktree', 'info/attributes'):
                    target = candidate / '.git' / name
                    if target.is_file():
                        (retained / ('git-' + name.replace('/', '-') + '.txt')).write_bytes(target.read_bytes())
                (retained / 'filter-config.txt').write_bytes((base / 'filter-config').read_bytes())
            if (base / 'helper-marker').exists():
                (retained / 'helper-marker.json').write_bytes((base / 'helper-marker').read_bytes())
            if attack.startswith('entrypoint-'):
                (retained / 'executable-before.bin').write_bytes(executable_before)
                (retained / 'executable-after.bin').write_bytes(executable_target.read_bytes())
            for name in names:
                target = out / name
                if target.is_file() and not target.is_symlink() and target.stat().st_size <= 1024 * 1024:
                    (retained / name).write_bytes(target.read_bytes())
            if attack.startswith('untracked-colon'):
                (retained / 'candidate-git-status.txt').write_bytes(subprocess.check_output(
                    ['git', '-C', str(candidate), 'status', '--porcelain'], env=environment))
                target = candidate / ':node_modules'
                if target.is_file():
                    (retained / 'colon-artifact.txt').write_bytes(target.read_bytes())
            printed = result.stdout.splitlines()
            if printed:
                target = Path(printed[-1])
                if target.is_file() and not target.is_symlink() and target.stat().st_size <= 1024 * 1024:
                    (retained / 'printed-summary.json').write_bytes(target.read_bytes())
        assert (candidate / 'notes.tmp').read_bytes() == b'unrelated dirty file\n', 'unrelated dirty file changed'
        assert outside.read_bytes() == b'outside source unchanged\n', 'outside source bytes overwritten'
        if attack == 'no-summary':
            assert result.returncode == 1, result.returncode
            assert result.stdout == '', f'printed unwritten summary: {result.stdout!r}'
            assert 'expected exit 0, got 3' in result.stderr, result.stderr
            assert 'Could not write a safe failure summary' in result.stderr, result.stderr
            assert 'injected summary write denial' in result.stderr, result.stderr
            prefix = 'No verification summary could be retained: '
            reports = [line[len(prefix):] for line in result.stderr.splitlines() if line.startswith(prefix)]
            assert len(reports) == 1, result.stderr
            report = json.loads(reports[0])
            assert report['result'] == 'FAIL' and report['scratch_removed'] is True, report
            assert report['candidate_unchanged'] is True and report['fixture_unchanged'] is True, report
            assert 'expected exit 0, got 3' in report['error'], report
            assert any('Could not write a safe failure summary' in item
                       for item in report['cleanup_errors']), report
            assert 'inventory' not in report, report
            assert not list(out.glob('summary.json*')), 'summary unexpectedly survived'
            assert not list(out.glob('sha256.json*')), 'inventory survived without summary'
            return dict(exit=result.returncode, printed_summary=None,
                        primary_error_preserved=True, cleanup_facts_reported=True)
        lines = result.stdout.splitlines()
        assert lines, f'main did not print summary: {result.stderr[-1200:]}'
        summary_path = Path(lines[-1])
        summary = json.loads(summary_path.read_text())
        should_pass = (attack in ('clean', 'feature-clean', 'stdout-hardlink', 'access-clean', 'inspect-clean', 'untracked-clean', 'untracked-ignored', 'untracked-colon-clean', 'entrypoint-bin-clean', 'dispatch-clean', 'dispatch-bin-clean', 'dispatch-source-clean',
                                  'git-helper-initial', 'git-helper-during', 'git-clean', 'cleanup-clean')
                       or attack.endswith(':hardlink'))
        assert (result.returncode == 0) == should_pass, f'exit={result.returncode}: {summary}'
        assert summary['result'] == ('PASS_SCOPED' if should_pass else 'FAIL'), summary
        if attack.startswith('cleanup-') and attack != 'cleanup-clean':
            observations = json.loads((out / 'boundary-observations.json').read_text())
            retained_scratch = Path(summary['retained_scratch']) if 'retained_scratch' in summary else None
            remains = retained_scratch is not None and retained_scratch.is_dir()
            # Remove only this case's retained scratch after recording its real state.
            import shutil
            if remains:
                shutil.rmtree(retained_scratch)
            assert 0 < len(observations['cleanup_unlinks']) <= 256, observations
            assert summary['scratch_removed'] is False and remains, summary
            assert 'scratch removal' in str(summary.get('cleanup_errors')), summary
            if attack == 'cleanup-time':
                assert len(observations['cleanup_unlinks']) == 1, observations
                assert '(time, scratch removal)' in str(summary['cleanup_errors']), summary
            assert outside.read_bytes() == b'outside source unchanged\n'
        else:
            assert summary['scratch_removed'] is True, summary
        observed = {
            'exit': result.returncode, 'printed_summary': str(summary_path),
            'result': summary['result'], 'scratch_removed': summary['scratch_removed'],
            'candidate_unchanged': summary['candidate_unchanged'],
            'fixture_unchanged': summary['fixture_unchanged'], 'outside_source_unchanged': True,
        }
        error = str(summary.get('cleanup_errors', '')) + str(summary.get('error', ''))
        if attack.startswith('cleanup-'):
            assert attack == 'cleanup-clean' or 'File work budget exceeded' in error, error
            if attack == 'cleanup-primary':
                assert 'expected exit 0, got 3' in summary['error'], summary
            assert summary.get('receipt_scan', {}).get('result') == 'PASS' or 'Final command receipt scan failed' in error
            if 'inventory' not in summary:
                assert not [p for p in out.glob('sha256.json*') if p.is_file()], 'obsolete inventory retained'
                return dict(observed, budget_refused=True, removed_leaves=len(observations['cleanup_unlinks']),
                            retained_scratch_reported=True, inventory=None)
        elif attack.startswith('git-'):
            observations = json.loads((out / 'boundary-observations.json').read_text())
            assert observations['git_environments'], observations
            assert not (base / 'helper-marker').exists(), 'candidate Git helper executed with synthetic caller environment'
            assert all(item['sentinel'] is None for item in observations['git_environments']), 'caller-only sentinel reached Git environment'
            assert summary['candidate_unchanged'] is True, summary
        elif attack.startswith('filter-'):
            assert not (base / 'helper-marker').exists(), 'candidate filter helper executed'
            assert 'Candidate Git clean/process filter configured' in error, error
            assert (candidate / 'package.json').read_text() == '{"version":"9.9.9","dirty":true}'
        elif attack.startswith('feature-schema:'):
            assert ('Invalid setup inner schema: setup-' + attack.split(':')[1] in error
                    or (attack.split(':')[1] == 'show' and ('Setup preview lost saved answers' in error or "'schema'" in error))), error
        elif attack == 'feature-human-wrong':
            assert 'Human setup selected deployment differs' in error, error
        elif attack.startswith('dispatch-'):
            if attack in ('dispatch-clean', 'dispatch-bin-clean', 'dispatch-source-clean'):
                assert executable_target.read_bytes() == executable_before
            elif attack == 'dispatch-source-mutate':
                assert summary['candidate_unchanged'] is False and summary['source_unchanged'] is False, summary
                assert executable_target.read_bytes() != executable_before
                assert (candidate / 'src/adapter.js').is_symlink()
            else:
                expected = ('Candidate dispatcher root differs' if 'relocated' in attack else
                            'Candidate checkout source dispatch is not manifested' if 'fallback' in attack or 'ignored-regular' in attack else
                            'Unsafe candidate source link')
                assert expected in error, error
                assert executable_target.read_bytes() == executable_before, 'unsafe source executed'
                assert not (out / 'commands.json').exists(), 'unsafe dispatcher launched'
        elif attack.startswith('entrypoint-'):
            if attack != 'entrypoint-bin-clean':
                assert ('Candidate entrypoint escapes checkout' if 'external' in attack else 'Candidate dispatcher root differs') in error, error
                assert executable_target.read_bytes() == executable_before, 'external CLI executed or changed'
                assert not (out / 'commands.json').exists(), 'escaped entrypoint was launched'
            else:
                before = json.loads((out / 'candidate-fingerprint-before.json').read_text())
                after = json.loads((out / 'candidate-fingerprint-after.json').read_text())
                assert before['entrypoint']['sha256'] == hashlib.sha256(executable_before).hexdigest()
                assert before['entrypoint'] == after['entrypoint'], (before, after)
                assert executable_target.read_bytes() == executable_before
        elif attack.startswith('access-human:'):
            assert ('Human access chose another workspace' if attack.endswith(':name') else
                    'Human access guidance differs from JSON' if ':remote:' in attack else
                    'Human local access guidance omitted the browser URL') in error, error
        elif attack.startswith('work-'):
            assert 'File work budget exceeded' in error, error
            reason = ('total byte' if attack.endswith((':aggregate', ':final-total')) else
                      'entry' if attack.endswith(':entries') else
                      'time' if attack.endswith(':time') else 'file byte')
            assert '(' + reason in error, error
            if attack.startswith('work-before:'):
                assert summary.get('candidate_unchanged') is None and summary.get('fixture_unchanged') is None, summary
            else:
                assert summary['candidate_unchanged'] is True, summary
                assert summary['fixture_unchanged'] is (None if attack.endswith(':fixture') else True), summary
            if attack.endswith((':inventory', ':entries', ':final-total')) and attack.startswith('work-after:'):
                assert summary['receipt_scan']['result'] == 'PASS', summary
                assert 'Could not retain or re-read verification evidence' in error, error
            if 'inventory' not in summary:
                assert not [p for p in out.glob('sha256.json*') if p.is_file()], 'obsolete inventory retained'
                return dict(observed, error=error, inventory=None, budget_refused=True)
        elif attack.startswith('inspect-') and attack != 'inspect-clean':
            assert 'Human inspection chose another workspace/runtime' in error, error
        elif attack == 'access-public-local':
            assert 'Wildcard workspace must not claim loopback access' in error, error
        elif attack.startswith('access-') and attack != 'access-clean':
            assert 'Access response chose another workspace/runtime' in error, error
        elif attack.startswith('untracked-'):
            if attack in ('untracked-symlink', 'untracked-fifo'):
                assert 'Untracked candidate entry is not a regular file' in error, error
                assert summary.get('candidate_unchanged') is None, summary
            else:
                before = json.loads((out / 'candidate-source.json').read_text())
                after = json.loads((out / 'candidate-fingerprint-after.json').read_text())['source']
                assert 'notes.tmp' in before and before['notes.tmp'] == after['notes.tmp'], (before, after)
                assert 'extension.ts' in before, before
                if attack == 'untracked-new':
                    assert (candidate / 'evidence.tmp').read_text() == 'candidate root artifact\n'
                if attack in ('untracked-new', 'untracked-existing', 'untracked-colon-new', 'untracked-colon-existing', 'untracked-nested'):
                    assert summary['candidate_unchanged'] is False and summary['source_unchanged'] is False, summary
                    name = ('evidence.tmp' if attack == 'untracked-new' else
                            'extension.ts' if attack == 'untracked-existing' else
                            'nested/new/artifact.txt' if attack == 'untracked-nested' else ':node_modules')
                    if attack.startswith('untracked-colon'):
                        status = subprocess.check_output(['git', '-C', str(candidate), 'status', '--porcelain'], env=environment).decode()
                        assert '?? :node_modules' in status, status
                        assert 'node_modules/yaml/index.js' not in after, after
                        assert (candidate / ':node_modules').read_text() == 'candidate artifact changed\n'
                        assert (name in before) == (attack == 'untracked-colon-existing'), before
                    assert before.get(name) != after[name], (before, after)
                    assert 'Candidate fingerprint changed' in error, error
                else:
                    assert summary['candidate_unchanged'] is True, summary
                    if attack == 'untracked-colon-clean':
                        assert before[':node_modules'] == after[':node_modules'], (before, after)
                        assert (candidate / ':node_modules').read_text() == 'existing colon artifact\n'
                assert (candidate / 'extension.ts').read_text() == ('candidate changed existing source\n' if attack == 'untracked-existing' else 'existing untracked source\n')
        elif attack.startswith(('delete:', 'symlink:')):
            assert 'Mandatory provenance artifact' in error, error
        elif attack.startswith(('forge:', 'feature-delete:', 'feature-forge:', 'command-forge:')) or attack == 'failed-command-forge':
            assert 'receipt integrity failed' in error, error
            if attack.startswith('command-forge:'):
                assert 'receipt integrity failed: ' + attack.split(':')[1] in error, error
            elif attack == 'failed-command-forge':
                assert 'receipt integrity failed: access-discovery-kubernetes.stderr' in error, error
                assert 'expected exit 0, got 3' in summary['error'], summary
        elif attack.startswith(('bundle-', 'config-', 'package-')):
            assert 'exceeds parse limit' in error, error
        elif attack.startswith('admin-'):
            assert 'semantically safe' in error, error
        elif attack.startswith('receipt:') and not attack.endswith(':hardlink'):
            assert 'Refused pre-existing non-regular receipt path' in error, error
        elif attack == 'root-symlink':
            assert 'Evidence directory must be a real directory' in error, error
            assert summary_path == base / 'out.summary.json', summary_path
            expected = {p.name: p.read_bytes() for p in (base / 'original-evidence').iterdir()
                        if p.is_file()}
            expected['summary.json'] = forged_summary
            assert {p.name: p.read_bytes() for p in other.iterdir()} == expected, 'writes through replaced root'
            return dict(observed, inventory=None, replaced_root_untouched=True)
        elif attack in ('outer-failure', 'manifest-decoy-outer'):
            assert 'inventory' not in summary, f'stale inventory locator: {summary}'
            assert 'injected inventory readback failure' in error, error
            assert not [p for p in out.glob('sha256.json*') if p.is_file()], 'obsolete manifest retained'
            return dict(observed, inventory=None, obsolete_inventory_removed=True)
        if attack == 'summary-planted':
            assert summary_path.name not in {f'summary.json.refused.{i}' for i in range(100)}
            for i in range(100):
                assert (out / f'summary.json.refused.{i}').read_bytes() == forged_summary
            assert 'Refused pre-existing non-regular receipt path' in error, error
        if attack == 'manifest-decoy':
            assert (out / 'sha256.json.refused.0').read_text() == '{"summary.json":"forged"}'
        # The actual printed summary must belong to the final byte inventory.
        locator = summary.get('inventory')
        if attack == 'manifest-decoy' or locator is not None:
            assert isinstance(locator, str) and Path(locator).name == locator, f'missing inventory locator: {summary}'
            manifest_path = out / locator
        else:
            manifests = [p for p in out.glob('sha256.json*') if p.is_file()]
            assert len(manifests) == 1, manifests
            manifest_path = manifests[0]
        assert manifest_path.is_file(), f'named inventory missing: {locator}'
        manifest = json.loads(manifest_path.read_text())
        relative = str(summary_path.relative_to(out))
        assert relative in manifest, f'printed summary missing from inventory: {relative}'
        assert manifest_path.name not in manifest, 'manifest inventoried itself'
        for name, digest in manifest.items():
            assert hashlib.sha256((out / name).read_bytes()).hexdigest() == digest, f'wrong final digest: {name}'
        if attack.startswith('receipt:') and attack.endswith(':directory'):
            target = out / attack.split(':')[1]
            target.chmod(0o700)
            assert (target / 'marker').read_text() == 'keep'
            prefix = target.name + '/'
            assert not any(name.startswith(prefix) for name in manifest), 'directory receipt was inventoried'
        return dict(observed, inventory=manifest_path.name, inventoried_files=len(manifest),
                    all_final_digests_match=True, manifest_excluded=True)


def allocation_case(path, operation):
    module = load(path)
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        target = root / 'large'
        with target.open('wb') as stream:
            stream.truncate(3 * 1024 * 1024)
        original = io.open
        reads = []

        class Observed:
            def __init__(self, handle):
                self.handle = handle

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return self.handle.__exit__(*args)

            def __getattr__(self, name):
                return getattr(self.handle, name)

            def read(self, size=-1):
                reads.append(size)
                assert 0 < size <= 1024 * 1024, f'unbounded real caller read({size})'
                return self.handle.read(size)

        def observe(file, *args, **kwargs):
            handle = original(file, *args, **kwargs)
            return Observed(handle) if file == target else handle

        fdopen = os.fdopen

        def observe_fd(fd, *args, **kwargs):
            return Observed(fdopen(fd, *args, **kwargs))

        # Observe real scan/fingerprint callers at standard Python file I/O.
        # No production injection point or copied scanner participates.
        with patch('io.open', observe), patch('os.fdopen', observe_fd):
            if operation == 'scan':
                module.scan_retained_regular_files('sentinel', root)
            elif operation == 'temp':
                module.scan_candidate_temp('sentinel', root)
            else:
                module.tree_manifest(root)
        assert reads and all(n > 0 for n in reads), reads
        return {'read_calls': len(reads), 'largest_requested_read': max(reads), 'file_bytes': target.stat().st_size}


def overlap_case(path, operation):
    module = load(path)
    secret = 'VERIFY_SYNTHETIC_SECRET_59c8'
    boundary = 1024 * 1024
    data = b'A' * (boundary - len(secret) + 1) + secret.encode() + b'B' * 16
    assert secret.encode() not in data[:boundary] and secret.encode() not in data[boundary:]
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        (root / 'leak.txt').write_bytes(data)
        assert module.tree_manifest(root)['leak.txt'] == 'file:' + hashlib.sha256(data).hexdigest()
        try:
            if operation == 'scan':
                module.scan_retained_regular_files(secret, root)
            else:
                module.scan_candidate_temp(secret, root)
        except RuntimeError as error:
            assert 'Synthetic secret leaked: leak.txt' in str(error), error
        else:
            raise AssertionError('boundary sentinel accepted')
        return {'boundary_bytes': boundary, 'sentinel_refused': True, 'digest_matches': True}


def atomic_writer_case(path):
    module = load(path)
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        out = root / 'out'
        out.mkdir()
        outside = root / 'outside'
        outside.write_bytes(b'original source bytes\n')
        names = (*PROVENANCE, *FEATURE_RECEIPTS, 'candidate-fingerprint-after.json',
                 'fixture-manifest-after.json', 'commands.json', 'probe.stdout', 'probe.stderr')
        for name in names:
            target = out / name
            os.link(outside, target)
            module.write_evidence_bytes(out, name, b'new receipt bytes\n')
            assert outside.read_bytes() == b'original source bytes\n', f'write through hardlink: {name}'
            assert target.read_bytes() == b'new receipt bytes\n'
        # Replace a destination after the claim, at the old lstat/open race.
        claim = module.claim_regular_receipt

        def replace_after_claim(destination):
            answer = claim(destination)
            destination.unlink(missing_ok=True)
            os.link(outside, destination)
            return answer

        with patch.object(module, 'claim_regular_receipt', replace_after_claim):
            module.write_evidence_bytes(out, 'raced.stdout', b'race-safe receipt\n')
        assert outside.read_bytes() == b'original source bytes\n', 'write through raced destination'
        return {'receipt_paths': list(names), 'outside_source_unchanged': True, 'raced_write_safe': True}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--verify-source', type=Path, default=SCRIPT)
    parser.add_argument('--proof-dir', type=Path, help='Retain worker output and bounded provenance outside temporary fixtures')
    parser.add_argument('--case', action='append', help='Run an exact named scenario')
    parser.add_argument('--exclude-case', action='append', default=[],
                        help='Explicitly exclude an API unavailable on a historical revision')
    args = parser.parse_args()
    path = args.verify_source
    attacks = (
        'filter-clean-initial', 'filter-clean-include', 'filter-clean-worktree', 'filter-clean-during',
        'filter-process-initial', 'filter-process-during',
        'dispatch-relocated-mutate', 'dispatch-external-mutate', 'dispatch-source-external-mutate',
        'dispatch-ignored-mutate', 'dispatch-parent-external-mutate', 'dispatch-parent-ignored-mutate',
        'dispatch-source-ignored-mutate', 'dispatch-source-clean', 'dispatch-source-mutate',
        'dispatch-fallback-mutate', 'dispatch-ignored-regular-mutate',
        'dispatch-bin-clean', 'dispatch-clean', 'entrypoint-bin-clean',
        *('feature-schema:' + response + ':' + fault for response in ('show', 'save', 'readback', 'defaults', 'prompt-readback') for fault in ('wrong', 'missing')),
        'feature-human-wrong',
        'cleanup-budget', 'cleanup-primary', 'cleanup-time', 'cleanup-clean',
        'entrypoint-external-mutate', 'entrypoint-internal-mutate', 'entrypoint-internal-clean',
        'entrypoint-parent-mutate', 'entrypoint-parent-clean',
        'git-clean', 'git-helper-initial', 'git-helper-during',
        *('access-human:' + stage + ':' + runtime + ':' + field
          for stage in ('local', 'remote') for runtime in ('docker', 'kubernetes')
          for field in ('name', 'runtime')),
        'clean', 'access-clean', 'access-public-local', 'inspect-clean',
        *('inspect-identity:' + runtime + ':' + field
          for runtime in ('docker', 'kubernetes') for field in ('name', 'runtime')),
        *('access-identity:' + stage + ':' + runtime + ':' + field
          for stage, runtime in (('discovery', 'docker'), ('discovery', 'kubernetes'),
                                 ('remote', 'docker'), ('public', 'kubernetes'), ('public-local', 'kubernetes'))
          for field in ('name', 'runtime')),
        *('untracked-' + kind for kind in ('new', 'existing', 'colon-new', 'colon-existing', 'colon-clean', 'nested', 'clean', 'ignored', 'symlink', 'fifo')),
        'work-before:file', 'work-before:aggregate', 'work-before:entries',
        *('work-after:' + where for where in ('temp', 'fixture', 'retained', 'aggregate', 'final-total', 'time', 'growing', 'inventory', 'entries')),
        'root-symlink', 'summary-planted', 'no-summary',
        'manifest-decoy', 'manifest-decoy-outer', 'failed-command-forge',
        *('command-forge:' + name for name in ('version.stdout', 'capabilities.stdout',
           'version.stderr', 'missing-workspace.stdout', 'missing-workspace.stderr')),
        *('receipt:' + name + ':' + kind for name in ('summary.json', 'sha256.json')
          for kind in ('symlink', 'fifo', 'socket', 'directory', 'hardlink')),
        'stdout-hardlink', 'symlink:candidate-source.json',
        *('delete:' + name for name in PROVENANCE),
        *('forge:' + name for name in PROVENANCE),
        'bundle-manifest', 'bundle-readme', 'bundle-compose', 'config-large', 'package-large',
        'admin-null', 'admin-map', 'admin-list', 'admin-int', 'outer-failure', 'feature-clean',
        *('feature-' + kind + ':' + name for name in FEATURE_RECEIPTS for kind in ('delete', 'forge')),
    )
    cases = [('main ' + attack, lambda attack=attack: run_main_case(path, attack, args.proof_dir))
             for attack in attacks]
    cases += [('bounded ' + op, lambda op=op: allocation_case(path, op))
              for op in ('scan', 'temp', 'hash')]
    cases += [('overlap ' + op, lambda op=op: overlap_case(path, op))
              for op in ('scan', 'temp')]
    cases.append(('atomic evidence writers and race', lambda: atomic_writer_case(path)))
    if args.case:
        available = {name for name, _ in cases}
        assert set(args.case) <= available, f'Unknown cases: {set(args.case) - available}'
        cases = [(name, case) for name, case in cases if name in args.case]
    available = {name for name, _ in cases}
    assert set(args.exclude_case) <= available, f'Unknown exclusions: {args.exclude_case}'
    cases = [(name, case) for name, case in cases if name not in args.exclude_case]
    if args.exclude_case:
        print(f'Explicit historical API exclusions: {args.exclude_case}', flush=True)
    failed = 0
    for name, case in cases:
        try:
            observed = case()
        except Exception as error:
            print(f'FAIL {name}: {type(error).__name__}: {error}', flush=True)
            failed += 1
        else:
            print(f'PASS {name}: {json.dumps(observed, sort_keys=True)}', flush=True)
    print(f'SAFETY {"FAIL" if failed else "PASS"}: {len(cases) - failed}/{len(cases)}')
    return bool(failed)


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--worker':
        worker(Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4]), sys.argv[5])
    else:
        sys.exit(main())
