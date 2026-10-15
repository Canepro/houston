import { ValidationError } from '../../../src/lib/errors';
import { handoff } from '../../../src/core/lifecycle/access';
import { metadata } from '../../../src/core/runner/record';

const REMOTE_NOTE =
  'The workspace listens on loopback on the remote host only. Run the tunnel command on your ' +
  'machine, then open the browser URL there. Credentials stay private to that tunnel. If the ' +
  'local port is occupied, set HOUSTON_SSH_LOCAL_PORT on the remote command and request the ' +
  'handoff again.';

function workspace(values: Parameters<typeof metadata>[0] = {}) {
  return metadata({
    name: 'remote',
    rootUrl: 'http://localhost:3123',
    hostPort: 3123,
    ...values,
  });
}

describe('SSH access handoff', () => {
  it('keeps a local session on its recorded direct URL', () => {
    expect(handoff(workspace(), {})).toEqual({
      mode: 'local',
      bind: 'loopback',
      host_port: 3123,
      local_port: 3123,
      browser_url: 'http://localhost:3123',
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
      browser_url: 'http://127.0.0.1:3123',
      tunnel_command: 'ssh -N -L 127.0.0.1:3123:127.0.0.1:3123 -- operator@203.0.113.8',
      note: REMOTE_NOTE,
    });
  });

  it('honours the documented overrides, forwards IPv6 loopback, and quotes a destination as one shell word', () => {
    expect(
      handoff(workspace({ rootUrl: 'http://[::1]:3123' }), {
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
      browser_url: 'http://127.0.0.1:4311',
      tunnel_command:
        "ssh -N -L 127.0.0.1:4311:[::1]:3123 -- 'operator'\\''s team@repro; echo unsafe'",
      note: REMOTE_NOTE,
    });
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
        'ssh -N -L 127.0.0.1:3123:127.0.0.1:3123 -- -oProxyCommand=unsafe@ssh-proof.invalid',
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
