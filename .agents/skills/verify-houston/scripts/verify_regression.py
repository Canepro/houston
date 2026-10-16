#!/usr/bin/env python3
"""Focused regression for verifier gates that synthetic candidates can skip.

On the pre-repair script this binds to the old gates. Those gates accept a
dangling capture-missing-bundle symlink, a retained secret outside the bundle
trio and command receipts, a revoked onboarding record with completed false,
a symlink or special file beside the bundle, a secret left outside the
retained tree, access shown only on the Docker fixture, and an access
discovery payload whose data is null or a string. They also accept a
non-regular summary or hash manifest, an evidence root replaced by a
symlink, missing before-state provenance, a non-string ADMIN_PASS, and a
sentinel scan that has not proved a chunk boundary. After each repair, the
same cases call the predicates main uses.
"""
import hashlib
import importlib.util
import json
import os
import socket
import sys
import tempfile
import threading
from pathlib import Path


SECRET = 'VERIFY_SYNTHETIC_SECRET_59c8'
CAPTURE_MESSAGE = 'Missing workspace capture wrote a bundle or launched a browser'
SECRET_MESSAGE = 'Synthetic secret leaked'
ONBOARD_MESSAGE = 'Onboarding failed to persist the revoked grant state or legacy fields'
SPECIAL_MESSAGE = 'Retained output contains a symlink or special entry'
ACCESS_MESSAGE = 'Access payload is omitted'
ACCESS_OBJECT_MESSAGE = 'Access discovery payload for'
RECEIPT_MESSAGE = 'Refused pre-existing non-regular receipt path'
EVIDENCE_DIRECTORY_MESSAGE = 'Evidence directory must be a real directory'
PROVENANCE_MESSAGE = 'Mandatory provenance artifact is not a regular file'
COMPOSE_MESSAGE = 'Sanitized Compose attachment is not semantically safe'
PROVENANCE_NAMES = (
    'candidate-source.json',
    'candidate-fingerprint-before.json',
    'fixture-manifest-before.json',
)
RECEIPT_TIMEOUT_SECONDS = 3
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


def onboarding_owner():
    if hasattr(verify, 'require_revoked_onboarding_persisted'):
        return 'require_revoked_onboarding_persisted'
    return 'pre-repair completed_at and rc_repro_version only'


def onboarding_persisted(completed):
    persisted = json.loads(json.dumps(ONBOARD_LEGACY))
    persisted['grants']['owned_cluster'] = False
    persisted['onboarding']['completed'] = completed
    persisted['onboarding']['completed_at'] = ONBOARD_COMPLETED_AT
    persisted['onboarding']['rc_repro_version'] = ONBOARD_VERSION
    return persisted


def check_revoked_onboarding(persisted):
    if hasattr(verify, 'require_revoked_onboarding_persisted'):
        verify.require_revoked_onboarding_persisted(
            persisted, ONBOARD_COMPLETED_AT, ONBOARD_VERSION, ONBOARD_LEGACY)
        return
    legacy = ONBOARD_LEGACY
    verify.require(all(persisted[key] == legacy[key] for key in
                       ('preferences', 'default_deployment', 'default_scenarios', 'future_config'))
                   and persisted['grants']['engine_resize'] is False
                   and persisted['grants']['future_grant'] == legacy['grants']['future_grant']
                   and persisted['onboarding']['future_field'] == 'preserve'
                   and persisted['grants']['owned_cluster'] is False
                   and persisted['grants']['clusters'] == ['preserved-cluster']
                   and persisted['onboarding']['completed_at'] == ONBOARD_COMPLETED_AT
                   and persisted['onboarding']['rc_repro_version'] == ONBOARD_VERSION,
                   ONBOARD_MESSAGE)


def onboarding_cases(results):
    def persisted(completed):
        def run():
            check_revoked_onboarding(onboarding_persisted(completed))
        return run

    run_case(results, 'onboarding completed true', persisted(True), 'allow', ONBOARD_MESSAGE)
    run_case(results, 'onboarding completed false', persisted(False), 'refuse', ONBOARD_MESSAGE)


def retained_tree_owner():
    if hasattr(verify, 'require_no_special_retained_entries'):
        return 'require_no_special_retained_entries'
    return 'pre-repair retained regular files only'


