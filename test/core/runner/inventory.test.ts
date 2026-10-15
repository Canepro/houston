import * as engine from '../../../src/core/runner/engine';
import * as record from '../../../src/core/runner/record';
import * as dockerCli from '../../../src/seams/docker-cli';
import { Interrupted } from '../../../src/seams/exec';
import {
  bindingText,
  containerRecords,
  dockerInventory,
  networkNames,
  portBindings,
  volumeNames,
} from '../../../src/core/runner/inventory';

jest.mock('../../../src/core/runner/engine', () => ({
  compose: jest.fn(),
}));

jest.mock('../../../src/core/runner/record', () => ({
  projectName: jest.fn(),
}));

jest.mock('../../../src/seams/docker-cli', () => ({
  docker: jest.fn(),
}));

const compose = engine.compose as jest.MockedFunction<typeof engine.compose>;
const projectName = record.projectName as jest.MockedFunction<typeof record.projectName>;
const docker = dockerCli.docker as jest.MockedFunction<typeof dockerCli.docker>;

function result(overrides: Record<string, unknown> = {}) {
  return { argv: ['docker'], exitCode: 0, signal: null, stdout: '', stderr: '', ...overrides };
}

beforeEach(() => {
  projectName.mockResolvedValue('houston-ticket');
  docker.mockResolvedValue(result() as Awaited<ReturnType<typeof docker>>);
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('the Docker inspection rows', () => {
  it('excludes exposed-only ports and preserves wildcard and IPv6 bindings', () => {
    const bindings = portBindings([
      { URL: '::', PublishedPort: '3001', TargetPort: 3000, Protocol: 'tcp' },
      { URL: '127.0.0.1', PublishedPort: 3000, TargetPort: 3000, Protocol: 'tcp' },
      { URL: '127.0.0.1', PublishedPort: 0, TargetPort: 9229, Protocol: 'tcp' },
    ]);
    expect(bindings).toEqual([
      { host_ip: '127.0.0.1', host_port: 3000, container_port: 3000, protocol: 'tcp' },
      { host_ip: '::', host_port: 3001, container_port: 3000, protocol: 'tcp' },
    ]);
    expect(bindings.map(bindingText)).toEqual(['127.0.0.1:3000->3000/tcp', '[::]:3001->3000/tcp']);
  });

  it('reads both Compose JSON encodings and includes stopped containers', async () => {
    compose.mockResolvedValue(
      result({
        stdout: [
          JSON.stringify({
            Service: 'rocketchat',
            Name: 'ticket-rc',
            State: 'running',
            Status: 'Up 1 minute',
            Publishers: [{ URL: '127.0.0.1', PublishedPort: 3000, TargetPort: 3000 }],
          }),
          JSON.stringify({
            Service: 'mongo',
            Name: 'ticket-mongo',
            State: 'exited',
            Status: 'Exited (0)',
          }),
        ].join('\n'),
      }) as Awaited<ReturnType<typeof compose>>,
    );

    await expect(containerRecords('ticket')).resolves.toEqual({
      rows: [
        {
          service: 'mongo',
          name: 'ticket-mongo',
          state: 'exited',
          status: 'Exited (0)',
          ports: [],
        },
        {
          service: 'rocketchat',
          name: 'ticket-rc',
          state: 'running',
          status: 'Up 1 minute',
          ports: [{ host_ip: '127.0.0.1', host_port: 3000, container_port: 3000, protocol: 'tcp' }],
        },
      ],
      warning: null,
    });
  });

  it('uses Compose labels rather than a name prefix for networks and volumes', async () => {
    docker
      .mockResolvedValueOnce(
        result({ stdout: 'houston-ticket_default\n' }) as Awaited<ReturnType<typeof docker>>,
      )
      .mockResolvedValueOnce(
        result({ stdout: 'houston-ticket_data\n' }) as Awaited<ReturnType<typeof docker>>,
      );

    await expect(networkNames('ticket')).resolves.toEqual({
      rows: ['houston-ticket_default'],
      warning: null,
    });
    await expect(volumeNames('ticket')).resolves.toEqual({
      rows: ['houston-ticket_data'],
      warning: null,
    });
    expect(docker).toHaveBeenNthCalledWith(
      1,
      [
        'network',
        'ls',
        '--filter',
        'label=com.docker.compose.project=houston-ticket',
        '--format',
        '{{.Name}}',
      ],
      { capture: true, timeoutMs: 30_000 },
    );
  });

  it('marks malformed or unavailable engine reads as unknown instead of no resources', async () => {
    compose.mockResolvedValue(
      result({ stdout: '{"not": "a compose container row"}\nnot-json' }) as Awaited<
        ReturnType<typeof compose>
      >,
    );
    docker.mockResolvedValue(result({ exitCode: 1 }) as Awaited<ReturnType<typeof docker>>);

    await expect(dockerInventory('ticket')).resolves.toEqual({
      containers: [],
      networks: [],
      volumes: [],
      warnings: [
        'Docker returned invalid container JSON',
        'could not inspect workspace networks',
        'could not inspect workspace volumes',
      ],
    });
  });

  it('does not turn Ctrl-C into a successful empty inventory', async () => {
    compose.mockRejectedValue(new Interrupted());

    await expect(dockerInventory('ticket')).rejects.toBeInstanceOf(Interrupted);
  });
});
