#!/usr/bin/env python3
"""Drive Houston's real checkout CLI; retain receipts outside disposable state."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import shlex
import signal
import stat
import subprocess
import tempfile


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def path_fingerprint(path):
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return 'MISSING'
    if stat.S_ISREG(mode):
        return 'file:' + hashlib.sha256(path.read_bytes()).hexdigest()
    if stat.S_ISLNK(mode):
        return 'symlink:' + os.readlink(path)
    if stat.S_ISDIR(mode):
        return 'directory'
    return f'special:{stat.S_IFMT(mode):o}'


def tree_manifest(root):
    return {'.': path_fingerprint(root), **{
        str(path.relative_to(root)): path_fingerprint(path)
        for path in sorted(root.rglob('*'), key=lambda item: str(item))
    }}


def regular_file(path):
    try:
        return stat.S_ISREG(path.lstat().st_mode)
    except FileNotFoundError:
        return False


def require_regular_file(path, message):
    require(regular_file(path), message)


def no_special_entries(root):
    entries = []
    for path in root.rglob('*'):
        mode = path.lstat().st_mode
        if not stat.S_ISDIR(mode) and not stat.S_ISREG(mode):
            entries.append(path)
    return entries


def no_synthetic_secret(secret, paths):
    for path in paths:
        require_regular_file(path, f'Expected retained regular file: {path}')
        require(secret.encode() not in path.read_bytes(), f'Synthetic secret leaked: {path.name}')


def require_unknown_panels(human, panels):
    for panel in panels:
        match = re.search(
            rf'^\+-\s*{re.escape(panel)}\b.*?(?=^\+-|\Z)',
            human,
            flags=re.IGNORECASE | re.MULTILINE | re.DOTALL,
        )
        require(match is not None, f'Human inspection omitted the {panel} panel')
        require(re.search(r'\bunknown\b', match.group(0), flags=re.IGNORECASE) is not None,
                f'Human inspection did not mark the {panel} panel unknown')


def yaml_document(node_exec, root, env, path):
    script = (
        'const fs=require("node:fs");'
        'const yaml=require(require.resolve("yaml",{paths:[process.argv[1]]}));'
        'process.stdout.write(JSON.stringify(yaml.parse(fs.readFileSync(process.argv[2],"utf8"))));'
    )
    result = subprocess.check_output(
        [str(node_exec), '-e', script, str(root), str(path)], cwd=root, env=env,
    )
    return json.loads(result)


def evidence_projection(value):
    projection = json.loads(json.dumps(value))
    projection.pop('bundle', None)
    projection.pop('generated_at', None)
    artifact = projection.get('artifact')
    if isinstance(artifact, dict):
        artifact.pop('sanitized', None)
    return projection


def receipt_paths(out, *labels):
    return [path for label in labels for path in (
        out / f'{label}.stdout', out / f'{label}.stderr',
    )]


def source_manifest(root):
    paths = subprocess.check_output(
        ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--',
         'src', 'bin', 'tools', 'data', 'package.json', 'yarn.lock', '.yarnrc.yml'], cwd=root)
    return {name: path_fingerprint(root / name)
            for name in sorted(set(paths.decode().split('\0'))) if name}


def candidate_fingerprint(root):
    return {
        'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
        'diff_sha256': hashlib.sha256(
            subprocess.check_output(['git', 'diff', 'HEAD'], cwd=root)).hexdigest(),
        'source': source_manifest(root),
    }


def bytes_from(value):
    if value is None:
        return b''
    if isinstance(value, bytes):
        return value
    return str(value).encode()


def stop_process_group(process, force=False):
    # Descendants can retain the output pipes after the CLI leader has exited.
    # Its session still needs termination in that case.
    if os.name != 'posix' and process.poll() is not None:
        return
    try:
        if os.name == 'posix':
            os.killpg(process.pid, signal.SIGKILL if force else signal.SIGTERM)
        elif force:
            process.kill()
        else:
            process.terminate()
    except ProcessLookupError:
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--evidence-dir', required=True, type=Path)
    parser.add_argument('--checkout', type=Path, help='Candidate checkout; defaults to this skill checkout')
    args = parser.parse_args()
    verifier_root = Path(__file__).resolve().parents[4]
    root = args.checkout.expanduser().resolve() if args.checkout else verifier_root
    require((root / 'bin' / 'houston').is_file(), 'Candidate checkout has no bin/houston')
    out = args.evidence_dir.expanduser().resolve()
    require(not out.is_relative_to(root) and not out.is_relative_to(verifier_root),
            'Evidence must be outside candidate and verifier checkouts')
    out.mkdir(parents=True, exist_ok=False)
    candidate_before = candidate_fingerprint(root)
    source_before = candidate_before['source']
    (out / 'candidate-source.json').write_text(json.dumps(source_before, indent=2) + '\n')
    (out / 'candidate-fingerprint-before.json').write_text(
        json.dumps(candidate_before, indent=2) + '\n')
    summary = {'head': candidate_before['head'],
               'diff_sha256': candidate_before['diff_sha256'],
               'checkout': str(root),
               'verifier_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
               'features': {}, 'boundary': 'Real checkout CLI; synthetic workspace; engine tools unavailable. No live runtime proof.'}
    scratch = Path(tempfile.mkdtemp(prefix='verify-houston-'))
    fixture_root = None
    fixture_before = None
    retained_bundle_files = []
    failure = None
    completed = False
    cleanup_errors = []
    try:
        # Only entry-point utilities can execute. No inherited credentials, engine socket,
        # kubeconfig, user home, proxy or ambient HOUSTON_* overrides reach the CLI.
        toolbin = scratch / 'bin'
        toolbin.mkdir()
        node_shim = shutil.which('node')
        require(node_shim is not None, 'Missing prerequisite: node')
        node_exec = Path(subprocess.check_output(
            [node_shim, '-p', 'process.execPath'], text=True).strip())
        require(node_exec.is_file(), 'Node did not expose its executable path')
        for tool in ('dirname', 'readlink'):
            executable = shutil.which(tool)
            require(executable is not None, f'Missing prerequisite: {tool}')
            (toolbin / tool).symlink_to(Path(executable).resolve())
        (toolbin / 'node').symlink_to(node_exec)
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
                  'admin_password': sentinel, 'extra': {'bind_host': '127.0.0.1', 'seed': {
                      'profile': 'standard', 'planned': {'users': 1, 'unrecognised': sentinel},
                      'actual': {'users': 1}, 'history': {'private': sentinel},
                      'locations': [sentinel], 'run_id': sentinel, 'unknown': sentinel}}}
        (workspace / 'repro.json').write_text(json.dumps(record))
        (workspace / 'docker-compose.yml').write_text(
            'services:\n  rocketchat:\n    image: rocketchat/rocket.chat:8.5.1\n'
            f'    environment:\n      ADMIN_PASS: {sentinel}\n'
            f'    command: echo {sentinel}\n    labels:\n      support-note: {sentinel}\n'
            f'      {sentinel}: neutral-value\n')
        kube_workspace = workspace.parent / 'verify-kube-fixture'
        kube_workspace.mkdir()
        kube_record = dict(record, name='verify-kube-fixture', project='houston-verify-kube-fixture',
                           extra={'runtime': 'kubernetes', 'context': 'verify-offline',
                                  'namespace': 'houston-verify-kube-fixture', 'bind_host': '127.0.0.1'})
        (kube_workspace / 'repro.json').write_text(json.dumps(kube_record))
        local_kube = workspace.parent / 'verify-owned-kube-fixture'
        local_kube.mkdir()
        (local_kube / 'repro.json').write_text(json.dumps(dict(kube_record,
            name=local_kube.name, extra={'runtime': 'kubernetes',
                'context': 'kind-houston-local', 'namespace': 'houston-verify-owned',
                'bind_host': '127.0.0.1'})))

        access_workspace = workspace.parent / 'verify-access-fixture'
        access_workspace.mkdir()
        access_record = dict(record, name=access_workspace.name,
                             project='houston-verify-access-fixture',
                             root_url='http://127.0.0.1:39999', admin_password='synthetic-access',
                             extra={'runtime': 'kubernetes', 'context': 'verify-offline',
                                    'namespace': access_workspace.name, 'bind_host': '127.0.0.1'})
        (access_workspace / 'repro.json').write_text(json.dumps(access_record))
        for name, bind, url, public_url, side_ports in [
                ('verify-ipv6-fixture', '::1', 'http://[::1]:39999',
                 'https://access.example.test', [4312, 4313]),
                ('verify-public-fixture', '0.0.0.0', 'http://192.0.2.40:39999', '', [])]:
            target = workspace.parent / name
            target.mkdir()
            (target / 'repro.json').write_text(json.dumps(dict(access_record, name=name, root_url=url,
                public_url=public_url,
                extra={'bind_host': bind, 'runtime': 'kubernetes', 'context': 'verify-offline',
                       'namespace': name, 'sidecar_ports': side_ports,
                       'monitoring_ports': [4314] if side_ports else []})))

        fixture_root = workspace.parent
        fixture_before = tree_manifest(fixture_root)
        (out / 'fixture-manifest-before.json').write_text(
            json.dumps(fixture_before, indent=2) + '\n')
        receipts = []

        def run(label, argv, expected=0, schema=None, ok=True, overrides=None, stdin=None):
            command = [str(root / 'bin' / 'houston'), *argv]
            child_env = dict(env, **(overrides or {}))
            process = subprocess.Popen(
                command,
                cwd=root,
                env=child_env,
                stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=os.name == 'posix',
            )
            timed_out = False
            try:
                stdout, stderr = process.communicate(input=stdin, timeout=60)
            except subprocess.TimeoutExpired:
                timed_out = True
                stop_process_group(process)
                try:
                    stdout, stderr = process.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    stop_process_group(process, force=True)
                    stdout, stderr = process.communicate()
            stdout = bytes_from(stdout)
            stderr = bytes_from(stderr)
            (out / f'{label}.stdout').write_bytes(stdout)
            (out / f'{label}.stderr').write_bytes(stderr)
            receipt = {'argv': ['bin/houston', *argv], 'exit': process.returncode}
            if timed_out:
                receipt.update({'timed_out': True, 'timeout_seconds': 60})
            receipts.append(receipt)
            (out / 'commands.json').write_text(json.dumps(receipts, indent=2) + '\n')
            require(not timed_out, f'{label}: timed out after 60 seconds')
            require(process.returncode == expected,
                    f'{label}: expected exit {expected}, got {process.returncode}')
            if schema is None:
                return stdout.decode().strip()
            lines = stdout.decode().splitlines()
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
        require(commands['info']['json'] and '--name' in commands['info']['flags']
                and commands['info'].get('schema') == 'houston.info.v1',
                'Missing or incompatible info contract')
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
                inspect_label = f'inspect-{runtime}'
                envelope = run(inspect_label, ['inspect', '--name', name, '--json'],
                               schema='houston.inspect.v1')
                no_synthetic_secret(sentinel, receipt_paths(out, inspect_label))
                data = envelope['data']
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
                    require(data['kubernetes']['cluster_exists'] is None,
                            'Unavailable Kind must leave cluster existence unknown')
                    warnings = data['kubernetes']['warnings']
                    require(isinstance(warnings, list) and bool(warnings)
                            and all(isinstance(warning, str) and warning for warning in warnings),
                            'Unavailable Kubernetes reads must report warnings')
                else:
                    warnings = data['docker']['warnings']
                    require(isinstance(warnings, list) and bool(warnings)
                            and all(isinstance(warning, str) and warning for warning in warnings),
                            'Unavailable Docker engine must report a warning')
                human_label = f'inspect-{runtime}-human'
                human = run(human_label, ['inspect', '--name', name])
                no_synthetic_secret(sentinel, receipt_paths(out, human_label))
                require_unknown_panels(
                    human,
                    ('nodes', 'services', 'pods') if runtime == 'kubernetes'
                    else ('containers', 'networks', 'volumes'),
                )
            summary['features']['inspect'] = 'PASS: offline Docker/Kubernetes shape and missing name; live resource reads pending'
        evidence = commands.get('evidence')
        if evidence is None:
            summary['features']['evidence'] = 'PENDING: command absent from capabilities'
        else:
            require(evidence['json'] and {'--name', '--bundle'}.issubset(evidence['flags'])
                    and evidence.get('schema') == 'houston.evidence.v1',
                    'Advertised evidence lacks required JSON/bundle contract; repair verifier against source')
            missing_evidence = run('evidence-missing', ['evidence', '--name', 'verify-missing', '--json'],
                                   expected=4, schema='houston.error.v1', ok=False)
            require(missing_evidence['error']['code'] == 'NOT_FOUND',
                    'Evidence missing name must be NOT_FOUND')
            payload = run('evidence-json', ['evidence', '--name', 'verify-fixture', '--json'],
                          schema='houston.evidence.v1')['data']
            no_synthetic_secret(sentinel, receipt_paths(out, 'evidence-json'))
            require(payload['repro']['root_url'] == 'http://127.0.0.1:39999', 'Evidence URL is not origin-only')
            require('login' not in payload and 'env' not in payload, 'Evidence contains private sections')
            expected_seed = {'profile': 'standard', 'planned': {'users': 1}, 'actual': {'users': 1}}
            expected_repro = {
                'name': 'verify-fixture', 'preset': 'default', 'runtime': 'docker',
                'deployment': 'monolith', 'rc_version': '8.5.1',
                'rc_image': 'rocketchat/rocket.chat:8.5.1', 'mongo_tag': '8.0',
                'mongo_flavor': 'mongodb', 'root_url': 'http://127.0.0.1:39999',
                'public_url': '', 'host_port': 39999, 'bind_host': '127.0.0.1',
                'version_source': 'synthetic', 'created_at': '2026-01-01T00:00:00+00:00',
            }
            require(payload.get('repro') == expected_repro,
                    'Evidence response diverges from the fixture identity')
            require(payload.get('seed') == expected_seed, 'Evidence seed projection differs from its allowlist')
            bundle = out / 'bundle'
            bundle_payload = run(
                'evidence-bundle', ['evidence', '--name', 'verify-fixture', '--bundle', str(bundle), '--json'],
                schema='houston.evidence.v1',
            )['data']
            no_synthetic_secret(sentinel, receipt_paths(out, 'evidence-bundle'))
            expected_bundle_files = ['README.md', 'docker-compose.yml', 'manifest.json']
            bundle_names = bundle_payload.get('bundle', {}).get('files')
            require(isinstance(bundle_names, list) and sorted(bundle_names) == expected_bundle_files,
                    'Bundle response listed an incomplete or stale file set')
            require(Path(bundle_payload['bundle']['path']).resolve() == bundle.resolve(),
                    'Bundle response named another destination')
            require(set(tree_manifest(bundle)) == {'.', *expected_bundle_files},
                    'Bundle must be a self-contained three-file attachment')
            require(not no_special_entries(bundle), 'Bundle contains a symlink or special entry')
            bundle_files = [bundle / name for name in expected_bundle_files]
            for file in bundle_files:
                require_regular_file(file, f'Missing regular bundle file: {file.name}')
            manifest = json.loads((bundle / 'manifest.json').read_text())
            require(manifest['repro']['name'] == 'verify-fixture', 'Bundle names another workspace')
            require(evidence_projection(payload) == evidence_projection(bundle_payload)
                    == evidence_projection(manifest),
                    'Bundle response or manifest diverges from the captured evidence projection')
            require(bundle_payload.get('repro') == expected_repro and manifest.get('repro') == expected_repro,
                    'Bundle response or manifest diverges from the fixture identity')
            require(bundle_payload.get('seed') == expected_seed and manifest.get('seed') == expected_seed,
                    'Bundle response or manifest expanded the seed projection')
            artifact = manifest['artifact']
            raw_hash = hashlib.sha256((workspace / 'docker-compose.yml').read_bytes()).hexdigest()
            for candidate in (payload, bundle_payload, manifest):
                require(candidate['artifact']['name'] == 'docker-compose.yml'
                        and candidate['artifact']['sha256'] == raw_hash,
                        'Evidence artifact identity differs from fixture bytes')
            sanitized = artifact['sanitized']
            require(sanitized['name'] == 'docker-compose.yml', 'Unexpected sanitized attachment name')
            attached_hash = hashlib.sha256((bundle / sanitized['name']).read_bytes()).hexdigest()
            require(sanitized['sha256'] == attached_hash and attached_hash != raw_hash,
                    'Sanitized attachment digest must match its bytes and differ from secret-bearing source')
            readme = (bundle / 'README.md').read_text()
            require('Workspace `verify-fixture`' in readme and 'Rocket.Chat 8.5.1' in readme
                    and 'http://127.0.0.1:39999' in readme,
                    'Bundle README lost workspace identity')
            compose = yaml_document(node_exec, root, env, bundle / 'docker-compose.yml')
            require(isinstance(compose, dict) and isinstance(compose.get('services'), dict),
                    'Sanitized Compose attachment is not a service document')
            rocketchat = compose['services'].get('rocketchat')
            require(isinstance(rocketchat, dict)
                    and rocketchat.get('image') == 'rocketchat/rocket.chat:8.5.1',
                    'Sanitized Compose attachment lost the Rocket.Chat service identity')
            environment = rocketchat.get('environment')
            labels = rocketchat.get('labels')
            require(isinstance(environment, dict) and 'ADMIN_PASS' in environment
                    and environment['ADMIN_PASS'] not in ('', sentinel)
                    and isinstance(labels, dict) and 'support-note' in labels
                    and sentinel not in str(rocketchat.get('command', '')),
                    'Sanitized Compose attachment is not semantically safe')
            no_synthetic_secret(sentinel, bundle_files)
            retained_bundle_files = [
                (file, hashlib.sha256(file.read_bytes()).hexdigest()) for file in bundle_files
            ]
            summary['features']['evidence'] = 'PASS: offline JSON, seed allowlist, sanitized bundle digests and sentinel checks; live runtime pending'
        capture = commands.get('capture')
        if capture is None:
            summary['features']['capture'] = 'PENDING: command absent from capabilities'
        else:
            require(capture['json'] and {'--name', '--workload', '--bundle'}.issubset(capture['flags'])
                    and capture.get('schema') == 'houston.capture.v1',
                    'Advertised capture differs from owner draft; reconcile contract before driving')
            absent_bundle = out / 'capture-missing-bundle'
            capture_marker = scratch / 'capture-browser-started'
            fake_playwright = scratch / 'fake-playwright.cjs'
            fake_playwright.write_text(
                'const fs=require("node:fs");\n'
                'module.exports={chromium:{launch:async()=>{'
                'fs.writeFileSync(process.env.VERIFY_CAPTURE_MARKER,"launch\\n");'
                'throw new Error("capture launched before workspace preflight");}}};\n'
            )
            capture_preload = scratch / 'capture-playwright-preload.cjs'
            capture_preload.write_text(
                'const Module=require("node:module");\n'
                'const original=Module._resolveFilename;\n'
                'Module._resolveFilename=function(request,parent,isMain,options){\n'
                ' if(request==="playwright"||request==="playwright-core") return process.env.VERIFY_CAPTURE_FAKE;\n'
                ' return original.call(this,request,parent,isMain,options);\n'
                '};\n'
            )
            absent = run('capture-missing', ['capture', '--name', 'verify-missing', '--workload', 'smoke',
                                          '--bundle', str(absent_bundle), '--json'],
                         expected=4, schema='houston.error.v1', ok=False,
                         overrides={'NODE_OPTIONS': f'--require={capture_preload}',
                                    'VERIFY_CAPTURE_MARKER': str(capture_marker),
                                    'VERIFY_CAPTURE_FAKE': str(fake_playwright)})
            require(absent['error']['code'] == 'NOT_FOUND', 'Capture missing name must be NOT_FOUND')
            require(not absent_bundle.exists() and not capture_marker.exists(),
                    'Missing workspace capture wrote a bundle or launched a browser')
            summary['features']['capture'] = 'PASS: missing workspace refused before bundle or browser launch; browser capture pending'
        detail = run('access-discovery', ['info', '--name', access_workspace.name, '--json'],
                     schema='houston.info.v1')['data']
        if 'access' not in detail:
            summary['features']['access'] = 'PENDING: info payload has no access consumer'
        else:
            local = detail['access']
            require(local['mode'] == 'local' and local['bind'] == 'loopback'
                    and local['host_port'] == 39999 and local['local_port'] == 39999
                    and local['browser_url'] == access_record['root_url']
                    and local['tunnel_command'] is None and local['note'] is None,
                    'Local access handoff differs from recorded workspace')
            local_human = run('access-local-human', ['info', '--name', access_workspace.name])
            no_synthetic_secret(sentinel, receipt_paths(out, 'access-discovery', 'access-local-human'))
            require(local['browser_url'] in local_human,
                    'Human local access guidance omitted the browser URL')
            ssh_values = {
                'SSH_CONNECTION': '198.51.100.20 55100 203.0.113.8 22',
                'SSH_CLIENT': '198.51.100.20 55100 22',
                'SSH_TTY': '/dev/pts/19',
            }

            def remote_access(label, marker, name=access_workspace.name, target='127.0.0.1',
                              port=39999, changes=None, sides=()):
                overrides = {
                    marker: ssh_values[marker],
                    'HOUSTON_SSH_USER': 'operator',
                    'HOUSTON_SSH_HOST': 'ssh-proof.invalid',
                    **(changes or {}),
                }
                data = run('access-' + label, ['info', '--name', name, '--json'],
                           schema='houston.info.v1', overrides=overrides)['data']['access']
                require(data['mode'] == 'remote_ssh' and data['bind'] == 'loopback'
                        and data['host_port'] == 39999 and data['local_port'] == port
                        and data['browser_url'] == f'http://127.0.0.1:{port}'
                        and data['side_ports'] == list(sides) and bool(data['note']),
                        'Remote access mode, ports or browser URL differ')
                expected_forwards = ['-L', f'127.0.0.1:{port}:{target}:39999']
                for side in sides:
                    expected_forwards.extend(['-L', f'127.0.0.1:{side}:{target}:{side}'])
                require(shlex.split(data['tunnel_command']) ==
                        ['ssh', '-N', '-o', 'ExitOnForwardFailure=yes', *expected_forwards, '--',
                         overrides['HOUSTON_SSH_USER'] + '@' + overrides['HOUSTON_SSH_HOST']],
                        'Tunnel must bind client loopback and preserve one option-safe destination')
                human = run('access-' + label + '-human', ['info', '--name', name], overrides=overrides)
                no_synthetic_secret(sentinel, receipt_paths(out, 'access-' + label,
                                                            'access-' + label + '-human'))
                require(data['tunnel_command'] in human and data['browser_url'] in human,
                        'Human access guidance differs from JSON')
            for marker in ssh_values:
                remote_access(marker.lower().replace('_', '-'), marker)
            remote_access('ipv6', 'SSH_CONNECTION', name='verify-ipv6-fixture', target='[::1]', port=4311, sides=(4312, 4313, 4314),
                          changes={'HOUSTON_SSH_LOCAL_PORT': '4311',
                                   'HOUSTON_SSH_USER': "operator's team",
                                   'HOUSTON_SSH_HOST': 'ssh-proof.invalid; echo unsafe'})
            collision = run('access-side-port-collision',
                            ['info', '--name', 'verify-ipv6-fixture', '--json'],
                            expected=2, schema='houston.error.v1', ok=False,
                            overrides={'SSH_TTY': ssh_values['SSH_TTY'],
                                       'HOUSTON_SSH_LOCAL_PORT': '4314'})
            require(collision['error']['code'] == 'VALIDATION_FAILED',
                    'A primary forward colliding with a monitoring port must refuse')
            remote_access('option', 'SSH_CONNECTION',
                          changes={'HOUSTON_SSH_USER': '-oProxyCommand=unsafe'})
            remote_access('minimum-port', 'SSH_CONNECTION', port=1024,
                          changes={'HOUSTON_SSH_LOCAL_PORT': '1024'})
            remote = {'SSH_CONNECTION': ssh_values['SSH_CONNECTION'],
                      'HOUSTON_SSH_USER': 'operator', 'HOUSTON_SSH_HOST': 'ssh-proof.invalid'}
            public = run('access-public', ['info', '--name', 'verify-public-fixture', '--json'],
                         schema='houston.info.v1', overrides=remote)['data']
            require(public['access'] is None, 'Wildcard workspace must not claim loopback access')
            for label, value in [('non-numeric', 'not-a-port'), ('negative', '-1'),
                                 ('below-minimum', '1023'), ('above-maximum', '65536')]:
                invalid = run('access-invalid-port-' + label, ['info', '--name', access_workspace.name, '--json'],
                              expected=2, schema='houston.error.v1', ok=False,
                              overrides=dict(remote, HOUSTON_SSH_LOCAL_PORT=value))
                require(invalid['error']['code'] == 'VALIDATION_FAILED',
                        f'Invalid local port {value} must be refused')
            summary['features']['access'] = ('PASS: local and each SSH-marker info JSON/human handoff, '
                'IPv6, option safety, local-port boundaries; no SSH executed')
        if 'onboard' not in commands:
            summary['features']['onboarding'] = 'PENDING: onboard command absent'
        else:
            # These answers belong only to this run's disposable home. Nothing here
            # grants authority in the operator's home or invokes an engine action.
            config_file = Path(env['HOUSTON_HOME']) / 'config.yaml'
            legacy = {'grants': {'engine_resize': False, 'clusters': ['preserved-cluster'],
                                 'future_grant': {'answer': 'preserve'}},
                      'onboarding': {'future_field': 'preserve'},
                      'preferences': {'retain_runs': False, 'seed_profile': 'small'},
                      'default_deployment': 'default', 'default_scenarios': [],
                      'future_config': {'nested': ['preserve']}}
            config_file.write_text(json.dumps(legacy))
            original = config_file.read_bytes()
            state = run('onboard-status', ['onboard', '--json'],
                        schema='houston.onboard.v1')['data']
            require(state['completed'] is False and state['grants']['owned_cluster'] is False
                    and state['answered_grants']['owned_cluster'] is False,
                    'Missing grant must remain unanswered')
            require(config_file.read_bytes() == original, 'Onboarding status rewrote config')
            # Satisfy executable discovery with a trap, never an actual cluster client.
            # Either authority refusal must happen before the trap is invoked.
            trap_called = scratch / 'kubectl-was-invoked'
            kubectl_trap = toolbin / 'kubectl'
            kubectl_trap.write_text('#!/bin/sh\nprintf attempted > '
                                    + shlex.quote(str(trap_called)) + '\nexit 97\n')
            kubectl_trap.chmod(0o700)
            refused = run('onboard-teardown-unanswered',
                          ['down', '--name', local_kube.name, '--yes', '--json'],
                          expected=6, schema='houston.error.v1', ok=False)
            require(refused['error']['code'] == 'GATE_NOT_ONBOARDED'
                    and refused['error']['gate']['approve_with'] == 'houston onboard'
                    and not trap_called.exists() and config_file.read_bytes() == original,
                    'Local teardown must refuse an unanswered machine before cluster invocation')

            invalid = run('onboard-invalid', ['onboard', 'grant', 'verify-unknown', '--json'],
                          expected=2, schema='houston.error.v1', ok=False)
            require(invalid['error']['code'] == 'VALIDATION_FAILED'
                    and config_file.read_bytes() == original,
                    'Unknown grant must refuse without writing config')
            granted = run('onboard-grant', ['onboard', 'grant', 'owned-cluster', '--json'],
                          schema='houston.onboard.v1')['data']
            require(granted['completed'] is True and granted['grants']['owned_cluster'] is True
                    and granted['answered_grants']['owned_cluster'] is True
                    and granted['clusters'] == ['preserved-cluster', 'houston-local']
                    and granted['rc_repro_version'] == version,
                    'Grant must persist one scoped answer and the running version')
            repeated = run('onboard-grant-status', ['onboard', '--json'],
                           schema='houston.onboard.v1')['data']
            require(all(repeated[key] == granted[key] for key in
                        ('completed', 'completed_at', 'grants', 'answered_grants', 'clusters')),
                    'Grant did not survive a separate CLI process')
            revoked = run('onboard-revoke', ['onboard', 'revoke', 'owned-cluster', '--json'],
                          schema='houston.onboard.v1')['data']
            require(revoked['grants']['owned_cluster'] is False
                    and revoked['answered_grants']['owned_cluster'] is True
                    and revoked['clusters'] == ['preserved-cluster']
                    and revoked['completed_at'] == granted['completed_at'],
                    'Revoke must record a denial and remove only the owned cluster scope')
            denied_config = config_file.read_bytes()
            denied = run('onboard-teardown-denied',
                         ['down', '--name', local_kube.name, '--yes', '--json'],
                         expected=6, schema='houston.error.v1', ok=False)
            require(denied['error']['code'] == 'GATE_OWNED_CLUSTER'
                    and denied['error']['gate']['approve_with'] == 'houston onboard grant owned-cluster'
                    and not trap_called.exists() and config_file.read_bytes() == denied_config,
                    'Local teardown must refuse a denied grant before cluster invocation')

            # Read the actual YAML written by the CLI using its existing dependency.
            # This does not import application onboarding logic to produce expectations.
            persisted = yaml_document(node_exec, root, env, config_file)
            require(all(persisted[key] == legacy[key] for key in
                        ('preferences', 'default_deployment', 'default_scenarios', 'future_config'))
                    and persisted['grants']['engine_resize'] is False
                    and persisted['grants']['future_grant'] == legacy['grants']['future_grant']
                    and persisted['onboarding']['future_field'] == 'preserve'
                    and persisted['grants']['owned_cluster'] is False
                    and persisted['grants']['clusters'] == ['preserved-cluster']
                    and persisted['onboarding']['completed_at'] == revoked['completed_at']
                    and persisted['onboarding']['rc_repro_version'] == version,
                    'Onboarding failed to persist the revoked grant state or legacy fields')
            (out / 'onboarding-persisted.json').write_text(json.dumps(persisted, indent=2) + '\n')
            summary['features']['onboarding'] = (
                'PASS: synthetic-home status, invalid grant, grant/revoke persistence and '
                'legacy preservation and local teardown authority refusals; live engine pending')
        if 'onboard' in commands and '--show' in commands['onboard']['flags']:
            config_file = Path(env['HOUSTON_HOME']) / 'config.yaml'
            setup_before = config_file.read_bytes()
            shown = run('setup-show', ['onboard', 'setup', '--show', '--json'],
                        schema='houston.onboard.v1')['data']
            require(shown['schema'] == 'houston.setup.v1'
                    and shown['selection']['deployment'] == 'monolith'
                    and shown['persisted']['grants']['owned_cluster'] is False
                    and shown['actions'] == [], 'Setup preview lost saved answers or offers actions')
            require(config_file.read_bytes() == setup_before, 'Setup preview wrote answers')
            for label, args in [('empty', []), ('invalid', ['--deployment', 'not-a-deployment']),
                                ('show-write', ['--show', '--seed-profile', 'none'])]:
                refused = run('setup-' + label, ['onboard', 'setup', *args, '--json'],
                              expected=2, schema='houston.error.v1', ok=False)
                require(refused['error']['code'] == 'VALIDATION_FAILED'
                        and config_file.read_bytes() == setup_before,
                        'Invalid or ambiguous setup must refuse without writing')
            saved = run('setup-save', ['onboard', 'setup', '--deployment', 'microservices',
                        '--scenario', 'none', '--seed-profile', 'none', '--retain-runs', '--json'],
                        schema='houston.onboard.v1')['data']
            require(saved['selection']['deployment'] == 'microservices'
                    and saved['selection']['scenarios'] == []
                    and saved['selection']['seed_profile'] == 'none'
                    and saved['selection']['retain_runs'] is True
                    and saved['persisted']['grants']['owned_cluster'] is False
                    and saved['capacity']['supported_action'] is None
                    and saved['actions'] == []
                    and '--runtime kubernetes' in saved['first_run_command']
                    and '--seed' not in saved['first_run_command'],
                    'Setup failed to persist explicit choices or changed authority')
            after = config_file.read_bytes()
            repeated = run('setup-readback', ['onboard', '--show', '--json'],
                           schema='houston.onboard.v1')['data']
            require(repeated['selection'] == saved['selection']
                    and config_file.read_bytes() == after, 'Setup choices did not survive process exit')
            defaults = run('setup-defaults', ['onboard', '--accept-defaults', '--json'],
                           schema='houston.onboard.v1')['data']
            require(defaults['selection'] == saved['selection']
                    and defaults['persisted']['grants']['owned_cluster'] is False,
                    'Accepting defaults overwrote answered choices or granted authority')
            human = run('setup-human', ['onboard', '--show'])
            require('microservices' in human and 'GATE_OWNED_CLUSTER' in human,
                    'Human setup omitted selected deployment or authority gate')
            persisted_setup = yaml_document(node_exec, root, env, config_file)
            require(persisted_setup['future_config'] == legacy['future_config']
                    and persisted_setup['grants']['future_grant'] == legacy['grants']['future_grant']
                    and persisted_setup['grants']['engine_resize'] is False
                    and persisted_setup['onboarding']['future_field'] == 'preserve',
                    'Setup discarded unrelated legacy fields')
            (out / 'setup-persisted.json').write_text(json.dumps(persisted_setup, indent=2) + '\n')
            before_prompt = config_file.read_bytes()
            cancelled = run('setup-prompt-cancel', ['onboard', 'setup', '--reconfigure', '--section', 'seed'],
                            stdin=b'large\nno\n')
            require('No changes written.' in cancelled and config_file.read_bytes() == before_prompt,
                    'Cancelled setup prompt persisted a draft')
            accepted = run('setup-prompt-accept', ['onboard', 'setup', '--reconfigure', '--section', 'seed'],
                           stdin=b'small\nyes\n')
            prompt_saved = run('setup-prompt-readback', ['onboard', '--show', '--json'],
                               schema='houston.onboard.v1')['data']
            require('Setup choices recorded.' in accepted
                    and prompt_saved['selection']['seed_profile'] == 'small'
                    and prompt_saved['selection']['retain_runs'] is True
                    and prompt_saved['persisted']['grants']['owned_cluster'] is False,
                    'Interactive section setup lost the accepted answer or unrelated state')
            summary['features']['setup'] = ('PASS: real CLI preview, explicit choices, readback, '
                'safe defaults, no-write refusals, prompts and legacy preservation; API and live engine pending')
        else:
            summary['features']['setup'] = 'PENDING: setup flags absent from onboard capabilities'
        completed = True
    except Exception as error:
        failure = error
        summary['error'] = str(error)
    finally:
        try:
            candidate_after = candidate_fingerprint(root)
            (out / 'candidate-fingerprint-after.json').write_text(
                json.dumps(candidate_after, indent=2) + '\n')
            summary['candidate_unchanged'] = candidate_after == candidate_before
            summary['source_unchanged'] = candidate_after['source'] == source_before
            if candidate_after != candidate_before:
                cleanup_errors.append('Candidate fingerprint changed during verification')
        except Exception as error:
            cleanup_errors.append(f'Could not record the final candidate fingerprint: {error}')
        if fixture_root is not None and fixture_before is not None:
            try:
                fixture_after = tree_manifest(fixture_root)
                (out / 'fixture-manifest-after.json').write_text(
                    json.dumps(fixture_after, indent=2) + '\n')
                summary['fixture_unchanged'] = fixture_after == fixture_before
                if fixture_after != fixture_before:
                    cleanup_errors.append('Synthetic fixture manifest changed during verification')
            except Exception as error:
                cleanup_errors.append(f'Could not record the final fixture manifest: {error}')
        else:
            summary['fixture_unchanged'] = None
        try:
            shutil.rmtree(scratch)
        except Exception as error:
            cleanup_errors.append(f'Could not remove verifier scratch: {error}')
        summary['scratch_removed'] = not scratch.exists()
        if not summary['scratch_removed']:
            cleanup_errors.append('Verifier scratch remains after cleanup')
        for file, digest in retained_bundle_files:
            try:
                require_regular_file(file, f'Retained bundle attachment is not a regular file: {file.name}')
                require(hashlib.sha256(file.read_bytes()).hexdigest() == digest,
                        f'Retained bundle attachment changed after cleanup: {file.name}')
            except Exception as error:
                cleanup_errors.append(str(error))
        if cleanup_errors:
            summary['cleanup_errors'] = cleanup_errors
            if failure is None:
                failure = RuntimeError('; '.join(cleanup_errors))
            summary['error'] = str(failure)
        summary['result'] = 'PASS_SCOPED' if failure is None and completed else 'FAIL'
        try:
            (out / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
            files = {str(path.relative_to(out)): hashlib.sha256(path.read_bytes()).hexdigest()
                     for path in out.rglob('*') if regular_file(path)}
            (out / 'sha256.json').write_text(json.dumps(files, indent=2) + '\n')
            for name, digest in files.items():
                require_regular_file(out / name, f'Evidence entry disappeared after cleanup: {name}')
                require(hashlib.sha256((out / name).read_bytes()).hexdigest() == digest,
                        f'Evidence unreadable after cleanup: {name}')
        except Exception as error:
            if failure is None:
                failure = error
            cleanup_errors.append(f'Could not retain or re-read verification evidence: {error}')
            summary['result'] = 'FAIL'
            summary['error'] = str(failure)
            summary['cleanup_errors'] = cleanup_errors
            (out / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
        print(out / 'summary.json')
    if failure is not None:
        raise failure


if __name__ == '__main__':
    main()
