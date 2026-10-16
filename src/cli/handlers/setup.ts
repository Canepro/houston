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
    .map(
      ([name, available]) =>
        `${name} ${available ? 'yes' : 'no'}` +
        (environment.outdated_kubernetes_tools.includes(name) ? ' (outdated)' : ''),
    )
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
    `kubernetes  owned runtime ${environment.owned_kubernetes_runtime} · Kind provisioning ` +
      `${environment.kubernetes_provisioning_available ? 'available' : 'unavailable'}` +
      (selection.topology === 'kubernetes' &&
      !environment.microservices_ready &&
      environment.kubernetes_provisioning_available
        ? ' · first run requires provisioning'
        : ''),
    `capacity    ${capacityFact}`,
    `tools       ${tools}`,
    `kernel      ${environment.engine_kernel_version || 'unavailable'} · MongoDB ` +
      `${compatibility.mongo_version}: ${compatibility.status}` +
      (compatibility.remediation !== '' ? ` — ${compatibility.remediation}` : ''),
    `onboarding  ${view.persisted.completed_by === '' ? 'not completed' : `completed by ${view.persisted.completed_by}`}`,
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
  const reconfigure = o.reconfigure === true;
  // `--reconfigure` is the way to be asked again, so it never skips the questions or the
  // confirmation. Without a prompt to show, or with answers already filled in by defaults,
  // it has nothing to ask, and writing silently would be the opposite of what it says.
  if (reconfigure && (active() || defaults))
    throw new ValidationError(
      active()
        ? '--reconfigure asks the setup questions and a confirmation, which --json cannot show; run it in a terminal, or drop --reconfigure to apply the answers you passed'
        : '--reconfigure asks the setup questions, so it cannot be combined with --accept-defaults',
    );
  if (active() && !defaults && Object.keys(patch).length === 0)
    throw new ValidationError(
      'JSON setup requires --show, --accept-defaults, or explicit setup choices',
    );
  if (!active() && !defaults && (reconfigure || Object.keys(patch).length === 0)) {
    // Rebuild after each answer so deployment-dependent questions follow the current draft;
    // an answer already given on the command line is the default offered for its question.
    for (const sec of setup.SECTIONS) {
      if (section !== '' && section !== sec) continue;
      const live = await setup.snapshot({ draft: patch, section: sec });
      for (const q of live.questions) {
        if (q.answered && !reconfigure && section === '') continue;
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
  // Only a person at a terminal answering for themselves is a person. --accept-defaults,
  // JSON and piped writes fill safe answers, so prompts stop but nobody looked.
  const by = defaults || active() || process.stdin.isTTY !== true ? 'defaults' : 'person';
  const applied = await setup.applyPatch(patch, { defaults, section, by });
  const { changed, ...view } = applied;
  return {
    ...view,
    action: changed ? 'setup' : 'unchanged',
  };
}
