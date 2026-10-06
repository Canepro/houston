import * as presets from '../../../src/lib/presets/index';
import { ownedKubeconfig } from '../../../src/core/kube/exec';
import { CONTEXT as KUBE_CONTEXT } from '../../../src/core/kube/names';
import { type Metadata, metadata } from '../../../src/core/runner/record';

import { summary } from '../../../src/core/lifecycle/inspect';
import {
  type NoteGroup,
  flattenNotes,
  noteGroup,
  noteGroupsOf,
} from '../../../src/core/lifecycle/notes';

describe('note groups', () => {
  it('renders the flat form byte for byte against earlier releases', () => {
    // Indentation is the contract the flat form has: a four-space line is something to
    // paste, and the CLI and the browser both parse it. The padding counts CODE POINTS, which
    // is why this is compared rather than assumed.
    // What earlier releases built and flattened for the same four groups, recorded.
    const recorded = {
      groups: [
        {
          title: 'G',
          kind: 'k',
          rows: [
            ['a', 1],
            ['muchlonger', 'x'],
          ],
          body: ['b'],
          commands: ['c'],
        },
        { title: 'Empty', kind: '', rows: [], body: [], commands: [] },
        { title: 'Bare', kind: '', rows: [], body: [], commands: ['one'] },
        {
          title: 'Unicode',
          kind: '',
          rows: [
            ['λ', 1],
            ['wide', 2],
          ],
          body: [],
          commands: [],
        },
      ],
      flat: [
        'G:',
        '    a           1',
        '    muchlonger  x',
        'b',
        '    c',
        'Empty:',
        'Bare:',
        '    one',
        'Unicode:',
        '    λ     1',
        '    wide  2',
      ],
    };
    const groups = [
      noteGroup('G', {
        rows: [
          ['a', 1],
          ['muchlonger', 'x'],
        ],
        body: ['b'],
        commands: ['c'],
        kind: 'k',
      }),
      noteGroup('Empty'),
      noteGroup('Bare', { commands: ['one'] }),
      noteGroup('Unicode', {
        rows: [
          ['λ', 1],
          ['wide', 2],
        ],
      }),
    ];
    expect(groups).toEqual(recorded.groups);
    expect(flattenNotes(groups)).toEqual(recorded.flat);
  });

  it('drops nothing a builder put in and keeps the three sections apart', () => {
    const group = noteGroup('Title', {
      rows: [['key', 'value']],
      body: ['know'],
      commands: ['paste'],
    });
    expect(group).toEqual({
      title: 'Title',
      kind: '',
      rows: [['key', 'value']],
      body: ['know'],
      commands: ['paste'],
    });
    expect(flattenNotes([group])).toEqual(['Title:', '    key  value', 'know', '    paste']);
  });
});

function record(values: Partial<Metadata>): Metadata {
  return metadata({
    rcVersion: '8.5.1',
    rcImage: 'i',
    mongoTag: '8.0',
    mongoFlavor: 'official',
    preset: 'default',
    rootUrl: 'http://localhost:3000',
    hostPort: 3000,
    versionSource: 'map',
    ...values,
  });
}

/** A Kubernetes workspace record, as `repro.json` holds one. */
function k8sMeta(extra: Record<string, unknown> = {}): Metadata {
  return record({
    name: 'old',
    project: 'houston-old',
    extra: {
      runtime: 'kubernetes',
      deployment: 'microservices',
      namespace: 'houston-old',
      context: 'kind-houston-local',
      release: 'rocketchat',
      bind_host: '127.0.0.1',
      mongo_managed_by: 'statefulset',
      mongo_image: 'mongo:8.0',
      ...extra,
    },
  });
}

const titled = (groups: readonly NoteGroup[]): Record<string, NoteGroup> =>
  Object.fromEntries(groups.map((group) => [group.title, group]));
const bodyOf = (groups: readonly NoteGroup[]): string =>
  groups.flatMap((group) => group.body).join(' ');

