#!/usr/bin/env python3
"""Focused verifier regression plus actual-main safety scenarios.

Historical R9 proof uses verify_safety_regression.py --verify-source against
exact Git-extracted verifier files. Chunk overlap is a correctness check,
separate from the observed bounded-read tests in that suite.
"""
import importlib.util
import json
import os
import socket
import sys
import tempfile
from pathlib import Path


SECRET = 'VERIFY_SYNTHETIC_SECRET_59c8'
CAPTURE_MESSAGE = 'Missing workspace capture wrote a bundle or launched a browser'
SECRET_MESSAGE = 'Synthetic secret leaked'
ONBOARD_MESSAGE = 'Onboarding failed to persist the revoked grant state or legacy fields'
SPECIAL_MESSAGE = 'Retained output contains a symlink or special entry'
ACCESS_MESSAGE = 'Access payload is omitted'
ACCESS_OBJECT_MESSAGE = 'Access discovery payload for'
ONBOARD_COMPLETED_AT = '2026-01-02T00:00:00+00:00'
ONBOARD_VERSION = '9.9.9-test'
ONBOARD_LEGACY = {
    'grants': {
        'engine_resize': False,
        'clusters': ['preserved-cluster'],
        'future_grant': {'answer': 'preserve'},
    },
    'onboarding': {'future_field': 'preserve'},
    'preferences': {'retain_runs': False, 'seed_profile': 'small'},
    'default_deployment': 'default',
    'default_scenarios': [],
    'future_config': {'nested': ['preserve']},
}
EVIDENCE_FILES = (
    'bundle/README.md',
    'bundle/docker-compose.yml',
    'bundle/manifest.json',
    'bundle.tmp/docker-compose.yml',
    'notes/leak.txt',
    'capture-missing.stdout',
    'capture-missing.stderr',
)


def load_verify():
    path = Path(__file__).with_name('verify.py')
    spec = importlib.util.spec_from_file_location('verify_houston_r5b', path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f'Could not load {path}')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


verify = load_verify()


def run_case(results, name, fn, expect, text):
    try:
        fn()
    except Exception as error:
        if expect == 'refuse' and text in str(error):
            results.append((name, 'PASS', f'refused: {error}'))
        else:
            results.append((name, 'FAIL', f'unexpected: {type(error).__name__}: {error}'))
        return
    if expect == 'allow':
        results.append((name, 'PASS', 'allowed'))
    else:
        results.append((name, 'FAIL', 'accepted'))


def capture_cases(results):
    def missing():
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            verify.require_absent_capture_bundle(root / 'capture-missing-bundle', root / 'capture-browser-started')

    def plant(kind):
        def run():
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                bundle = root / 'capture-missing-bundle'
                marker = root / 'capture-browser-started'
                if kind == 'real-file':
                    bundle.write_text('bundle\n')
                elif kind == 'directory':
                    bundle.mkdir()
                elif kind == 'dangling-symlink':
                    bundle.symlink_to('missing-capture-target')
                elif kind == 'live-symlink':
                    target = root / 'real-capture-target'
                    target.write_text('target\n')
                    bundle.symlink_to(target)
                elif kind == 'marker-file':
                    marker.write_text('launch\n')
                else:
                    raise RuntimeError(f'unknown capture fixture {kind}')
                verify.require_absent_capture_bundle(bundle, marker)
        return run

    run_case(results, 'capture missing-path', missing, 'allow', CAPTURE_MESSAGE)
    run_case(results, 'capture real-file', plant('real-file'), 'refuse', CAPTURE_MESSAGE)
    run_case(results, 'capture directory', plant('directory'), 'refuse', CAPTURE_MESSAGE)
    run_case(results, 'capture dangling-symlink', plant('dangling-symlink'), 'refuse', CAPTURE_MESSAGE)
    run_case(results, 'capture live-symlink', plant('live-symlink'), 'refuse', CAPTURE_MESSAGE)
    run_case(results, 'capture marker-file', plant('marker-file'), 'refuse', CAPTURE_MESSAGE)


def evidence_tree(root, secret_at):
    for relative in EVIDENCE_FILES:
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        if relative == secret_at:
            path.write_text(f'leaked {SECRET}\n')
        else:
            path.write_text('clean\n')


def secret_cases(results):
    def scan(secret_at):
        def run():
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                evidence_tree(root, secret_at)
                verify.scan_retained_regular_files(SECRET, root)
        return run

    run_case(results, 'secret clean-tree', scan(None), 'allow', SECRET_MESSAGE)
    for relative in (
        'bundle/README.md',
        'bundle/docker-compose.yml',
        'bundle/manifest.json',
        'capture-missing.stdout',
        'capture-missing.stderr',
        'bundle.tmp/docker-compose.yml',
        'notes/leak.txt',
    ):
        run_case(results, f'secret {relative}', scan(relative), 'refuse', SECRET_MESSAGE)


def onboarding_persisted(completed):
    persisted = json.loads(json.dumps(ONBOARD_LEGACY))
    persisted['grants']['owned_cluster'] = False
    persisted['onboarding']['completed'] = completed
    persisted['onboarding']['completed_at'] = ONBOARD_COMPLETED_AT
    persisted['onboarding']['rc_repro_version'] = ONBOARD_VERSION
    return persisted


def check_revoked_onboarding(persisted):
    verify.require_revoked_onboarding_persisted(
        persisted, ONBOARD_COMPLETED_AT, ONBOARD_VERSION, ONBOARD_LEGACY)