def scan_output_tree(secret, root):
    if hasattr(verify, 'require_no_special_retained_entries'):
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


def candidate_temp_owner():
    if hasattr(verify, 'bind_candidate_temp') and hasattr(verify, 'scan_candidate_temp'):
        return 'bind_candidate_temp and scan_candidate_temp'
    return 'pre-repair retained tree only'


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
        if hasattr(verify, 'bind_candidate_temp') and hasattr(verify, 'scan_candidate_temp'):
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
            return
        outside = root / 'system-tmp'
        outside.mkdir()
        if leaked:
            (outside / 'leak.txt').write_text(f'leaked {SECRET}\n')
        verify.scan_retained_regular_files(SECRET, out)


def candidate_temp_cases(results):
    run_case(results, 'candidate temp clean', lambda: check_candidate_temp(False),
             'allow', SECRET_MESSAGE)
    run_case(results, 'candidate temp secret', lambda: check_candidate_temp(True),
             'refuse', SECRET_MESSAGE)


def access_owner():
    if hasattr(verify, 'access_supported'):
        return 'access_supported'
    return 'pre-repair kubernetes discovery only'


def access_gate(payloads):
    if hasattr(verify, 'access_supported'):
        return verify.access_supported(payloads)
    kube = dict(payloads)['kubernetes']
    if isinstance(kube, dict) and 'access' in kube:
        return True
    return False


def access_payload(present):
    if present:
        return {'name': 'fixture', 'access': {'mode': 'local', 'bind': 'loopback'}}
    return {'name': 'fixture'}


def access_cases(results):
    def pending():
        result = access_gate([
            ('docker', access_payload(False)),
            ('kubernetes', access_payload(False)),
        ])
        verify.require(result is False, 'expected access to stay pending')

    def both():
        result = access_gate([
            ('docker', access_payload(True)),
            ('kubernetes', access_payload(True)),
        ])
        verify.require(result is True,
                       'expected the access contract for both loopback runtimes')

    def split(missing):
        def run():
            access_gate([
                ('docker', access_payload(missing != 'docker')),
                ('kubernetes', access_payload(missing != 'kubernetes')),
            ])
        return run

    def malformed(payloads):
        def run():
            access_gate(payloads)
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


def call_bounded(fn, timeout):
    outcome = {}

    def invoke():
        try:
            fn()
        except Exception as error:
            outcome['error'] = error
        outcome['done'] = True

    worker = threading.Thread(target=invoke, daemon=True)
    worker.start()
    worker.join(timeout)
    if not outcome.get('done'):
        raise RuntimeError('receipt write hung')
    if 'error' in outcome:
        raise outcome['error']


def receipt_owner():
    if hasattr(verify, 'write_verification_receipts'):
        return 'write_verification_receipts'
    return 'pre-repair summary write_text'


