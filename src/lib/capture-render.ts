/**
 * The human-readable evidence bundle, including an optional scripted browser capture.
 *
 * This renderer stays in `lib/`: it receives two already-sanitised records and touches no
 * filesystem or runtime state. Evidence owns collecting the workspace record and capture owns
 * producing its manifest; either can evolve without importing the other.
 */
import { toText } from './format';

function bag(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function markdownText(value: unknown): string {
  return toText(value)
    .replace(/[\r\n]+/gu, ' ')
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|');
}

function markdownCode(value: unknown): string {
  return markdownText(value).replaceAll('`', '\\`');
}

/** A capture artifact must remain relative to its capture directory before becoming a link. */
function captureArtifact(value: unknown): string {
  return toText(value)
    .replaceAll('\\', '/')
    .split('/')
    .filter((part) => part !== '' && part !== '.' && part !== '..')
    .join('/');
}

function kvTable(rows: readonly (readonly [string, string])[]): string[] {
  return [
    '| | |',
    '|---|---|',
    ...rows.filter(([, value]) => value !== '').map(([key, value]) => `| ${key} | ${value} |`),
  ];
}

/** Render the browser-capture section of an evidence README from its manifest alone. */
export function renderCaptureSection(value: unknown): string[] {
  const manifest = bag(value);
  const lines: string[] = [];
  const failed = bag(manifest.failed_step);
  if (toText(manifest.status) === 'failed') {
    const index = markdownText(failed.index) || '?';
    const action = markdownCode(failed.action) || '?';
    const target = markdownCode(failed.target) || '?';
    lines.push(
      `> **This capture did not complete.** It stopped at step ${index} (${action} ${target}). ` +
        'Treat the artifacts below as partial, not as proof of the behaviour. A workload ' +
        'written for another Rocket.Chat version is the usual cause.',
      '',
    );
  }

  lines.push('| # | Action | Target | Value | Result |', '|---|---|---|---|---|');
  const steps = Array.isArray(manifest.steps) ? manifest.steps : [];
  for (const item of steps) {
    const step = bag(item);
    const outcome = toText(step.outcome) || toText(step.status);
    const result =
      outcome === 'ok' ? 'ok' : outcome === '' ? 'unknown' : `**${markdownText(outcome)}**`;
    lines.push(
      `| ${markdownText(step.index)} | \`${markdownCode(step.action)}\` | ` +
        `\`${markdownCode(step.target)}\` | ${markdownText(step.value)} | ${result} |`,
    );
  }
  lines.push('');

  const privacy = bag(manifest.privacy);
  const masks = Array.isArray(privacy.masked_input_selectors)
    ? privacy.masked_input_selectors.map(markdownCode).filter((selector) => selector !== '')
    : [];
  lines.push(
    '## Privacy review',
    '',
    'Inspect every retained PNG frame and the video before attaching this bundle. Houston does not scan pixels, so a page can show a credential outside a masked input.',
  );
  if (masks.length > 0) {
    lines.push(
      `Houston covered known secret input${masks.length === 1 ? '' : 's'} ` +
        `(${masks.map((selector) => `\`${selector}\``).join(', ')}) before Playwright filled ${
          masks.length === 1 ? 'it' : 'them'
        }. The retained PNG frames and video show that cover instead of the direct control value.`,
    );
  } else {
    lines.push(
      'No masked input was recorded. That does not prove the visual artifacts are safe to attach.',
    );
  }
  lines.push(
    'The trace has no screenshots or DOM snapshots. Byte-level redaction checks known secret values in text artifacts, but it cannot prove that the page did not echo a value somewhere else.',
    '',
  );

  const shots = (Array.isArray(manifest.shots) ? manifest.shots : [])
    .map(captureArtifact)
    .filter((shot) => shot !== '');
  if (shots.length > 0) {
    lines.push('## Screenshots', '');
    for (const shot of shots) {
      const stem = shot.replace(/\.[^.]+$/u, '');
      const caption = stem.split('/').at(-1)?.split('-', 2)[1] ?? stem;
      lines.push(`![${markdownText(stem)}](capture/${shot})`, `*${markdownText(caption)}*`, '');
    }
  }

  const media: string[] = [];
  const video = captureArtifact(manifest.video);
  if (video !== '') media.push(`- Video: \`capture/${markdownCode(video)}\``);
  const stepFrames = steps.filter((item) => captureArtifact(bag(item).frame) !== '');
  if (stepFrames.length > 0) {
    media.push(
      `- Step-by-step frames: \`capture/steps/\` (${String(stepFrames.length)} frames, one per action; ` +
        'use these to locate the exact moment something changed)',
    );
  }
  const failureFrame = captureArtifact(manifest.failure_frame ?? manifest.failure_shot);
  if (failureFrame !== '')
    media.push(`- The page at failure: \`capture/${markdownCode(failureFrame)}\``);
  const trace = captureArtifact(manifest.trace);
  if (trace !== '') {
    const viewer = trace.endsWith('.zip')
      ? ` (open with \`npx playwright show-trace capture/${markdownCode(trace)}\`)`
      : '';
    media.push(`- Trace: \`capture/${markdownCode(trace)}\`${viewer}`);
  }
  if (media.length === 0) media.push('- No video or trace was produced for this run.');
  lines.push('## Recording', '', ...media, '');

  const validation = (Array.isArray(manifest.validation) ? manifest.validation : []).map(bag);
  const missing = validation.filter((row) => toText(row.status) === 'fail');
  const suspect = validation.filter((row) => toText(row.status) === 'suspect');
  if (missing.length > 0 || suspect.length > 0) {
    lines.push('## Artifact validation', '');
    for (const row of missing)
      lines.push(`- **MISSING:** ${markdownText(row.detail) || markdownText(row.artifact)}`);
    for (const row of suspect)
      lines.push(`- **SUSPECT:** ${markdownText(row.detail) || markdownText(row.artifact)}`);
    lines.push('');
  } else if (validation.length > 0) {
    lines.push(`*Artifact validation: all ${String(validation.length)} checks passed.*`, '');
  }
  return lines;
}

