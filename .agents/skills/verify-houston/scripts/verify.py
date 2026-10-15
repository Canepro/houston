#!/usr/bin/env python3
"""Drive Houston's real checkout CLI; retain receipts outside disposable state."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--evidence-dir', required=True, type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[4]
    out = args.evidence_dir.expanduser().resolve()
    require(not out.is_relative_to(root), 'Evidence must be outside the checkout')
    out.mkdir(parents=True, exist_ok=False)
    summary = {'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
               'diff_sha256': hashlib.sha256(subprocess.check_output(['git', 'diff', 'HEAD'], cwd=root)).hexdigest(),
               'features': {}, 'boundary': 'Real checkout CLI; synthetic workspace; engine tools unavailable. No live runtime proof.'}
    scratch = Path(tempfile.mkdtemp(prefix='verify-houston-'))
    try:
        # Only entry-point utilities can execute. No inherited credentials, engine socket,
        # kubeconfig, user home, proxy or ambient HOUSTON_* overrides reach the CLI.
        toolbin = scratch / 'bin'
        toolbin.mkdir()
        for tool in ('node', 'dirname', 'readlink'):
            executable = shutil.which(tool)
            require(executable is not None, f'Missing prerequisite: {tool}')
            (toolbin / tool).symlink_to(executable)
        env = {'PATH': str(toolbin), 'HOME': str(scratch / 'user'),
               'HOUSTON_HOME': str(scratch / 'home'),
               'HOUSTON_SKILL_HOME': str(scratch / 'skills'), 'NO_COLOR': '1', 'LANG': 'C.UTF-8'}
        Path(env['HOME']).mkdir()
        workspace = scratch / 'home' / 'repros' / 'verify-fixture'
        workspace.mkdir(parents=True)
        sentinel = 'VERIFY_SYNTHETIC_SECRET_59c8'
        record = {'name': 'verify-fixture', 'project': 'houston-verify-fixture',
                  'rc_version': '8.5.1', 'rc_image': 'rocketchat/rocket.chat',
                  'mongo_tag': '8.0', 'mongo_flavor': 'mongodb', 'preset': 'default',
                  'root_url': f'http://user:{sentinel}@127.0.0.1:39999/private?token={sentinel}',
                  'public_url': '', 'host_port': 39999, 'version_source': 'synthetic',
                  'created_at': '2026-01-01T00:00:00+00:00', 'pinned': False,
                  'admin_password': sentinel, 'extra': {'bind_host': '127.0.0.1'}}
        (workspace / 'repro.json').write_text(json.dumps(record))
        (workspace / 'docker-compose.yml').write_text(
            'services:\n  rocketchat:\n    image: rocketchat/rocket.chat:8.5.1\n'
            f'    environment:\n      ADMIN_PASS: {sentinel}\n')
        kube_workspace = workspace.parent / 'verify-kube-fixture'
        kube_workspace.mkdir()
        kube_record = dict(record, name='verify-kube-fixture', project='houston-verify-kube-fixture',
                           extra={'runtime': 'kubernetes', 'context': 'verify-offline',
                                  'namespace': 'houston-verify-kube-fixture', 'bind_host': '127.0.0.1'})
        (kube_workspace / 'repro.json').write_text(json.dumps(kube_record))

        def fixture_bytes():
            return {str(p.relative_to(workspace.parent)): p.read_bytes()
                    for p in workspace.parent.rglob('*') if p.is_file()}

        fixture_before = fixture_bytes()
        receipts = []

        def run(label, argv, expected=0, schema=None, ok=True):
            command = [str(root / 'bin' / 'houston'), *argv]
            result = subprocess.run(command, cwd=root, env=env, capture_output=True, timeout=60)
            (out / f'{label}.stdout').write_bytes(result.stdout)
            (out / f'{label}.stderr').write_bytes(result.stderr)
            receipt = {'argv': ['bin/houston', *argv], 'exit': result.returncode}
            receipts.append(receipt)
            (out / 'commands.json').write_text(json.dumps(receipts, indent=2) + '\n')
            require(result.returncode == expected, f'{label}: expected exit {expected}, got {result.returncode}')
            if schema is None:
                return result.stdout.decode().strip()
            lines = result.stdout.decode().splitlines()
            require(len(lines) == 1, f'{label}: expected exactly one JSON envelope')
            envelope = json.loads(lines[0])
            require(envelope.get('schema') == schema and envelope.get('contract') == 2,
                    f'{label}: unexpected schema or contract')
            require(envelope.get('ok') is ok, f'{label}: unexpected ok value')
            require(envelope.get('houston_version') == version, f'{label}: wrong build version')
            return envelope

        package = json.loads((root / 'package.json').read_text())
        version = package['version']
        require(run('version', ['--version']) == f'houston {version}', 'Version differs from package.json')
        caps = run('capabilities', ['capabilities'], schema='houston.capabilities.v1')['data']
        require(caps['houston_version'] == version and 2 in caps['contract_versions'], 'Capability version differs')
        commands = {c['name']: c for c in caps['commands']}
        require(commands['info']['json'] and '--name' in commands['info']['flags'], 'Missing info contract')
        require(caps['default_bind_host'] == '127.0.0.1', 'Unexpected default bind host')
        summary['features']['capabilities'] = 'PASS'
        missing = run('missing-workspace', ['info', '--name', 'verify-missing', '--json'],
                      expected=4, schema='houston.error.v1', ok=False)
        require(missing['error']['code'] == 'NOT_FOUND', 'Unknown workspace must be NOT_FOUND')
        summary['features']['missing-workspace'] = 'PASS'
        inspection = commands.get('inspect')
        if inspection is None:
            summary['features']['inspect'] = 'PENDING: command absent from capabilities'
        else:
            require(inspection['json'] and '--name' in inspection['flags']
                    and inspection.get('schema') == 'houston.inspect.v1',
                    'Advertised inspect differs from owner draft; reconcile contract before driving')
            missing_inspect = run('inspect-missing', ['inspect', '--name', 'verify-missing', '--json'],
                                  expected=4, schema='houston.error.v1', ok=False)
            require(missing_inspect['error']['code'] == 'NOT_FOUND', 'Inspect missing name must be NOT_FOUND')
            for name, runtime in [('verify-fixture', 'docker'), ('verify-kube-fixture', 'kubernetes')]:
                data = run(f'inspect-{runtime}', ['inspect', '--name', name, '--json'],
                           schema='houston.inspect.v1')['data']
                require(data['name'] == name and data['runtime'] == runtime, 'Inspect chose another workspace/runtime')
                require(data['url'] == 'http://127.0.0.1:39999' and data['bind_host'] == '127.0.0.1',
                        'Inspect URL or bind differs from fixture')
                require('login' not in data and 'env' not in data, 'Inspect contains private sections')
                require(all(data['kubernetes'][key] == [] for key in ('nodes', 'services', 'pods')),
                        'Offline inspect invented Kubernetes rows')
                require(all(data['docker'][key] == [] for key in ('containers', 'networks', 'volumes')),
                        'Offline inspect invented Docker rows')
                if runtime == 'kubernetes':
                    require(data['kubernetes']['context'] == 'verify-offline'
                            and data['kubernetes']['namespace'] == 'houston-verify-kube-fixture',
                            'Inspect lost Kubernetes scope')
                require(sentinel not in json.dumps(data), 'Inspect leaked synthetic secret')
            summary['features']['inspect'] = 'PASS: offline Docker/Kubernetes shape and missing name; live resource reads pending'
        evidence = commands.get('evidence')
        if evidence is None:
            summary['features']['evidence'] = 'PENDING: command absent from capabilities'
        else:
            require(evidence['json'] and {'--name', '--bundle'}.issubset(evidence['flags']),
                    'Advertised evidence lacks required JSON/bundle contract; repair verifier against source')
            payload = run('evidence-json', ['evidence', '--name', 'verify-fixture', '--json'],
                          schema='houston.evidence.v1')['data']
            require(payload['repro']['root_url'] == 'http://127.0.0.1:39999', 'Evidence URL is not origin-only')
            require('login' not in payload and 'env' not in payload, 'Evidence contains private sections')
            bundle = out / 'bundle'
            run('evidence-bundle', ['evidence', '--name', 'verify-fixture', '--bundle', str(bundle), '--json'],
                schema='houston.evidence.v1')
            for name in ('manifest.json', 'README.md'):
                require((bundle / name).is_file(), f'Missing bundle file: {name}')
            manifest = json.loads((bundle / 'manifest.json').read_text())
            require(manifest['repro']['name'] == 'verify-fixture', 'Bundle names another workspace')
            for file in [out / 'evidence-json.stdout', out / 'evidence-bundle.stdout', *bundle.rglob('*')]:
                if file.is_file():
                    require(sentinel.encode() not in file.read_bytes(), f'Synthetic secret leaked: {file.name}')
            summary['features']['evidence'] = 'PENDING: JSON and bundle sentinel checks passed; sanitized attachment contract and live logs pending'
        for feature, names in {'access': [],
                               'onboarding-capture': ['onboard', 'onboarding', 'capture']}.items():
            summary['features'][feature] = {
                'status': ('PENDING: SSH handoff consumer and environment contract not ported/settled'
                           if feature == 'access' else 'PENDING: feature recipe prerequisites required'),
                'advertised': sorted(c for c in commands if any(c == n or c.startswith(n + ' ') for n in names))}
        require(fixture_before == fixture_bytes(),
                'CLI changed the synthetic workspace files')
        summary['fixture_unchanged'] = True
        summary['result'] = 'PASS_SCOPED'
    except Exception as error:
        summary['result'] = 'FAIL'
        summary['error'] = str(error)
        raise
    finally:
        shutil.rmtree(scratch)
        summary['scratch_removed'] = not scratch.exists()
        (out / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
        files = {str(p.relative_to(out)): hashlib.sha256(p.read_bytes()).hexdigest()
                 for p in out.rglob('*') if p.is_file()}
        (out / 'sha256.json').write_text(json.dumps(files, indent=2) + '\n')
        for name, digest in files.items():
            require(hashlib.sha256((out / name).read_bytes()).hexdigest() == digest,
                    f'Evidence unreadable after cleanup: {name}')
        print(out / 'summary.json')


if __name__ == '__main__':
    main()
