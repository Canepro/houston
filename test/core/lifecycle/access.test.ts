import { ValidationError } from '../../../src/lib/errors';
import { handoff, validateEnvironment } from '../../../src/core/lifecycle/access';
import { bindHostOf } from '../../../src/core/lifecycle/payload';
import { metadata, write } from '../../../src/core/runner/record';

const REMOTE_NOTE =
  'The workspace listens on loopback on the remote host only. Run the tunnel command on your ' +
  'machine, then open the browser URL there. Credentials stay private to that tunnel. If the ' +
  'local port is occupied, set HOUSTON_SSH_LOCAL_PORT on the remote command and request the ' +
  'handoff again.';

function workspace(values: Parameters<typeof metadata>[0] = {}) {
  const { extra = {}, ...rest } = values;
  return metadata({
    name: 'remote',
    rootUrl: 'http://localhost:3123',
    hostPort: 3123,
    ...rest,
    // A current record carries its actual bind explicitly. Tests that need a legacy or
    // unknown bind build that record directly instead of inferring it from rootUrl.
    extra: { bind_host: '127.0.0.1', ...extra },
  });
}

describe('SSH access handoff', () => {
  it('keeps a local session on its recorded direct URL', () => {
    expect(handoff(workspace(), {})).toEqual({
      mode: 'local',
      bind: 'loopback',
      host_port: 3123,
      local_port: 3123,
      side_ports: [],
      browser_url: 'http://localhost:3123',
      public_url: null,
      tunnel_command: null,
      note: null,
    });
  });

  it('gives an SSH operator a loopback tunnel without changing the workspace bind', () => {
    expect(
      handoff(workspace(), {
        SSH_CONNECTION: '198.51.100.20 55100 203.0.113.8 22',
        USER: 'operator',
      }),
    ).toEqual({
      mode: 'remote_ssh',
      bind: 'loopback',
      host_port: 3123,
      local_port: 3123,
      side_ports: [],
      browser_url: 'http://127.0.0.1:3123',
      tunnel_command:
        'ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:3123:127.0.0.1:3123 -- operator@203.0.113.8',
      public_url: null,
      note: REMOTE_NOTE,
    });
  });

  it('honours the documented overrides, forwards IPv6 loopback, and quotes a destination as one shell word', () => {
    expect(
      handoff(workspace({ extra: { bind_host: '::1' } }), {
        SSH_TTY: '/dev/ttys001',
        HOUSTON_SSH_HOST: 'repro; echo unsafe',
        HOUSTON_SSH_USER: "operator's team",
        HOUSTON_SSH_LOCAL_PORT: '4311',
      }),
    ).toEqual({
      mode: 'remote_ssh',
      bind: 'loopback',
      host_port: 3123,
      local_port: 4311,
      side_ports: [],
      browser_url: 'http://127.0.0.1:4311',
      public_url: null,
      tunnel_command:
        "ssh -N -o ExitOnForwardFailure=yes -L '127.0.0.1:4311:[::1]:3123' -- 'operator'\\''s team@repro; echo unsafe'",
      // A different local port is not transparent: ROOT_URL still names the server's.
      note: expect.stringContaining("Rocket.Chat's ROOT_URL still names port 3123"),
    });
  });

  it('forwards the exact resolved loopback address rather than the browser hostname', () => {
    for (const bind of ['127.0.0.2', '::1']) {
      const answer = handoff(
        workspace(),
        { SSH_TTY: '/dev/ttys001', USER: 'operator', HOUSTON_SSH_HOST: 'server' },
        bind,
      );
      expect(answer?.tunnel_command).toBe(
        bind === '::1'
          ? "ssh -N -o ExitOnForwardFailure=yes -L '127.0.0.1:3123:[::1]:3123' -- operator@server"
          : 'ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:3123:127.0.0.2:3123 -- operator@server',
      );
    }
  });

  it('keeps option-shaped overrides after the SSH option terminator', () => {
    expect(
      handoff(workspace(), {
        SSH_CONNECTION: '198.51.100.20 55100 203.0.113.8 22',
        HOUSTON_SSH_USER: '-oProxyCommand=unsafe',
        HOUSTON_SSH_HOST: 'ssh-proof.invalid',
      }),
    ).toMatchObject({
      browser_url: 'http://127.0.0.1:3123',
      tunnel_command:
        'ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:3123:127.0.0.1:3123 -- -oProxyCommand=unsafe@ssh-proof.invalid',
    });
  });

  it('refuses an invalid local tunnel port before printing a command that cannot work', () => {
    expect(() =>
      handoff(workspace(), {
        SSH_CLIENT: '198.51.100.20 55100 22',
        HOUSTON_SSH_LOCAL_PORT: 'not-a-port',
      }),
    ).toThrow(ValidationError);
    expect(() =>
      handoff(workspace(), {
        SSH_CLIENT: '198.51.100.20 55100 22',
        HOUSTON_SSH_LOCAL_PORT: 'not-a-port',
      }),
    ).toThrow('HOUSTON_SSH_LOCAL_PORT must be an integer between 1024 and 65535');
  });

  it('reconnects on the port the session came in on, and exits when a forward fails', () => {
    const answer = handoff(workspace(), {
      SSH_CONNECTION: '198.51.100.20 55100 203.0.113.8 2222',
      USER: 'operator',
    });
    expect(answer?.tunnel_command).toBe(
      'ssh -N -o ExitOnForwardFailure=yes -p 2222 -L 127.0.0.1:3123:127.0.0.1:3123 -- operator@203.0.113.8',
    );
    const clientFallback = handoff(workspace(), {
      // SSH_CONNECTION is present but its server port cannot be used. SSH_CLIENT still
      // carries the port that accepted this session.
      SSH_CONNECTION: '198.51.100.20 55100 203.0.113.8 70000',
      SSH_CLIENT: '198.51.100.20 55100 2222',
      HOUSTON_SSH_HOST: 'ssh-proof.invalid',
      USER: 'operator',
    });
    expect(clientFallback?.tunnel_command).toBe(
      'ssh -N -o ExitOnForwardFailure=yes -p 2222 -L 127.0.0.1:3123:127.0.0.1:3123 -- operator@ssh-proof.invalid',
    );
    expect(() =>
      handoff(workspace(), { SSH_TTY: '/dev/ttys001', HOUSTON_SSH_PORT: '70000' }),
    ).toThrow('HOUSTON_SSH_PORT must be an integer between 1 and 65535');
  });

  it("forwards the preset's side ports on their own numbers, and says so", () => {
    const answer = handoff(workspace({ extra: { sidecar_ports: [8081, 8025, '8081', 3123, 0] } }), {
      SSH_CONNECTION: '198.51.100.20 55100 203.0.113.8 22',
      USER: 'operator',
    });
    expect(answer?.side_ports).toEqual([8025, 8081]);
    expect(answer?.tunnel_command).toBe(
      'ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:3123:127.0.0.1:3123 ' +
        '-L 127.0.0.1:8025:127.0.0.1:8025 -L 127.0.0.1:8081:127.0.0.1:8081 -- operator@203.0.113.8',
    );
    expect(answer?.note).toContain(
      'side services and instances are forwarded on their own ports (8025, 8081)',
    );
  });

  it("forwards monitoring's ports too, and refuses an override that lands on a side port", () => {
    const answer = handoff(
      workspace({ extra: { sidecar_ports: [8025], monitoring_ports: [9090, 5050] } }),
      { SSH_CONNECTION: '198.51.100.20 55100 203.0.113.8 22', USER: 'operator' },
    );
    expect(answer?.side_ports).toEqual([5050, 8025, 9090]);
    expect(answer?.tunnel_command).toContain('-L 127.0.0.1:9090:127.0.0.1:9090');
    // Two -L on one local port cannot both listen, and ExitOnForwardFailure would end
    // the tunnel over it; refused before a command that cannot work is printed.
    expect(() =>
      handoff(workspace({ extra: { sidecar_ports: [8081] } }), {
        SSH_CONNECTION: '198.51.100.20 55100 203.0.113.8 22',
        HOUSTON_SSH_LOCAL_PORT: '8081',
      }),
    ).toThrow("HOUSTON_SSH_LOCAL_PORT 8081 is one of this workspace's side ports");
  });

  it('forwards every recorded instance and refuses a primary-port collision with one', () => {
    const meta = workspace({
      extra: {
        runtime: 'docker',
        deployment: 'multi-instance',
        instances: 3,
        sidecar_ports: [3125, 8025],
      },
    });
    const env = { SSH_TTY: '/dev/ttys001', USER: 'operator', HOUSTON_SSH_HOST: 'server' };
    const answer = handoff(meta, env);
    expect(answer?.side_ports).toEqual([3124, 3125, 3126, 8025]);
    expect(answer?.tunnel_command).toBe(
      'ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:3123:127.0.0.1:3123 ' +
        '-L 127.0.0.1:3124:127.0.0.1:3124 -L 127.0.0.1:3125:127.0.0.1:3125 ' +
        '-L 127.0.0.1:3126:127.0.0.1:3126 -L 127.0.0.1:8025:127.0.0.1:8025 -- operator@server',
    );
    for (const port of ['3124', '3125', '3126']) {
      expect(() => handoff(meta, { ...env, HOUSTON_SSH_LOCAL_PORT: port })).toThrow(
        `HOUSTON_SSH_LOCAL_PORT ${port} is one of this workspace's side ports`,
      );
    }
    expect(handoff(workspace({ extra: { instances: 1 } }), env)?.side_ports).toEqual([]);
  });

  it('forwards only recorded Kubernetes side ports when chart replicas exceed one', () => {
    const meta = workspace({
      extra: {
        runtime: 'kubernetes',
        deployment: 'microservices',
        instances: 3,
        sidecar_ports: [9090, 3123, 8025],
        monitoring_ports: [5050, 9090],
      },
    });
    const answer = handoff(meta, {
      SSH_TTY: '/dev/ttys001',
      USER: 'operator',
      HOUSTON_SSH_HOST: 'server',
      // 3124 used to be invented from the Kubernetes replica count and therefore refused.
      HOUSTON_SSH_LOCAL_PORT: '3124',
    });
    expect(answer).toMatchObject({
      local_port: 3124,
      side_ports: [5050, 8025, 9090],
      tunnel_command:
        'ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:3124:127.0.0.1:3123 ' +
        '-L 127.0.0.1:5050:127.0.0.1:5050 -L 127.0.0.1:8025:127.0.0.1:8025 ' +
        '-L 127.0.0.1:9090:127.0.0.1:9090 -- operator@server',
    });
  });

  it('validates a session override only for a workspace that will be loopback-bound', () => {
    const env = { SSH_TTY: '/dev/ttys001', HOUSTON_SSH_LOCAL_PORT: '80' };
    expect(() => validateEnvironment(env, '')).toThrow(ValidationError);
    expect(() => validateEnvironment(env, '127.0.0.1')).toThrow(ValidationError);
    expect(() => validateEnvironment(env, '0.0.0.0')).not.toThrow();
  });

  it('keeps the HTTPS address the edge serves beside the tunnel, and says the tunnel is plain HTTP', () => {
    const answer = handoff(workspace({ publicUrl: 'https://rc.example.test' }), {
      SSH_CONNECTION: '198.51.100.20 55100 203.0.113.8 22',
      USER: 'operator',
    });
    expect(answer?.public_url).toBe('https://rc.example.test');
    expect(answer?.browser_url).toBe('http://127.0.0.1:3123');
    expect(answer?.note).toContain(
      'also answers at https://rc.example.test through the shared HTTPS edge',
    );
    expect(handoff(workspace({ publicUrl: 'https://rc.example.test' }), {})?.public_url).toBe(
      'https://rc.example.test',
    );
  });

  it('names an overridden advertised origin instead of inventing a loopback ROOT_URL', () => {
    const answer = handoff(workspace({ extra: { advertised_url: 'https://chat.example.test' } }), {
      SSH_CONNECTION: '198.51.100.20 55100 203.0.113.8 22',
      USER: 'operator',
      HOUSTON_SSH_LOCAL_PORT: '4311',
    });
    expect(answer?.browser_url).toBe('http://127.0.0.1:4311');
    expect(answer?.note).toContain("Rocket.Chat's ROOT_URL is https://chat.example.test");
    expect(answer?.note).toContain('absolute links');
    expect(answer?.note).not.toContain('still names port 3123');
  });

  it('refuses a bad session override before a create, and ignores one outside SSH', () => {
    expect(() =>
      validateEnvironment({ SSH_TTY: '/dev/ttys001', HOUSTON_SSH_LOCAL_PORT: '80' }),
    ).toThrow(ValidationError);
    expect(() => validateEnvironment({ HOUSTON_SSH_LOCAL_PORT: '80' })).not.toThrow();
  });

  it('gives no client-side loopback guidance for a non-loopback workspace', () => {
    expect(
      handoff(
        workspace({
          rootUrl: 'http://192.0.2.40:3123',
          extra: { bind_host: '0.0.0.0' },
        }),
        { SSH_CONNECTION: '198.51.100.20 55100 203.0.113.8 22', USER: 'operator' },
      ),
    ).toBeNull();
  });
});

describe('the bind address read back from a legacy compose file', () => {
  it('reads the address left of the two port fields, bracketed or not', async () => {
    for (const [spelling, expected] of [
      ['"[::1]:3001:3000"', '::1'],
      ['"::1:3001:3000"', '::1'],
      ['"127.0.0.2:3001:3000/tcp"', '127.0.0.2'],
      ['"3001:3000"', ''],
    ] as const) {
      const name = `legacy-${expected.replace(/[^a-z0-9]/gu, '') || 'none'}`;
      await write(
        name,
        `services:\n  rocketchat:\n    ports: [${spelling}]\n`,
        metadata({ name, rootUrl: 'http://localhost:3001', hostPort: 3001 }),
      );
      expect(
        await bindHostOf(
          await import('../../../src/core/runner/record').then((m) => m.readMeta(name)),
        ),
      ).toBe(expected);
    }
  });
});