def receipt_cases(results):
    def plant(kind, name):
        def run():
            holder = None
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                evidence = root / 'evidence'
                evidence.mkdir()
                outside = root / 'outside-target'
                outside.write_bytes(b'untouched\n')
                target = evidence / name
                if kind == 'symlink':
                    target.symlink_to(outside)
                elif kind == 'fifo':
                    os.mkfifo(target)
                elif kind == 'socket':
                    holder = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                    holder.bind(str(target))
                elif kind == 'directory':
                    target.mkdir()
                    (target / 'marker.txt').write_bytes(b'keep\n')
                    # A descent would fail. lstat does not need read permission.
                    if hasattr(verify, 'write_verification_receipts'):
                        os.chmod(target, 0)
                else:
                    raise RuntimeError(f'unknown receipt fixture {kind}')
                error = None
                try:
                    def invoke():
                        # The pre-repair write_text opens the entry. Do not open it here:
                        # a FIFO would block and a symlink would write outside the tree.
                        if not hasattr(verify, 'write_verification_receipts'):
                            return
                        verify.write_verification_receipts(evidence, {'result': 'PASS_SCOPED'})
                    call_bounded(invoke, RECEIPT_TIMEOUT_SECONDS)
                except Exception as caught:
                    error = caught
                finally:
                    if holder is not None:
                        holder.close()
                    if kind == 'directory' and hasattr(verify, 'write_verification_receipts'):
                        os.chmod(target, 0o755)
                if kind == 'symlink':
                    verify.require(outside.read_bytes() == b'untouched\n',
                                   'symlink receipt wrote outside the evidence tree')
                if kind == 'directory':
                    verify.require((target / 'marker.txt').read_bytes() == b'keep\n',
                                   'directory receipt was opened')
                    verify.require(target.is_dir() and not target.is_symlink(),
                                   'directory receipt was replaced')
                if hasattr(verify, 'write_verification_receipts'):
                    summary_file = evidence / 'summary.json'
                    if kind == 'directory' and name == 'summary.json':
                        summary_file = next(evidence.glob('summary.json.refused.*'), None)
                    verify.require(summary_file is not None and verify.regular_file(summary_file),
                                   'failure summary was not a regular file inside the evidence tree')
                    payload = json.loads(summary_file.read_text())
                    verify.require(payload.get('result') == 'FAIL',
                                   'failure summary still reports success')
                    if kind != 'directory':
                        verify.require(verify.regular_file(evidence / name),
                                       'non-regular receipt path was left in place')
                    else:
                        manifest = json.loads((evidence / 'sha256.json').read_text())
                        verify.require('summary.json/marker.txt' not in manifest,
                                       'directory receipt was opened')
                if error is not None:
                    raise error
        return run

    run_case(results, 'receipt summary symlink', plant('symlink', 'summary.json'),
             'refuse', RECEIPT_MESSAGE)
    run_case(results, 'receipt summary fifo', plant('fifo', 'summary.json'),
             'refuse', RECEIPT_MESSAGE)
    run_case(results, 'receipt summary socket', plant('socket', 'summary.json'),
             'refuse', RECEIPT_MESSAGE)
    run_case(results, 'receipt summary directory', plant('directory', 'summary.json'),
             'refuse', RECEIPT_MESSAGE)
    run_case(results, 'receipt manifest symlink', plant('symlink', 'sha256.json'),
             'refuse', RECEIPT_MESSAGE)


def evidence_directory_owner():
    if hasattr(verify, 'require_real_evidence_directory'):
        return 'require_real_evidence_directory'
    return 'pre-repair Path.is_dir'


def evidence_directory_cases(results):
    def replaced():
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            evidence = root / 'evidence'
            evidence.mkdir()
            other = root / 'other'
            other.mkdir()
            marker = other / 'marker.txt'
            marker.write_bytes(b'untouched\n')
            for name in PROVENANCE_NAMES:
                (other / name).write_text('{}\n')
            evidence.rename(root / 'evidence-real')
            link = root / 'evidence'
            link.symlink_to(other, target_is_directory=True)
            if hasattr(verify, 'write_verification_receipts'):
                write_error = None
                try:
                    verify.write_verification_receipts(link, {'result': 'PASS_SCOPED'})
                except Exception as caught:
                    write_error = caught
                if hasattr(verify, 'write_evidence_text'):
                    try:
                        verify.write_evidence_text(link, 'candidate-fingerprint-after.json', '{}\n')
                    except Exception as caught:
                        if write_error is None:
                            write_error = caught
                verify.require(marker.read_bytes() == b'untouched\n', EVIDENCE_DIRECTORY_MESSAGE)
                verify.require(not (other / 'summary.json').exists()
                               and not (other / 'sha256.json').exists()
                               and not (other / 'candidate-fingerprint-after.json').exists(),
                               EVIDENCE_DIRECTORY_MESSAGE)
                if write_error is not None:
                    raise write_error
            if hasattr(verify, 'require_real_evidence_directory'):
                verify.require_real_evidence_directory(link)
                return
            # is_dir follows the symlink and accepts the replacement root.
            verify.require(link.is_dir(), EVIDENCE_DIRECTORY_MESSAGE)

    run_case(results, 'evidence root symlink', replaced,
             'refuse', EVIDENCE_DIRECTORY_MESSAGE)


def provenance_owner():
    if hasattr(verify, 'require_provenance_receipts'):
        return 'require_provenance_receipts'
    return 'pre-repair command receipts only'


