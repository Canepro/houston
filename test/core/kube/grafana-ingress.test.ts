import { kube } from '../../../src/core/kube/exec';
import { ensureGrafanaIngress } from '../../../src/core/kube/grafana-ingress';

afterEach(() => {
  jest.restoreAllMocks();
});

it('waits for a slow cluster to answer before routing Grafana for a workspace', async () => {
  // Whether the route, certificate and secret already exist are must-answer questions: a
  // refusal fails the attach. They carried the 8 s probe limit, so over a slow link to EKS
  // the attach failed on a question that only needed longer. Until the route is applied,
  // every kubectl question given less than 10 s times out, the way the seam reports it.
  let applied = false;
  jest.spyOn(kube, 'run').mockImplementation(async (argv, options = {}) => {
    const answer = (stdout = '') => ({ argv, returncode: 0, stdout, stderr: '' });
    if (argv.includes('apply')) {
      applied = true;
      return answer();
    }
    const limit = options.timeout ?? 0;
    if (!applied && argv.includes('get') && limit < 10) {
      return {
        argv,
        returncode: 127,
        stdout: '',
        stderr: `"kubectl" timed out after ${String(limit * 1000)} ms`,
      };
    }
    // Nothing there yet; once applied, the certificate is Ready.
    if (!applied) return answer();
    return answer(JSON.stringify({ status: { conditions: [{ type: 'Ready', status: 'True' }] } }));
  });
  await expect(
    ensureGrafanaIngress('w', {
      context: 'prod',
      publicUrl: 'https://w.rc.example.com',
      ingressClass: 'traefik',
      issuer: { mode: 'acme', acmeEmail: 'you@example.com' },
    }),
  ).resolves.toBeUndefined();
  expect(applied).toBe(true);
});