/** Render the one README a support reader opens from a secret-safe evidence record. */
export function renderMarkdown(payloadValue: unknown, captureValue?: unknown): string {
  const payload = bag(payloadValue);
  const repro = bag(payload.repro);
  const license = bag(payload.license);
  const runtime = bag(payload.runtime);
  const name = markdownCode(repro.name) || '?';
  let mongo = markdownText(repro.mongo_tag);
  if (mongo !== '' && toText(repro.mongo_flavor) !== '')
    mongo += ` (${markdownText(repro.mongo_flavor)})`;
  const url = markdownText(repro.public_url) || markdownText(repro.root_url);
  const lines = [
    `# Workspace \`${name}\` — Rocket.Chat ${markdownText(repro.rc_version) || '?'}`,
    '',
  ];

  const capture = bag(captureValue);
  if (toText(capture.description) !== '') lines.push(markdownText(capture.description), '');
  lines.push(
    ...kvTable([
      ['Rocket.Chat', `${markdownText(repro.rc_version)} (\`${markdownCode(repro.rc_image)}\`)`],
      ['MongoDB', mongo],
      ['Runtime', markdownText(repro.runtime)],
      ['Deployment', markdownText(repro.deployment)],
      ['Preset', markdownText(repro.preset) || 'none'],
      ['URL', url],
      ['Created', markdownText(repro.created_at)],
      // A credential was handed to the deployment; nothing here saw Rocket.Chat accept it.
      [
        'Licence',
        license.supplied === true
          ? `credential supplied (${license.source === 'license' ? 'licence file' : license.source === 'reg_token' ? 'registration token' : 'type unknown'}); acceptance not verified${license.required === true || license.required === false ? '' : '; requirement unknown'}`
          : license.supplied === false
            ? license.required === true
              ? 'none supplied (required)'
              : license.required === false
                ? 'none supplied (not required)'
                : 'none supplied (requirement unknown)'
            : license.required === true || license.required === false
              ? 'unknown (credential presence could not be determined)'
              : 'unknown (credential presence could not be determined; requirement unknown)',
      ],
      ['State', markdownText(runtime.state)],
    ]),
    '',
    '## Reproduction',
    '',
  );
  if (Object.keys(capture).length === 0) {
    lines.push(
      'This bundle records workspace metadata and any available configuration. ' +
        'Runtime deployment was not verified. ' +
        'No scripted capture was run, so user actions were not recorded. ' +
        'Include a scripted capture with a later collection to record those actions.',
      '',
    );
  } else {
    lines.push(...renderCaptureSection(capture));
  }

  const services = Array.isArray(runtime.services) ? runtime.services : [];
  if (services.length > 0) {
    lines.push('## Runtime', '', '| Service | State | Status |', '|---|---|---|');
    for (const item of services) {
      const service = bag(item);
      lines.push(
        `| ${markdownText(service.service)} | ${markdownText(service.state)} | ` +
          `${markdownText(service.status)} |`,
      );
    }
    lines.push('');
  }
  // The record owns shell quoting. A fenced block must keep that command byte for byte,
  // including the final newline a legacy workspace name can legitimately contain.
  const cleanup = toText(bag(payload.retention).cleanup);
  if (cleanup !== '') lines.push('## Cleanup', '', '```bash', cleanup, '```', '');
  return lines.join('\n');
}
