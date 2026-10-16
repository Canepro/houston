#!/usr/bin/env python3
"""Focused regression for the capture bundle path and retained secret scan.

On the pre-repair script this binds to the old gates: Path.exists for the
capture destination, and the bundle trio plus command receipts for the secret.
Those gates accept a dangling capture-missing-bundle symlink and a retained
secret outside that set. After the repair, the same cases call the predicates
main uses.
"""
import importlib.util
import sys
import tempfile
from pathlib import Path


SECRET = 'VERIFY_SYNTHETIC_SECRET_59c8'
CAPTURE_MESSAGE = 'Missing workspace capture wrote a bundle or launched a browser'
SECRET_MESSAGE = 'Synthetic secret leaked'
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


def capture_owner():
    if hasattr(verify, 'require_absent_capture_bundle'):
        return 'require_absent_capture_bundle'
    return 'pre-repair Path.exists'


def check_capture(bundle, marker):
    if hasattr(verify, 'require_absent_capture_bundle'):
        verify.require_absent_capture_bundle(bundle, marker)
        return
    verify.require(not bundle.exists() and not marker.exists(), CAPTURE_MESSAGE)


def secret_owner():
    if hasattr(verify, 'scan_retained_regular_files'):
        return 'scan_retained_regular_files'
    return 'pre-repair bundle files and command receipts'


def scan_evidence(secret, root):
    if hasattr(verify, 'scan_retained_regular_files'):
        verify.scan_retained_regular_files(secret, root)
        return
    bundle_files = [root / 'bundle' / name
                    for name in ('README.md', 'docker-compose.yml', 'manifest.json')]
    verify.no_synthetic_secret(secret, bundle_files)
    verify.scan_command_receipts(secret, root)


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
            check_capture(root / 'capture-missing-bundle', root / 'capture-browser-started')

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
                check_capture(bundle, marker)
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
                scan_evidence(SECRET, root)
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


def main():
    results = []
    print(f'capture owner: {capture_owner()}')
    print(f'secret owner: {secret_owner()}')
    capture_cases(results)
    secret_cases(results)
    failed = False
    for name, status, detail in results:
        print(f'{status} {name}: {detail}')
        if status != 'PASS':
            failed = True
    if failed:
        print('REGRESSION FAIL')
        return 1
    print('REGRESSION PASS')
    return 0


if __name__ == '__main__':
    sys.exit(main())