def onboarding_cases(results):
    def persisted(completed):
        def run():
            check_revoked_onboarding(onboarding_persisted(completed))
        return run

    run_case(results, 'onboarding completed true', persisted(True), 'allow', ONBOARD_MESSAGE)
    run_case(results, 'onboarding completed false', persisted(False), 'refuse', ONBOARD_MESSAGE)


def scan_output_tree(secret, root):
    verify.require_no_special_retained_entries(root)
    verify.scan_retained_regular_files(secret, root)


def special_cases(results):
    def plant(kind):
        def run():
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                evidence_tree(root, None)
                stray = root / f'beside-bundle-{kind}'
                holder = None
                if kind == 'symlink':
                    stray.symlink_to('missing-beside-bundle')
                elif kind == 'fifo':
                    os.mkfifo(stray)
                elif kind == 'socket':
                    holder = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                    holder.bind(str(stray))
                else:
                    raise RuntimeError(f'unknown special fixture {kind}')
                try:
                    scan_output_tree(SECRET, root)
                finally:
                    if holder is not None:
                        holder.close()
        return run

    run_case(results, 'retained symlink', plant('symlink'), 'refuse', SPECIAL_MESSAGE)
    run_case(results, 'retained fifo', plant('fifo'), 'refuse', SPECIAL_MESSAGE)
    run_case(results, 'retained socket', plant('socket'), 'refuse', SPECIAL_MESSAGE)


def check_candidate_temp(leaked):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        scratch = root / 'scratch'
        out = root / 'out'
        scratch.mkdir()
        out.mkdir()
        (out / 'clean.txt').write_text('clean\n')
        env = {
            'PATH': 'bin',
            'HOME': str(scratch / 'user'),
            'HOUSTON_HOME': str(scratch / 'home'),
            'LANG': 'C.UTF-8',
        }
        bound = verify.bind_candidate_temp(env, scratch)
        temp = Path(bound['TMPDIR'])
        verify.require(bound.get('TMPDIR') == bound.get('TMP') == bound.get('TEMP') == str(temp),
                       'TMPDIR, TMP, and TEMP must share the scratch candidate temp')
        verify.require(temp.resolve().is_relative_to(scratch.resolve()),
                       'Candidate temp escaped scratch')
        if leaked:
            (temp / 'leak.txt').write_text(f'leaked {SECRET}\n')
        verify.scan_candidate_temp(SECRET, temp)
        verify.scan_retained_regular_files(SECRET, out)


def candidate_temp_cases(results):
    run_case(results, 'candidate temp clean', lambda: check_candidate_temp(False),
             'allow', SECRET_MESSAGE)
    run_case(results, 'candidate temp secret', lambda: check_candidate_temp(True),
             'refuse', SECRET_MESSAGE)


def access_payload(present):
    if present:
        return {'name': 'fixture', 'access': {'mode': 'local', 'bind': 'loopback'}}
    return {'name': 'fixture'}


def access_cases(results):
    def pending():
        result = verify.access_supported([
            ('docker', access_payload(False)),
            ('kubernetes', access_payload(False)),
        ])
        verify.require(result is False, 'expected access to stay pending')

    def both():
        result = verify.access_supported([
            ('docker', access_payload(True)),
            ('kubernetes', access_payload(True)),
        ])
        verify.require(result is True,
                       'expected the access contract for both loopback runtimes')

    def split(missing):
        def run():
            verify.access_supported([
                ('docker', access_payload(missing != 'docker')),
                ('kubernetes', access_payload(missing != 'kubernetes')),
            ])
        return run

    def malformed(payloads):
        def run():
            verify.access_supported(payloads)
        return run

    run_case(results, 'access neither fixture', pending, 'allow', ACCESS_MESSAGE)
    run_case(results, 'access both fixtures', both, 'allow', ACCESS_MESSAGE)
    run_case(results, 'access docker only', split('kubernetes'), 'refuse', ACCESS_MESSAGE)
    run_case(results, 'access kubernetes only', split('docker'), 'refuse', ACCESS_MESSAGE)
    run_case(results, 'access data null both',
             malformed([('docker', None), ('kubernetes', None)]),
             'refuse', f'{ACCESS_OBJECT_MESSAGE} docker, kubernetes is not an object')
    run_case(results, 'access data null one',
             malformed([('docker', access_payload(True)), ('kubernetes', None)]),
             'refuse', f'{ACCESS_OBJECT_MESSAGE} kubernetes is not an object')
    run_case(results, 'access data string both',
             malformed([('docker', 'loopback'), ('kubernetes', 'loopback')]),
             'refuse', f'{ACCESS_OBJECT_MESSAGE} docker, kubernetes is not an object')


def main():
    results = []
    capture_cases(results)
    secret_cases(results)
    onboarding_cases(results)
    special_cases(results)
    candidate_temp_cases(results)
    access_cases(results)
    failed = False
    for name, status, detail in results:
        print(f'{status} {name}: {detail}')
        if status != 'PASS':
            failed = True
    if failed:
        print('REGRESSION FAIL')
        return 1
    spec = importlib.util.spec_from_file_location(
        'verify_safety_regression', Path(__file__).with_name('verify_safety_regression.py'))
    safety = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(safety)
    if safety.main():
        return 1
    print('REGRESSION PASS')
    return 0


if __name__ == '__main__':
    sys.exit(main())
