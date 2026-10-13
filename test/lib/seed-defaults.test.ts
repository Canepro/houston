import { build, spec } from '../../src/lib/compose';
import { emptyPreset } from '../../src/lib/presets/types';
import { chartEnv } from '../../src/core/kube/chart';

describe('fresh workspace custom emoji compatibility', () => {
  it('uses the Rocket.Chat safe query default in Compose so an empty client query works', () => {
    const document = build(
      spec({
        projectName: 'houston-seed-default',
        preset: emptyPreset('default'),
        rcImage: 'registry.rocket.chat/rocketchat/rocket.chat',
        rcTag: '8.5.1',
        mongoTag: '8.0',
        mongoFlavor: 'official',
        mongoShell: 'mongosh',
        rootUrl: 'http://localhost:3001',
        hostPort: 3001,
      }),
    );
    const environment = (document.services.rocketchat?.environment ?? {}) as Record<string, string>;
    expect(environment.ALLOW_UNSAFE_QUERY_AND_FIELDS_API_PARAMS).toBe('false');
  });
  it('uses the safe query default in the Kubernetes chart and honors explicit overrides', () => {
    const env = chartEnv('admin123', '', undefined, '', 'http://localhost:3001');
    expect(env.find((e) => e.name === 'ALLOW_UNSAFE_QUERY_AND_FIELDS_API_PARAMS')?.value).toBe(
      'false',
    );
    expect(
      chartEnv('admin123', '', undefined, '', 'http://localhost:3001', {
        ALLOW_UNSAFE_QUERY_AND_FIELDS_API_PARAMS: 'true',
      }).find((e) => e.name === 'ALLOW_UNSAFE_QUERY_AND_FIELDS_API_PARAMS')?.value,
    ).toBe('true');
  });
});
