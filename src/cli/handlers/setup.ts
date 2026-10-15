/** CLI setup questions use the same progressively overlaid snapshot as GET /api/setup. */
import * as setup from '../../core/setup';
import { active } from '../../lib/jsonout';
import { ValidationError } from '../../lib/errors';
import type { Invocation } from '../app';
import { confirm, setupAnswer } from './prompt';

type SetupSnapshot = Awaited<ReturnType<typeof setup.snapshot>>;

/** The same facts shown by `onboard --show` and an interactive pre-confirm review. */
export function humanLines(view: SetupSnapshot): string[] {
  const { selection, environment, capacity, compatibility, license } = view;
  const tools = Object.entries(environment.tools)
    .map(([name, available]) => `${name} ${available ? 'yes' : 'no'}`)
    .join(', ');
  const capacityFact = capacity.applicable
    ? `${capacity.status}: ${String(capacity.observed_cpu)} CPU / ` +
      `${String(capacity.observed_memory_gib)} GiB (needs ${String(capacity.required_cpu)} CPU / ` +
      `${String(capacity.required_memory_gib)} GiB)` +
      (capacity.remediation !== '' ? ` — ${capacity.remediation}` : '')
    : 'not applicable';
  const licenseFact = `${license.status}${license.required ? ` (token ${license.supplied ? 'supplied' : 'absent'})` : ''}`;
  const seedDeferred = license.seed_deferred ? `yes — ${license.remediation}` : 'no';
  return [
    `deployment  ${selection.deployment}`,
    `scenarios   ${selection.scenarios.join(', ') || '(none)'}`,
    `seed        ${selection.seed_profile}`,
    `retain runs ${String(selection.retain_runs)}`,
    `host        ${environment.os} ${environment.os_version} · ${environment.architecture} · ` +
      `${String(environment.cpus)} CPU · ${String(environment.memory_gib)} GiB`,
    `engine      ${environment.engine_provider} · ${String(environment.engine_cpus)} CPU · ` +
      `${String(environment.engine_memory_gib)} GiB · microservices ready ` +
      `${environment.microservices_ready ? 'yes' : 'no'}`,
    `capacity    ${capacityFact}`,
    `tools       ${tools}`,
    `kernel      ${environment.engine_kernel_version || 'unavailable'} · MongoDB ` +
      `${compatibility.mongo_version}: ${compatibility.status}` +
      (compatibility.remediation !== '' ? ` — ${compatibility.remediation}` : ''),
    `licence     ${licenseFact}`,
    `seed deferred ${seedDeferred}`,
    ...view.gates.map((gate) => `  ${gate.code}: ${gate.message}`),
    `first run   ${view.first_run_command || '(blocked)'}`,
  ];
}

export async function run(invocation: Invocation) {
  const o = invocation.options;
  const patch: setup.SetupPatch = {};
  if (typeof o.deployment === 'string' && o.deployment !== '') patch.deployment = o.deployment;
  if (Array.isArray(o.scenario) && o.scenario.length > 0)
    patch.scenarios =
      (o.scenario as string[]).length === 1 && o.scenario[0] === 'none'
        ? []
        : (o.scenario as string[]);
  if (typeof o.seed_profile === 'string' && o.seed_profile !== '')
    patch.seed_profile = o.seed_profile;
  if (typeof o.retain_runs === 'boolean') patch.retain_runs = o.retain_runs;
  const section = typeof o.section === 'string' ? o.section : '';
  if (o.show === true) {
    if (Object.keys(patch).length > 0 || o.accept_defaults === true || o.reconfigure === true)
      throw new ValidationError('--show is read-only and cannot be combined with setup writes');
    return { ...(await setup.snapshot({ section })), action: 'show' };
  }
  const defaults = o.accept_defaults === true;
  if (active() && !defaults && Object.keys(patch).length === 0)
    throw new ValidationError(
      'JSON setup requires --show, --accept-defaults, or explicit setup choices',
    );
  if (!active() && !defaults && Object.keys(patch).length === 0) {
    // Rebuild after each answer so deployment-dependent questions follow the current draft.
    for (const sec of setup.SECTIONS) {
      if (section !== '' && section !== sec) continue;
      const live = await setup.snapshot({ draft: patch, section: sec });
      for (const q of live.questions) {
        if (q.answered && o.reconfigure !== true && section === '') continue;
        const fallback = Array.isArray(q.value) ? q.value.join(',') : String(q.value);
        const answer = await setupAnswer(
          q.prompt +
            (q.choices.length > 0 ? ` (${q.choices.map((choice) => choice.id).join(' | ')})` : ''),
          fallback,
        );
        if (q.kind === 'boolean') {
          if (!['true', 'false', 'yes', 'no', 'y', 'n'].includes(answer.toLowerCase()))
            throw new ValidationError('answer must be true or false');
          const value = ['true', 'yes', 'y'].includes(answer.toLowerCase());
          if (q.grant !== undefined) patch.grants = { ...patch.grants, [q.grant]: value };
          else patch.retain_runs = value;
        } else if (q.id === 'deployment') patch.deployment = answer;
        else if (q.id === 'scenarios')
          patch.scenarios = answer.toLowerCase() === 'none' ? [] : answer;
        else if (q.id === 'seed_profile') patch.seed_profile = answer;
      }
    }
    const review = await setup.snapshot({ draft: patch, section });
    process.stdout.write(`${humanLines(review).join('\n')}\n`);
    if (!(await confirm('Apply these setup choices?')))
      return { ...(await setup.snapshot({ section })), action: 'cancelled' };
  }
  const changed = defaults || Object.keys(patch).length > 0;
  return {
    ...(await setup.applyPatch(patch, { defaults, section })),
    action: changed ? 'setup' : 'unchanged',
  };
}
