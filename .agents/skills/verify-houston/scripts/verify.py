#!/usr/bin/env python3
"""Drive Houston's real checkout CLI; retain receipts outside disposable state."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import shlex
import signal
import selectors
import stat
import subprocess
import sys
import tempfile
import threading
import time


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


def path_absent(path):
    # lstat the directory entry. A dangling symlink is still an entry.
    try:
        path.lstat()
    except FileNotFoundError:
        return True
    return False


def require_absent_capture_bundle(bundle_path, marker_path):
    require(path_absent(bundle_path) and not marker_path.exists(),
            'Missing workspace capture wrote a bundle or launched a browser')


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


def retained_regular_files(root):
    paths = sorted(root.rglob('*'), key=lambda item: str(item.relative_to(root)))
    return [path for path in paths if regular_file(path)]


def scan_retained_regular_files(secret, root):
    no_synthetic_secret(secret, retained_regular_files(root))


def require_no_special_retained_entries(root):
    entries = no_special_entries(root)
    suffix = f': {entries[0].relative_to(root)}' if entries else ''
    require(not entries, 'Retained output contains a symlink or special entry' + suffix)


def bind_candidate_temp(env, scratch):
    temp = Path(scratch) / 'candidate-tmp'
    temp.mkdir()
    location = str(temp)
    bound = dict(env)
    bound['TMPDIR'] = location
    bound['TMP'] = location
    bound['TEMP'] = location
    return bound


def scan_candidate_temp(secret, temp):
    require(stat.S_ISDIR(temp.lstat().st_mode),
            f'Candidate temp directory is missing: {temp}')
    no_synthetic_secret(secret, retained_regular_files(temp))


def require_revoked_onboarding_persisted(persisted, completed_at, version, legacy):
    require(all(persisted[key] == legacy[key] for key in
                ('preferences', 'default_deployment', 'default_scenarios', 'future_config'))
            and persisted['grants']['engine_resize'] is False
            and persisted['grants']['future_grant'] == legacy['grants']['future_grant']
            and persisted['onboarding']['future_field'] == 'preserve'
            and persisted['grants']['owned_cluster'] is False
            and persisted['grants']['clusters'] == ['preserved-cluster']
            and persisted['onboarding']['completed_at'] == completed_at
            and persisted['onboarding']['rc_repro_version'] == version
            and persisted['onboarding']['completed'] is True,
            'Onboarding failed to persist the revoked grant state or legacy fields')


def access_supported(payloads):
    require(isinstance(payloads, list)
            and [runtime for runtime, _data in payloads] == ['docker', 'kubernetes'],
            'Access discovery must include the docker and kubernetes loopback fixtures')
    present = [runtime for runtime, data in payloads
               if isinstance(data, dict) and 'access' in data]
    missing = [runtime for runtime, data in payloads
               if not (isinstance(data, dict) and 'access' in data)]
    if not present:
        return False
    require(not missing, 'Access payload is omitted for ' + ', '.join(missing))
    return True


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


def require_command_contract(command, name, flags, schema):
    require(isinstance(command, dict) and command.get('json') is True
            and isinstance(command.get('flags'), list)
            and all(isinstance(flag, str) for flag in command['flags'])
            and set(flags).issubset(command['flags'])
            and command.get('schema') == schema,
            f'Advertised {name} lacks the required JSON/schema/string-array flags contract')


def require_saved_topology_command(command):
    message = 'Setup first-run command must use saved topology with valued --version/--name and --wait only'
    require(isinstance(command, str) and '\n' not in command and '\r' not in command, message)
    tokens = shlex.split(command)
    require(tokens[:2] == ['houston', 'up'], message)
    values = {}
    index = 2
    while index < len(tokens):
        option, attached, value = tokens[index].partition('=')
        require(option in ('--version', '--name', '--wait') and option not in values, message)
        if option == '--wait':
            require(not attached, message)
            values[option] = True
        else:
            if not attached:
                index += 1
                require(index < len(tokens), message)
                value = tokens[index]
            pattern = (r'[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?'
                       if option == '--version' else r'[A-Za-z0-9][A-Za-z0-9_.-]*')
            require(re.fullmatch(pattern, value) is not None, message)
            values[option] = value
        index += 1
    require(set(values) == {'--version', '--name', '--wait'}, message)


def require_setup_first_run(saved):
    command = saved.get('first_run_command')
    if command != '':
        require_saved_topology_command(command)
        return {'result': 'PASS', 'coverage': 'present command grammar'}
    message = 'Blank setup first-run command lacks matching runtime/tool/capacity blocker and readiness facts'
    environment = saved.get('environment', {})
    require(saved['selection']['deployment'] == 'microservices'
            and environment.get('microservices_ready') is False
            and environment.get('kubernetes_provisioning_available') is False, message)
    missing = environment.get('missing_kubernetes_tools')
    tools = environment.get('tools', {})
    require(isinstance(missing, list)
            and all(isinstance(tool, str) and tool in ('kubectl', 'helm') for tool in missing)
            and len(missing) == len(set(missing))
            and all(isinstance(tools.get(tool), bool) for tool in ('kubectl', 'helm', 'kind'))
            and set(missing) == {tool for tool in ('kubectl', 'helm') if tools[tool] is False}, message)
    state = environment.get('owned_kubernetes_runtime')
    require(state in ('ready', 'unavailable', 'unknown'), message)
    capacity = saved.get('capacity', {})
    values = [environment.get('engine_cpus'), environment.get('engine_memory_gib'),
              capacity.get('observed_cpu'), capacity.get('observed_memory_gib'),
              capacity.get('required_cpu'), capacity.get('required_memory_gib')]
    require(all(type(value) in (int, float) and math.isfinite(value) and value >= 0
                for value in values), message)
    cpu, memory, observed_cpu, observed_memory, required_cpu, required_memory = values
    # These are the committed setup consumer's engine floors, not host capacity.
    require(required_cpu == 4 and required_memory == 6
            and observed_cpu == cpu and observed_memory == memory
            and capacity.get('applicable') is True, message)
    known = cpu > 0 and memory > 0
    enough = known and cpu >= required_cpu and memory >= required_memory
    capacity_code = '' if enough else 'CAPACITY_BELOW_FLOOR' if known else 'CAPACITY_UNKNOWN'
    require(capacity.get('ready') is enough
            and capacity.get('status') == ('ready' if enough else 'below_floor' if known else 'unknown')
            and capacity.get('code') == capacity_code
            and not (state == 'ready' and not missing and enough)
            and not (tools['kind'] and not missing and enough), message)
    if missing:
        code, kind = 'KUBERNETES_TOOLS_MISSING', 'tools'
    elif state == 'ready':
        require(not enough, message)
        code, kind = capacity_code, 'capacity'
    else:
        code = 'OWNED_KUBERNETES_UNAVAILABLE' if state == 'unavailable' else 'OWNED_KUBERNETES_UNKNOWN'
        kind = 'runtime'
    require(any(gate.get('code') == code and gate.get('kind') == kind
                and isinstance(gate.get('message'), str) and gate['message'].strip()
                and gate.get('approve_with') == '' for gate in saved['gates']), message)
    return {'result': 'PASS', 'coverage': 'blocked command with matching facts', 'blocker': code}


def yaml_document(node_exec, root, env, path):
    script = (
        'const fs=require("node:fs");'
        'const yaml=require(require.resolve("yaml",{paths:[process.argv[1]]}));'
        'process.stdout.write(JSON.stringify(yaml.parse(fs.readFileSync(process.argv[2],"utf8"))));'
    )
    result = bounded_output(
        'YAML projection reader',
        [str(node_exec), '-e', script, str(root), str(path)],
        cwd=root,
        env=env,
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


def scan_command_receipts(secret, out, *labels):
    paths = receipt_paths(out, *labels) if labels else sorted(
        (path for path in out.iterdir() if path.name.endswith(('.stdout', '.stderr'))),
        key=lambda path: path.name,
    )
    require(paths, 'No command stdout/stderr receipts were retained')
    no_synthetic_secret(secret, paths)
    return paths


def git_evidence_context(root):
    """Bind read-only Git evidence to the requested checkout, not caller state."""
    root = root.resolve()
    executable = shutil.which('git')
    require(executable is not None, 'Missing prerequisite: git')
    git = Path(executable).resolve()
    require(git.is_file(), 'Git executable could not be resolved')
    environment = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    environment.update({
        # Do not let a caller pick another repository, config or diff driver.
        'GIT_CONFIG_GLOBAL': os.devnull,
        'GIT_CONFIG_NOSYSTEM': '1',
        'GIT_OPTIONAL_LOCKS': '0',
        'GIT_TERMINAL_PROMPT': '0',
    })
    context = {'root': root, 'git': str(git), 'env': environment}
    top_level_output = git_evidence_output(
        context,
        'candidate checkout lookup',
        ['rev-parse', '--show-toplevel'],
        text=True,
    )
    require(top_level_output.endswith('\n'), 'Git did not report a candidate repository root')
    top_level = top_level_output[:-1]
    require(Path(top_level).resolve() == root,
            'Git repository root does not match the requested candidate checkout')
    return context


def git_evidence_output(context, label, arguments, text=False):
    return bounded_output(
        label,
        [context['git'], '--no-pager', '-C', str(context['root']), *arguments],
        cwd=context['root'],
        env=context['env'],
        text=text,
    )


def source_manifest(context):
    root = context['root']
    paths = git_evidence_output(
        context,
        'candidate source manifest',
        ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--',
         'src', 'bin', 'tools', 'data', 'package.json', 'yarn.lock', '.yarnrc.yml'],
    )
    return {name: path_fingerprint(root / name)
            for name in sorted(set(paths.decode().split('\0'))) if name}


def candidate_fingerprint(root):
    context = git_evidence_context(root)
    return {
        'head': git_evidence_output(
            context,
            'candidate revision lookup',
            ['rev-parse', '--verify', 'HEAD'],
            text=True,
        ).strip(),
        'diff_sha256': hashlib.sha256(
            git_evidence_output(
                context,
                'candidate diff lookup',
                ['diff', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD'],
            ),
        ).hexdigest(),
        'source': source_manifest(context),
    }


def bytes_from(value):
    if value is None:
        return b''
    if isinstance(value, bytes):
        return value
    return str(value).encode()


COMMAND_TIMEOUT_SECONDS = 60
TERM_GRACE_SECONDS = 5
GROUP_CLEANUP_SECONDS = 5
PIPE_DRAIN_SECONDS = 5
POLL_SECONDS = 0.05
PIPE_READ_BYTES = 64 * 1024
COMMAND_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024
AUXILIARY_TIMEOUT_SECONDS = COMMAND_TIMEOUT_SECONDS


def require_unreaped_group_wait():
    require(all(hasattr(os, name) for name in ('waitid', 'WNOWAIT', 'WEXITED', 'WNOHANG', 'P_PID')),
            'POSIX process-group cleanup requires waitid with WNOWAIT')
    if sys.platform.startswith('linux'):
        proc = Path('/proc')
        require(proc.is_dir() and os.access(proc, os.R_OK | os.X_OK),
                'Linux process-group cleanup requires readable /proc process status')
    elif sys.platform != 'darwin':
        raise RuntimeError('POSIX process-group cleanup has no supported liveness probe on this platform')


def wait_for_exit_unreaped(process, timeout_seconds, drain=None):
    """Observe a POSIX child exit while keeping its leader PID reserved."""
    require_unreaped_group_wait()
    deadline = time.monotonic() + timeout_seconds
    while True:
        if drain is not None and drain.output_limit_exceeded:
            raise RuntimeError('Command output exceeded its retained byte limit')
        try:
            result = os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        except ChildProcessError as error:
            raise RuntimeError('Could not observe command leader without reaping it') from error
        if result is not None:
            return True
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        if drain is None:
            time.sleep(min(POLL_SECONDS, remaining))
        else:
            drain.read_for(min(POLL_SECONDS, remaining))


def require_process_group_deadline(deadline):
    if time.monotonic() >= deadline:
        raise RuntimeError('Command process-group confirmation exceeded its cleanup deadline')


def linux_group_has_live_members(pgid, deadline):
    """Inspect only Linux process state and group IDs; never retain a process listing."""
    require_process_group_deadline(deadline)
    try:
        # scandir stays lazy on every supported Python version.
        with os.scandir('/proc') as entries:
            while True:
                require_process_group_deadline(deadline)
                try:
                    entry = next(entries)
                except StopIteration:
                    require_process_group_deadline(deadline)
                    return False
                require_process_group_deadline(deadline)
                if not entry.name.isdecimal():
                    continue
                require_process_group_deadline(deadline)
                try:
                    status = (Path(entry.path) / 'stat').read_bytes()
                except FileNotFoundError:
                    require_process_group_deadline(deadline)
                    continue
                require_process_group_deadline(deadline)
                close = status.rfind(b')')
                fields = status[close + 1:].split() if close >= 0 else []
                if close < 0 or len(fields) < 3 or len(fields[0]) != 1:
                    raise RuntimeError('Could not parse Linux process status')
                try:
                    member_pgid = int(fields[2])
                except ValueError as error:
                    raise RuntimeError('Could not parse Linux process group') from error
                if member_pgid == pgid and fields[0] != b'Z':
                    return True
    except OSError as error:
        raise RuntimeError('Could not inspect Linux process status') from error


def group_has_live_members(pgid, leader_exited, deadline):
    require_process_group_deadline(deadline)
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError as error:
        # Darwin reports EPERM for a group containing only an unreaped zombie.
        # Keeping the leader unreaped holds this PGID against reuse, so after its
        # observed exit EPERM means no signalable member remains in this command's group.
        if leader_exited and sys.platform == 'darwin':
            return False
        raise RuntimeError('Process group became unsignalable before its leader exited') from error
    if leader_exited and sys.platform.startswith('linux'):
        return linux_group_has_live_members(pgid, deadline)
    return True


def signal_process_group(pgid, signum, leader_exited):
    try:
        os.killpg(pgid, signum)
    except ProcessLookupError:
        return
    except PermissionError as error:
        if leader_exited and sys.platform == 'darwin':
            return
        raise RuntimeError('Could not signal a live command process group') from error


def force_and_confirm_process_group(process, pgid, leader_exited, drain):
    """Kill the verifier command group before reaping its leader and reusing its PGID."""
    errors = []
    try:
        signal_process_group(pgid, signal.SIGKILL, leader_exited)
    except Exception as error:
        errors.append(f'Could not force command process group: {error}')
    deadline = time.monotonic() + GROUP_CLEANUP_SECONDS
    while True:
        try:
            if not leader_exited:
                leader_exited = wait_for_exit_unreaped(process, 0)
            if leader_exited and not group_has_live_members(pgid, leader_exited, deadline):
                return leader_exited, errors
        except Exception as error:
            errors.append(f'Could not confirm command process-group cleanup: {error}')
            return leader_exited, errors
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            if not leader_exited:
                errors.append('Command leader did not exit after forced process-group cleanup')
            else:
                errors.append('Command process group still had live members after forced cleanup')
            return leader_exited, errors
        drain.read_for(min(POLL_SECONDS, remaining))


class PipeDrain:
    """Collect command output through nonblocking descriptors without reader threads."""

    def __init__(self, process):
        self.values = {'stdout': bytearray(), 'stderr': bytearray()}
        self.errors = []
        self.output_limit_exceeded = False
        self.selector = selectors.DefaultSelector()
        self.streams = [('stdout', process.stdout), ('stderr', process.stderr)]
        self.open_fds = set()
        for name, stream in self.streams:
            try:
                fd = stream.fileno()
                os.set_blocking(fd, False)
                self.selector.register(fd, selectors.EVENT_READ, name)
                self.open_fds.add(fd)
            except Exception as error:
                self.errors.append(f'Could not prepare command {name} pipe: {error}')

    def unregister(self, fd):
        try:
            self.selector.unregister(fd)
        except (KeyError, ValueError):
            pass
        self.open_fds.discard(fd)

    def read_for(self, timeout_seconds):
        if not self.open_fds:
            return
        try:
            events = self.selector.select(timeout_seconds)
        except Exception as error:
            self.errors.append(f'Could not wait for command output: {error}')
            return
        for key, _ in events:
            if key.fd not in self.open_fds:
                continue
            try:
                chunk = os.read(key.fd, PIPE_READ_BYTES)
            except BlockingIOError:
                continue
            except OSError as error:
                self.errors.append(f'Could not read command {key.data}: {error}')
                self.unregister(key.fd)
                continue
            if chunk:
                remaining = COMMAND_OUTPUT_LIMIT_BYTES - len(self.values[key.data])
                self.values[key.data].extend(chunk[:remaining])
                if len(chunk) > remaining:
                    if not self.output_limit_exceeded:
                        self.errors.append('Command output exceeded its retained byte limit')
                    self.output_limit_exceeded = True
            else:
                self.unregister(key.fd)

    def finish(self, errors):
        deadline = time.monotonic() + PIPE_DRAIN_SECONDS
        while self.open_fds:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                errors.append('Command output pipes did not close after process-group cleanup')
                break
            self.read_for(min(POLL_SECONDS, remaining))
        for name, stream in self.streams:
            try:
                stream.close()
            except Exception as error:
                errors.append(f'Could not close command {name} pipe: {error}')
        try:
            self.selector.close()
        except Exception as error:
            errors.append(f'Could not close command output selector: {error}')
        errors.extend(self.errors)


def close_stdin(stream, errors):
    if stream is None:
        return
    try:
        stream.close()
    except Exception as error:
        errors.append(f'Could not close command stdin: {error}')


def write_stdin_nonblocking(process, stdin, deadline, drain, errors):
    if stdin is None:
        return False
    stream = process.stdin
    selector = None
    try:
        fd = stream.fileno()
        os.set_blocking(fd, False)
        selector = selectors.DefaultSelector()
        selector.register(fd, selectors.EVENT_WRITE)
        data = bytes_from(stdin)
        offset = 0
        while offset < len(data):
            drain.read_for(0)
            try:
                written = os.write(fd, data[offset:])
            except BrokenPipeError:
                return False
            except BlockingIOError:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return True
                selector.select(min(POLL_SECONDS, remaining))
                continue
            except Exception as error:
                errors.append(f'Could not write command stdin: {error}')
                return False
            if written > 0:
                offset += written
    except Exception as error:
        errors.append(f'Could not prepare command stdin: {error}')
    finally:
        if selector is not None:
            try:
                selector.close()
            except Exception as error:
                errors.append(f'Could not close command stdin selector: {error}')
        close_stdin(stream, errors)
    return False


def run_posix_command(command, cwd, env, stdin, timeout_seconds, term_grace_seconds):
    require_unreaped_group_wait()
    process = subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    # start_new_session makes the child the new session and process-group leader.
    # The leader stays unreaped through cleanup, so this PGID cannot be recycled.
    pgid = process.pid
    drain = PipeDrain(process)
    cleanup_errors = []
    timed_out = False
    leader_exited = False
    deadline = time.monotonic() + timeout_seconds
    try:
        stdin_timed_out = write_stdin_nonblocking(process, stdin, deadline, drain, cleanup_errors)
        leader_exited = wait_for_exit_unreaped(
            process,
            max(0, deadline - time.monotonic()),
            drain,
        )
        if stdin_timed_out or not leader_exited:
            timed_out = True
            try:
                signal_process_group(pgid, signal.SIGTERM, leader_exited)
            except Exception as error:
                cleanup_errors.append(f'Could not terminate timed-out command group: {error}')
            leader_exited = wait_for_exit_unreaped(process, term_grace_seconds, drain)
    except Exception as error:
        cleanup_errors.append(f'Could not wait for command completion: {error}')
    finally:
        try:
            leader_exited, group_errors = force_and_confirm_process_group(
                process,
                pgid,
                leader_exited,
                drain,
            )
            cleanup_errors.extend(group_errors)
        except Exception as error:
            cleanup_errors.append(f'Could not force command process-group cleanup: {error}')
        try:
            process.wait(timeout=GROUP_CLEANUP_SECONDS)
        except subprocess.TimeoutExpired:
            cleanup_errors.append('Command leader did not reap after process-group cleanup')
            try:
                process.kill()
                process.wait(timeout=GROUP_CLEANUP_SECONDS)
            except Exception as error:
                cleanup_errors.append(f'Could not reap command leader: {error}')
        except Exception as error:
            cleanup_errors.append(f'Could not reap command leader: {error}')
        drain.finish(cleanup_errors)
    return {'stdout': bytes(drain.values['stdout']), 'stderr': bytes(drain.values['stderr']),
            'exit': process.returncode, 'timed_out': timed_out,
            'timeout_seconds': timeout_seconds, 'cleanup_errors': cleanup_errors}


def run_nonposix_command(command, cwd, env, stdin, timeout_seconds, term_grace_seconds):
    """Keep the previous direct-child timeout behavior where POSIX groups are unavailable."""
    process = subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    values = {'stdout': bytearray(), 'stderr': bytearray()}
    cleanup_errors = []
    overflow = threading.Event()

    def collect(name, stream):
        try:
            while True:
                chunk = os.read(stream.fileno(), PIPE_READ_BYTES)
                if not chunk:
                    return
                remaining = COMMAND_OUTPUT_LIMIT_BYTES - len(values[name])
                values[name].extend(chunk[:remaining])
                if len(chunk) > remaining:
                    overflow.set()
        except Exception:
            cleanup_errors.append(f'Could not read command {name}')

    def feed():
        try:
            process.stdin.write(bytes_from(stdin))
            process.stdin.flush()
        except BrokenPipeError:
            pass
        except Exception:
            cleanup_errors.append('Could not write command stdin')
        finally:
            close_stdin(process.stdin, cleanup_errors)

    readers = [threading.Thread(target=collect, args=(name, stream), daemon=True)
               for name, stream in (('stdout', process.stdout), ('stderr', process.stderr))]
    workers = readers + ([threading.Thread(target=feed, daemon=True)] if stdin is not None else [])
    for worker in workers:
        worker.start()
    deadline = time.monotonic() + timeout_seconds
    timed_out = False
    try:
        while process.poll() is None:
            remaining = deadline - time.monotonic()
            if overflow.is_set() or remaining <= 0:
                timed_out = remaining <= 0
                process.terminate()
                try:
                    process.wait(timeout=term_grace_seconds)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=GROUP_CLEANUP_SECONDS)
                break
            overflow.wait(min(POLL_SECONDS, remaining))
    except Exception:
        cleanup_errors.append('Could not stop non-POSIX command')
        try:
            process.kill()
            process.wait(timeout=GROUP_CLEANUP_SECONDS)
        except Exception:
            cleanup_errors.append('Could not reap non-POSIX command')
    drain_deadline = time.monotonic() + PIPE_DRAIN_SECONDS
    for worker in workers:
        worker.join(max(0, drain_deadline - time.monotonic()))
    for worker, stream in zip(readers, (process.stdout, process.stderr)):
        if worker.is_alive():
            cleanup_errors.append('Command output pipes did not close after direct-child cleanup')
        else:
            stream.close()
    if any(worker.is_alive() for worker in workers[len(readers):]):
        cleanup_errors.append('Command stdin did not close after direct-child cleanup')
    if overflow.is_set():
        cleanup_errors.append('Command output exceeded its retained byte limit')
    return {'stdout': bytes(values['stdout']), 'stderr': bytes(values['stderr']),
            'exit': process.returncode, 'timed_out': timed_out,
            'timeout_seconds': timeout_seconds, 'cleanup_errors': cleanup_errors}


def run_command(command, cwd, env, stdin=None, timeout_seconds=COMMAND_TIMEOUT_SECONDS,
                term_grace_seconds=TERM_GRACE_SECONDS):
    if os.name == 'posix':
        return run_posix_command(command, cwd, env, stdin, timeout_seconds, term_grace_seconds)
    return run_nonposix_command(command, cwd, env, stdin, timeout_seconds, term_grace_seconds)


def bounded_output(label, command, cwd=None, env=None, text=False):
    """Run a verifier auxiliary process under the same bounded cleanup contract as the CLI."""
    result = run_command(
        command,
        cwd,
        env,
        timeout_seconds=AUXILIARY_TIMEOUT_SECONDS,
    )
    errors = []
    if result['timed_out']:
        errors.append(f"timed out after {result['timeout_seconds']} seconds")
    if result['exit'] != 0:
        errors.append(f"exited with status {result['exit']}")
    errors.extend(result['cleanup_errors'])
    if errors:
        raise RuntimeError(f"{label}: {'; '.join(errors)}")
    output = result['stdout']
    return output.decode() if text else output


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
    expected_receipt_labels = []
    failure = None
    completed = False
    cleanup_errors = []
    candidate_temp = None
    sentinel = 'VERIFY_SYNTHETIC_SECRET_59c8'
    try:
        # Only entry-point utilities can execute. No inherited credentials, engine socket,
        # kubeconfig, user home, proxy or ambient HOUSTON_* overrides reach the CLI.
        toolbin = scratch / 'bin'
        toolbin.mkdir()
        node_shim = shutil.which('node')
        require(node_shim is not None, 'Missing prerequisite: node')
        discovery_home = scratch / 'node-discovery-home'
        discovery_home.mkdir()
        discovery_env = {'PATH': os.environ.get('PATH', os.defpath),
                         'HOME': str(discovery_home), 'LANG': 'C.UTF-8', 'NO_COLOR': '1'}
        node_exec = Path(bounded_output(
            'Node executable discovery',
            [node_shim, '-p', 'process.execPath'],
            cwd=root,
            env=discovery_env,
            text=True,
        ).strip())
        require(node_exec.is_file(), 'Node did not expose its executable path')
        for tool in ('dirname', 'readlink'):
            executable = shutil.which(tool)
            require(executable is not None, f'Missing prerequisite: {tool}')
            (toolbin / tool).symlink_to(Path(executable).resolve())
        (toolbin / 'node').symlink_to(node_exec)
        env = {'PATH': str(toolbin), 'HOME': str(scratch / 'user'),
               'HOUSTON_HOME': str(scratch / 'home'),
               'HOUSTON_SKILL_HOME': str(scratch / 'skills'), 'NO_COLOR': '1', 'LANG': 'C.UTF-8'}
        env = bind_candidate_temp(env, scratch)
        candidate_temp = Path(env['TMPDIR'])
        Path(env['HOME']).mkdir()
        workspace = scratch / 'home' / 'repros' / 'verify-fixture'
        workspace.mkdir(parents=True)
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
        docker_access = workspace.parent / 'verify-docker-access-fixture'
        docker_access.mkdir()
        docker_access_record = dict(record, name=docker_access.name,
                                     project='houston-verify-docker-access-fixture',
                                     root_url='http://127.0.0.1:39999',
                                     admin_password='synthetic-access',
                                     extra={'runtime': 'docker', 'bind_host': '127.0.0.1'})
        (docker_access / 'repro.json').write_text(json.dumps(docker_access_record))
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
            expected_receipt_labels.append(label)
            result = run_command(command, root, child_env, stdin=stdin)
            stdout = result['stdout']
            stderr = result['stderr']
            (out / f'{label}.stdout').write_bytes(stdout)
            (out / f'{label}.stderr').write_bytes(stderr)
            receipt = {'label': label, 'argv': ['bin/houston', *argv], 'exit': result['exit']}
            scan_error = None
            try:
                scan_command_receipts(sentinel, out, label)
            except Exception as error:
                scan_error = str(error)
            if result['timed_out']:
                receipt.update({'timed_out': True, 'timeout_seconds': result['timeout_seconds']})
            if result['cleanup_errors']:
                receipt['cleanup_errors'] = result['cleanup_errors']
            receipts.append(receipt)
            (out / 'commands.json').write_text(json.dumps(receipts, indent=2) + '\n')
            errors = []
            if scan_error is not None:
                errors.append(f'{label}: {scan_error}')
            if result['timed_out']:
                errors.append(f"{label}: timed out after {result['timeout_seconds']} seconds")
            if result['exit'] != expected:
                errors.append(f"{label}: expected exit {expected}, got {result['exit']}")
            errors.extend(f'{label}: {error}' for error in result['cleanup_errors'])
            if errors:
                raise RuntimeError('; '.join(errors))
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
        require_command_contract(commands.get('info'), 'info', ['--name'], 'houston.info.v1')
        require_command_contract(commands.get('capabilities'), 'capabilities', [], 'houston.capabilities.v1')
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
            require_command_contract(inspection, 'inspect', ['--name'], 'houston.inspect.v1')
            missing_inspect = run('inspect-missing', ['inspect', '--name', 'verify-missing', '--json'],
                                  expected=4, schema='houston.error.v1', ok=False)
            require(missing_inspect['error']['code'] == 'NOT_FOUND', 'Inspect missing name must be NOT_FOUND')
            for name, runtime in [('verify-fixture', 'docker'), ('verify-kube-fixture', 'kubernetes')]:
                inspect_label = f'inspect-{runtime}'
                envelope = run(inspect_label, ['inspect', '--name', name, '--json'],
                               schema='houston.inspect.v1')
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
            require_command_contract(evidence, 'evidence', ['--name', '--bundle'], 'houston.evidence.v1')
            missing_evidence = run('evidence-missing', ['evidence', '--name', 'verify-missing', '--json'],
                                   expected=4, schema='houston.error.v1', ok=False)
            require(missing_evidence['error']['code'] == 'NOT_FOUND',
                    'Evidence missing name must be NOT_FOUND')
            payload = run('evidence-json', ['evidence', '--name', 'verify-fixture', '--json'],
                          schema='houston.evidence.v1')['data']
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
            expected_bundle_files = ['README.md', 'docker-compose.yml', 'manifest.json']
            bundle_names = bundle_payload.get('bundle', {}).get('files')
            require(isinstance(bundle_names, list) and sorted(bundle_names) == expected_bundle_files,
                    'Bundle response listed an incomplete or stale file set')
            require(Path(bundle_payload['bundle']['path']).resolve() == bundle.resolve(),
                    'Bundle response named another destination')
            require(stat.S_ISDIR(bundle.lstat().st_mode),
                    'Bundle root must be a real directory, not a symlink')
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
            require_command_contract(capture, 'capture', ['--name', '--workload', '--bundle'], 'houston.capture.v1')
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
            require_absent_capture_bundle(absent_bundle, capture_marker)
            summary['features']['capture'] = 'PASS: missing workspace refused before bundle or browser launch; browser capture pending'
        loopback_access = (
            ('docker', docker_access.name, '127.0.0.1', docker_access_record['root_url']),
            ('kubernetes', access_workspace.name, '127.0.0.1', access_record['root_url']),
        )
        discovery = []
        for runtime, name, _target, _url in loopback_access:
            detail = run(f'access-discovery-{runtime}', ['info', '--name', name, '--json'],
                         schema='houston.info.v1')['data']
            discovery.append((runtime, detail))
        if not access_supported(discovery):
            summary['features']['access'] = 'PENDING: info payload has no access consumer'
        else:
            discovered = dict(discovery)
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
                require(data['tunnel_command'] in human and data['browser_url'] in human,
                        'Human access guidance differs from JSON')
            remote = {'SSH_CONNECTION': ssh_values['SSH_CONNECTION'],
                      'HOUSTON_SSH_USER': 'operator', 'HOUSTON_SSH_HOST': 'ssh-proof.invalid'}
            for runtime, name, target, root_url in loopback_access:
                local = discovered[runtime]['access']
                require(local['mode'] == 'local' and local['bind'] == 'loopback'
                        and local['host_port'] == 39999 and local['local_port'] == 39999
                        and local['browser_url'] == root_url
                        and local['tunnel_command'] is None and local['note'] is None,
                        'Local access handoff differs from recorded workspace')
                local_human = run(f'access-local-human-{runtime}', ['info', '--name', name])
                require(local['browser_url'] in local_human,
                        'Human local access guidance omitted the browser URL')
                for marker in ssh_values:
                    remote_access(runtime + '-' + marker.lower().replace('_', '-'), marker,
                                  name=name, target=target)
                remote_access(runtime + '-option', 'SSH_CONNECTION', name=name, target=target,
                              changes={'HOUSTON_SSH_USER': '-oProxyCommand=unsafe'})
                remote_access(runtime + '-minimum-port', 'SSH_CONNECTION', name=name, target=target,
                              port=1024, changes={'HOUSTON_SSH_LOCAL_PORT': '1024'})
                for label, value in [('non-numeric', 'not-a-port'), ('negative', '-1'),
                                     ('below-minimum', '1023'), ('above-maximum', '65536')]:
                    invalid = run(f'access-invalid-port-{runtime}-' + label,
                                  ['info', '--name', name, '--json'],
                                  expected=2, schema='houston.error.v1', ok=False,
                                  overrides=dict(remote, HOUSTON_SSH_LOCAL_PORT=value))
                    require(invalid['error']['code'] == 'VALIDATION_FAILED',
                            f'Invalid local port {value} must be refused')
            remote_access('ipv6', 'SSH_CONNECTION', name='verify-ipv6-fixture', target='[::1]', port=4311, sides=(4312, 4313, 4314),
                          changes={'HOUSTON_SSH_LOCAL_PORT': '4311',
                                   'HOUSTON_SSH_USER': "operator's team",
                                   'HOUSTON_SSH_HOST': 'ssh-proof.invalid; echo unsafe'})
            for label, port in [('sidecar', 4312), ('sidecar-second', 4313), ('monitoring', 4314)]:
                collision = run('access-' + label + '-port-collision',
                                ['info', '--name', 'verify-ipv6-fixture', '--json'],
                                expected=2, schema='houston.error.v1', ok=False,
                                overrides={'SSH_TTY': ssh_values['SSH_TTY'],
                                           'HOUSTON_SSH_LOCAL_PORT': str(port)})
                require(collision['error']['code'] == 'VALIDATION_FAILED',
                        f'A primary forward colliding with a {label} port must refuse')
            public = run('access-public', ['info', '--name', 'verify-public-fixture', '--json'],
                         schema='houston.info.v1', overrides=remote)['data']
            require(public['access'] is None, 'Wildcard workspace must not claim loopback access')
            summary['features']['access'] = (
                'PASS: Docker and Kubernetes loopback local and SSH-marker handoff, '
                'IPv6, option safety, local-port boundaries; no SSH executed')
        if 'onboard' not in commands:
            summary['features']['onboarding'] = 'PENDING: onboard command absent'
        else:
            require_command_contract(commands['onboard'], 'onboard', ['--json'], 'houston.onboard.v1')
            require_command_contract(commands.get('down'), 'down', ['--name', '--yes'], 'houston.down.v1')
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
            require_revoked_onboarding_persisted(
                persisted, revoked['completed_at'], version, legacy)
            (out / 'onboarding-persisted.json').write_text(json.dumps(persisted, indent=2) + '\n')
            kubectl_trap.unlink()
            summary['features']['onboarding'] = (
                'PASS: synthetic-home status, invalid grant, grant/revoke persistence and '
                'legacy preservation and local teardown authority refusals; live engine pending')
        if 'onboard' in commands and '--show' in commands['onboard']['flags']:
            require_command_contract(commands['onboard'], 'setup',
                ['--show', '--deployment', '--scenario', '--seed-profile', '--retain-runs/--no-retain-runs',
                 '--accept-defaults', '--reconfigure', '--section'], 'houston.onboard.v1')
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
                    and any(gate['code'] == 'GATE_OWNED_CLUSTER' for gate in saved['gates']),
                    'Setup failed to persist explicit choices or changed authority')
            summary['setup_first_run'] = require_setup_first_run(saved)
            after = config_file.read_bytes()
            repeated = run('setup-readback', ['onboard', '--show', '--json'],
                           schema='houston.onboard.v1')['data']
            require(repeated['selection'] == saved['selection']
                    and config_file.read_bytes() == after, 'Setup choices did not survive process exit')
            defaults = run('setup-defaults', ['onboard', '--accept-defaults', '--json'],
                           schema='houston.onboard.v1')['data']
            require(defaults['selection'] == saved['selection']
                    and defaults['persisted']['grants']['owned_cluster'] is False
                    and defaults['action'] == 'unchanged'
                    and config_file.read_bytes() == after,
                    'Accepting redundant defaults rewrote answered choices or granted authority')
            human = run('setup-human', ['onboard', '--show'])
            require('microservices' in human and 'GATE_OWNED_CLUSTER' in human,
                    'Human setup omitted selected deployment or authority gate')
            persisted_setup = yaml_document(node_exec, root, env, config_file)
            require(persisted_setup['future_config'] == legacy['future_config']
                    and persisted_setup['grants']['future_grant'] == legacy['grants']['future_grant']
                    and persisted_setup['grants'] == persisted['grants']
                    and persisted_setup['onboarding'] == persisted['onboarding'],
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
            interactive_setup = yaml_document(node_exec, root, env, config_file)
            expected_interactive = json.loads(json.dumps(persisted_setup))
            expected_interactive['preferences']['seed_profile'] = 'small'
            require(interactive_setup == expected_interactive,
                    'Interactive setup discarded legacy fields, scope, denials or unrelated state')
            (out / 'setup-interactive-persisted.json').write_text(
                json.dumps(interactive_setup, indent=2) + '\n')
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
        if candidate_temp is not None:
            try:
                # Scan before removal. This directory lives under scratch.
                scan_candidate_temp(sentinel, candidate_temp)
            except Exception as error:
                cleanup_errors.append(f'Candidate temp scan failed: {error}')
        try:
            shutil.rmtree(scratch)
        except Exception as error:
            cleanup_errors.append(f'Could not remove verifier scratch: {error}')
        summary['scratch_removed'] = not scratch.exists()
        if not summary['scratch_removed']:
            cleanup_errors.append('Verifier scratch remains after cleanup')
        if retained_bundle_files:
            try:
                require(stat.S_ISDIR(bundle.lstat().st_mode),
                        'Retained bundle root must remain a real directory')
            except Exception as error:
                cleanup_errors.append(str(error))
        for file, digest in retained_bundle_files:
            try:
                require_regular_file(file, f'Retained bundle attachment is not a regular file: {file.name}')
                require(hashlib.sha256(file.read_bytes()).hexdigest() == digest,
                        f'Retained bundle attachment changed after cleanup: {file.name}')
            except Exception as error:
                cleanup_errors.append(str(error))
        try:
            require(expected_receipt_labels, 'No command receipts were expected')
            scan_command_receipts(sentinel, out, *expected_receipt_labels)
            scanned_receipts = scan_command_receipts(sentinel, out)
            summary['receipt_scan'] = {
                'result': 'PASS',
                'files': len(scanned_receipts),
                'scope': 'all retained command stdout/stderr receipts',
            }
        except Exception as error:
            cleanup_errors.append(f'Final command receipt scan failed: {error}')
        try:
            scan_retained_regular_files(sentinel, out)
        except Exception as error:
            cleanup_errors.append(f'Retained evidence scan failed: {error}')
        try:
            require_no_special_retained_entries(out)
        except Exception as error:
            cleanup_errors.append(f'Retained special-entry scan failed: {error}')
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