describe('which notes a record produces', () => {
  it('leaves no stray heading for an empty group, and no heading for an untitled one', () => {
    // A group is built unconditionally and filled conditionally -- the operator note only
    // exists on one MongoDB path.
    expect(flattenNotes([noteGroup('Monitoring')])).toEqual(['Monitoring:']);
    expect(flattenNotes([])).toEqual([]);
    expect(flattenNotes([noteGroup('', { body: ['a bare line'] })])).toEqual(['a bare line']);
  });

  it("groups a compose workspace's add-ons, and a plain one gets no empty sections", () => {
    // The edge lines and the monitoring block were appended to one flat list, so a
    // monitored workspace behind HTTPS had five unrelated bullets in a row. Same words,
    // three sections -- and derived, so an older record gets them as well.
    const meta = record({
      name: 'c',
      project: 'houston-c',
      publicUrl: 'https://c.example.test',
      extra: { edge: true, tls: 'local', monitoring: true },
    });
    const groups = titled(noteGroupsOf(meta));
    expect(Object.keys(groups)).toEqual(['HTTPS', 'Monitoring']);
    expect((groups.HTTPS?.body ?? []).join(' ')).toContain('https://c.example.test');
    expect((groups.Monitoring?.body ?? []).some((note) => note.includes('Grafana'))).toBe(true);
    meta.extra = {};
    meta.publicUrl = '';
    expect(noteGroupsOf(meta)).toEqual([]);
  });

  it("says which host a shared workspace's preset pages are on, and only when they need it", () => {
    // phpLDAPadmin, MinIO's console, Mailpit's inbox and the livechat page all print
    // `localhost`, written when the browser was assumed to be on the docker host. On a
    // workspace bound wide or given a public URL, `localhost` names the reader's own
    // machine. A preset builder never sees the bind or the URL, so the record corrects it.
    const ldap = (extra: Record<string, unknown>) =>
      record({
        name: 'w',
        project: 'p',
        preset: 'ldap',
        rootUrl: 'http://localhost:3007',
        hostPort: 3007,
        versionSource: 't',
        extra,
      });
    const shared = bodyOf(
      noteGroupsOf(
        ldap({
          sidecar_ports: [8082],
          bind_host: '0.0.0.0',
          advertised_url: 'http://box.example.com:3007',
        }),
      ),
    );
    expect(shared).toContain('box.example.com:8082');
    // Name the thing being corrected, not just the fix.
    expect(shared).toContain('localhost');
    // Bound wide with no URL given: the host is unknown, so it is not invented.
    expect(bodyOf(noteGroupsOf(ldap({ sidecar_ports: [8082], bind_host: '0.0.0.0' })))).toContain(
      '<this-box>:8082',
    );
    const heading = "Reaching this preset's own pages";
    // An ordinary laptop workspace gains nothing: localhost really is localhost...
    expect(
      noteGroupsOf(ldap({ sidecar_ports: [8082], bind_host: '127.0.0.1' })).map((g) => g.title),
    ).not.toContain(heading);
    // ...and a preset with no pages of its own has nothing to correct.
    expect(noteGroupsOf(ldap({ bind_host: '0.0.0.0' })).map((g) => g.title)).not.toContain(heading);
    // THE CORRECTION MUST NOT DESCRIBE TEXT THAT IS NOT THERE: a saml workspace with a
    // derived idp_host already prints the real host, and the first version told its reader
    // "the URLs above say localhost" about notes that said no such thing.
    const saml = noteGroupsOf(
      record({
        name: 's',
        project: 'p',
        preset: 'saml',
        rootUrl: 'http://localhost:3007',
        hostPort: 3007,
        versionSource: 't',
        extra: {
          sidecar_ports: [8081],
          bind_host: '0.0.0.0',
          advertised_url: 'http://box.example.com:3007',
          params: { idp_host: 'box.example.com' },
        },
      }),
    );
    expect(saml.map((group) => group.title)).not.toContain(heading);
    expect(bodyOf(saml)).not.toContain('localhost');
  });

  it("carries the preset's notes derived on every read, not the copy the record froze", () => {
    // A note written into repro.json at create time kept its wording for the life of the
    // workspace -- which is how a Kubernetes workspace went on saying `backup` had no path
    // on that runtime for three releases after it grew one.
    const s = summary(
      record({
        name: 'x',
        project: 'houston-x',
        preset: 'oidc',
        extra: { notes: ['a sentence some older release wrote down'] },
      }),
    );
    expect(s.notes).toEqual(
      flattenNotes([
        noteGroup('Scenario · oidc', { kind: 'scenario', body: presets.load('oidc', {}).notes }),
      ]),
    );
    expect(s.notes).not.toContain('a sentence some older release wrote down');
    // The scenario has to be MARKED as one: the panel feeds it into its links card.
    expect((s.note_groups as NoteGroup[]).map((group) => group.kind)).toEqual(['scenario']);
    expect((s.notes as string[]).some((note) => note.includes('/etc/hosts'))).toBe(true);
  });

  it('names a managed cluster by its short name and region, and says it bills', () => {
    // The Cluster row held the sixty-character ARN; the panel and `info` showed it as
    // the only way to learn where a workspace ran, and nothing said the cluster costs.
    const rowsFor = (context: string): [string, string][] =>
      (noteGroupsOf(
        record({
          name: 'w',
          project: 'houston-w',
          rcImage: 'registry.rocket.chat/rocketchat/rocket.chat:8.5.1',
          mongoFlavor: 'community',
          versionSource: 'shipped',
          extra: { runtime: 'kubernetes', namespace: 'houston-w', context, deployment: 'monolith' },
        }),
      ).find((group) => group.title === 'Kubernetes')?.rows ?? []) as [string, string][];
    const eks = rowsFor('arn:aws:eks:us-east-1:1:cluster/support');
    expect(eks).toContainEqual(['Cluster', 'support · us-east-1 · EKS']);
    expect(eks.find(([key]) => key === 'Costs')?.[1]).toContain('bills by the hour');
    // The local cluster reads as it always did, and costs nothing.
    const kind = rowsFor(KUBE_CONTEXT);
    expect(kind).toContainEqual(['Cluster', KUBE_CONTEXT]);
    expect(kind.some(([key]) => key === 'Costs')).toBe(false);
  });

  it('exports a kubeconfig only for the cluster houston itself made', () => {
    // On a cluster houston ADOPTED, `export KUBECONFIG=<houston's own>` is wrong three
    // ways -- it made no cluster, that file does not describe yours, and your kubectl
    // already pointed at the right one -- so pasting step 1 broke the shell.
    const noteText = (context: string): string =>
      flattenNotes(
        noteGroupsOf(
          record({
            name: 'w',
            project: 'houston-w',
            rcImage: 'registry.rocket.chat/rocketchat/rocket.chat:8.5.1',
            mongoFlavor: 'community',
            versionSource: 'shipped',
            extra: {
              runtime: 'kubernetes',
              namespace: 'houston-w',
              context,
              deployment: 'monolith',
            },
          }),
        ),
      ).join('\n');
    const ours = noteText(KUBE_CONTEXT);
    expect(ours).toContain('export KUBECONFIG=');
    expect(ours).toContain(ownedKubeconfig());
    const adopted = noteText('default');
    expect(adopted).not.toContain('export KUBECONFIG=');
    // "a cluster you supplied" was wrong for every EKS cluster houston built itself; the
    // note describes the kubeconfig mechanism, which is the same either way.
    expect(adopted).not.toContain('you supplied');
    expect(adopted).toContain('an existing cluster');
    expect(adopted).not.toContain(ownedKubeconfig());
    expect(adopted).toContain("'default'");
    // houston never moves kubectl's current context, so the note may not promise the
    // commands below already reach this cluster: on a real EKS build the current context
    // was the user's own, and "# expect <cluster>" sent them looking for a fault.
    expect(adopted).not.toContain('# expect');
    expect(adopted).toContain('# if it is not default: kubectl config use-context default');
  });

  it('says the MongoDB operator is shared exactly when it is used', () => {
    // The official guide installs the operator INTO the Rocket.Chat namespace; houston
    // installs it once in houston-system. Undocumented, the guide's `kubectl -n <ns> get
    // pods` finds no operator and the reader concludes it was never installed.
    const groupsFor = (managedBy: string) =>
      titled(
        noteGroupsOf(
          record({
            name: 'k',
            project: 'houston-k',
            extra: {
              runtime: 'kubernetes',
              deployment: 'microservices',
              namespace: 'houston-k',
              context: 'kind-houston-local',
              release: 'rocketchat',
              mongo_managed_by: managedBy,
              mongo_image: 'mongo:8.0',
            },
          }),
        ),
      );
    const rowsOf = (group: NoteGroup | undefined) =>
      (group?.rows ?? []).map((row) => JSON.stringify([...row]));
    const op = groupsFor('operator');
    const shared = op['The MongoDB operator is shared'];
    expect((shared?.body ?? []).join(' ')).toContain('official guide');
    // It says where to look, not just that it is elsewhere.
    expect((shared?.commands ?? []).some((c) => c.includes('get mongodbcommunity'))).toBe(true);
    expect(rowsOf(op.MongoDB)).toContain(JSON.stringify(['Managed by', 'the official operator']));
    // Monitoring deviates the same way and for the same reason, on both paths.
    expect((op.Monitoring?.body ?? []).join(' ')).toContain(
      'shared by the cluster, not installed per',
    );
    // A plain StatefulSet has no operator to explain, and says so where the guide would
    // have led someone to expect authentication.
    const sts = groupsFor('statefulset');
    expect(Object.keys(sts)).not.toContain('The MongoDB operator is shared');
    expect(rowsOf(sts.MongoDB)).toContain(JSON.stringify(['Authentication', 'none']));
    expect((sts.MongoDB?.body ?? []).join(' ')).toContain('official guide');
  });

  it('does not repeat the URL as a note on loopback, and warns when bound wide', () => {
    // "reachable on this box at http://localhost:3000" was the fourth copy of that string
    // on one screen. What is said nowhere else is what a NON-loopback bind means.
    const quiet = noteGroupsOf(k8sMeta());
    expect(quiet.map((group) => group.title)).not.toContain('Reachable from other machines');
    expect(flattenNotes(quiet).filter((note) => note.includes('reachable on this box'))).toEqual(
      [],
    );
    const loud = titled(noteGroupsOf(k8sMeta({ bind_host: '0.0.0.0' })));
    const warned = (loud['Reachable from other machines']?.body ?? []).join(' ');
    expect(warned).toContain('0.0.0.0');
    // What it exposes.
    expect(warned).toContain('admin123');
    // The port-forward comes back the way it was published, or the workspace is
    // unreachable from the machines the note just warned about.
    expect(loud['2 · Open the way in']?.commands[0]).toContain('--address 0.0.0.0');
  });
});
