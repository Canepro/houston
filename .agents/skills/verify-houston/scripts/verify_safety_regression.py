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
            print('microservices GATE_OWNED_CLUSTER')
            sys.exit(0)
        emit('houston.onboard.v1', dict(schema='houston.setup.v1', selection=selection, persisted=config, actions=[], capacity=dict(supported_action=None), gates=[dict(code='GATE_OWNED_CLUSTER')], action='unchanged', first_run_command='houston up --version 8.5.1 --name fixture --wait'))
    completed = config['onboarding'].get('completed', False)
    emit('houston.onboard.v1', dict(completed=completed, completed_at=config['onboarding'].get('completed_at'), grants=dict(owned_cluster=config['grants'].get('owned_cluster', False)), answered_grants=dict(owned_cluster=completed), clusters=config['grants']['clusters'], rc_repro_version='9.9.9'))
if args[0] != 'info':
    raise RuntimeError(args)
if 'verify-kube-fixture' not in args and 'verify-fixture' not in args:
    if 'verify-access-fixture' in args:
        if attack.startswith('receipt:'):
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
    module.main()


def run_main_case(path, attack):
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
            f'OUTSIDE={str(outside)!r}\nOTHER={str(other)!r}\n' + STUB)
        stub.chmod(0o700)
        (candidate / 'package.json').write_text(
            '{"version":"9.9.9"}' + (' ' * (2 * 1024 * 1024) if attack == 'package-large' else ''))
        # The synthetic CLI writes JSON, a YAML subset. This parser dependency
        # supplies transport only; no receipt or finalizer logic is stubbed.
        yaml = candidate / 'node_modules/yaml'
        yaml.mkdir(parents=True)
        (yaml / 'index.js').write_text('exports.parse=JSON.parse;')
        environment = {
            'PATH': os.environ.get('PATH', os.defpath), 'HOME': str(base),
            'LANG': 'C.UTF-8', 'GIT_CONFIG_NOSYSTEM': '1',
            'GIT_CONFIG_GLOBAL': os.devnull,
        }
        for command in (
            ['git', 'init', '-q', str(candidate)],
            ['git', '-C', str(candidate), 'add', 'bin', 'package.json'],
            ['git', '-C', str(candidate), '-c', 'user.name=Verifier test',
             '-c', 'user.email=verifier@invalid', '-c', 'commit.gpgsign=false',
             '-c', f'core.hooksPath={os.devnull}', 'commit', '-qm', 'fixture'],
        ):
            subprocess.run(command, check=True, env=environment,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        command = [sys.executable, '-I', '-B', str(Path(__file__).resolve()),
                   '--worker', str(path.resolve()), str(candidate), str(out), attack]
        try:
            result = subprocess.run(command, capture_output=True, text=True,
                                    env=environment, timeout=12)
        except subprocess.TimeoutExpired as error:
            raise AssertionError(f'actual main timed out after 12s: {attack}') from error
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
        should_pass = (attack in ('clean', 'feature-clean', 'stdout-hardlink')
                       or attack.endswith(':hardlink'))
        assert (result.returncode == 0) == should_pass, f'exit={result.returncode}: {summary}'
        assert summary['result'] == ('PASS_SCOPED' if should_pass else 'FAIL'), summary
        assert summary['scratch_removed'] is True, summary
        observed = {
            'exit': result.returncode, 'printed_summary': str(summary_path),
            'result': summary['result'], 'scratch_removed': summary['scratch_removed'],
            'candidate_unchanged': summary['candidate_unchanged'],
            'fixture_unchanged': summary['fixture_unchanged'], 'outside_source_unchanged': True,
        }
        error = str(summary.get('cleanup_errors', '')) + str(summary.get('error', ''))
        if attack.startswith(('delete:', 'symlink:')):
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
    parser.add_argument('--case', action='append', help='Run an exact named scenario')
    parser.add_argument('--exclude-case', action='append', default=[],
                        help='Explicitly exclude an API unavailable on a historical revision')
    args = parser.parse_args()
    path = args.verify_source
    attacks = (
        'clean', 'root-symlink', 'summary-planted', 'no-summary',
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
    cases = [('main ' + attack, lambda attack=attack: run_main_case(path, attack))
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