def provenance_cases(results):
    def plant(missing=None, symlink=None):
        def run():
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                for name in PROVENANCE_NAMES:
                    if name == missing:
                        continue
                    path = root / name
                    if name == symlink:
                        path.symlink_to('missing-provenance')
                    else:
                        path.write_text('{}\n')
                if hasattr(verify, 'require_provenance_receipts'):
                    verify.require_provenance_receipts(root)
        return run

    for name in PROVENANCE_NAMES:
        run_case(results, f'provenance missing {name}', plant(missing=name),
                 'refuse', PROVENANCE_MESSAGE)
    run_case(results, 'provenance symlink candidate-source.json',
             plant(symlink='candidate-source.json'), 'refuse', PROVENANCE_MESSAGE)


def compose_owner():
    if hasattr(verify, 'require_masked_admin_pass'):
        return 'require_masked_admin_pass'
    return 'pre-repair ADMIN_PASS not empty or sentinel'


def compose_cases(results):
    def check(value):
        def run():
            if hasattr(verify, 'require_masked_admin_pass'):
                verify.require_masked_admin_pass(value, SECRET)
                return
            verify.require(value not in ('', SECRET), COMPOSE_MESSAGE)
        return run

    run_case(results, 'admin pass null', check(None), 'refuse', COMPOSE_MESSAGE)
    run_case(results, 'admin pass mapping', check({'masked': True}), 'refuse', COMPOSE_MESSAGE)
    run_case(results, 'admin pass list', check(['masked']), 'refuse', COMPOSE_MESSAGE)
    run_case(results, 'admin pass integer', check(0), 'refuse', COMPOSE_MESSAGE)


def chunk_owner():
    if hasattr(verify, 'file_contains_secret') and hasattr(verify, 'hash_file'):
        return 'file_contains_secret and hash_file'
    return 'pre-repair read_bytes'


def chunk_cases(results):
    def straddle(tree):
        def run():
            # Whole-file read_bytes finds this sentinel without proving the overlap.
            if not hasattr(verify, 'file_contains_secret') or not hasattr(verify, 'hash_file'):
                return
            chunk = verify.SCAN_CHUNK_BYTES
            needle = SECRET.encode()
            start = chunk - (len(needle) - 1)
            data = b'A' * start + needle + b'B' * 16
            verify.require(needle not in data[:chunk] and needle not in data[chunk:],
                           'sentinel does not straddle the chunk boundary')
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                if tree == 'retained':
                    evidence = root / 'out'
                    evidence.mkdir()
                    leaked = evidence / 'leak.txt'
                    leaked.write_bytes(data)
                    verify.require(verify.hash_file(leaked) == hashlib.sha256(data).hexdigest(),
                                   'Incremental hash diverges')
                    verify.scan_retained_regular_files(SECRET, evidence)
                    return
                temp = root / 'candidate-tmp'
                temp.mkdir()
                leaked = temp / 'leak.txt'
                leaked.write_bytes(data)
                verify.require(verify.hash_file(leaked) == hashlib.sha256(data).hexdigest(),
                               'Incremental hash diverges')
                verify.scan_candidate_temp(SECRET, temp)
        return run

    run_case(results, 'chunk sentinel retained', straddle('retained'), 'refuse', SECRET_MESSAGE)
    run_case(results, 'chunk sentinel candidate temp', straddle('temp'), 'refuse', SECRET_MESSAGE)


def main():
    results = []
    print(f'capture owner: {capture_owner()}')
    print(f'secret owner: {secret_owner()}')
    print(f'onboarding owner: {onboarding_owner()}')
    print(f'retained tree owner: {retained_tree_owner()}')
    print(f'candidate temp owner: {candidate_temp_owner()}')
    print(f'access owner: {access_owner()}')
    print(f'receipt owner: {receipt_owner()}')
    print(f'evidence directory owner: {evidence_directory_owner()}')
    print(f'provenance owner: {provenance_owner()}')
    print(f'compose owner: {compose_owner()}')
    print(f'chunk owner: {chunk_owner()}')
    capture_cases(results)
    secret_cases(results)
    onboarding_cases(results)
    special_cases(results)
    candidate_temp_cases(results)
    access_cases(results)
    receipt_cases(results)
    evidence_directory_cases(results)
    provenance_cases(results)
    compose_cases(results)
    chunk_cases(results)
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
