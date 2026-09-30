import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { AuthorityGateError, ConflictError, EXIT_CODES, NotFoundError } from '../../src/lib/errors';
import * as presets from '../../src/lib/presets/index';
import * as seedPlan from '../../src/seed/plan';
import { getHoustonVersion } from '../../src/lib/jsonout';

import {
  HOSTS,
  SIDECAR,
  SKILL_DIR,
  SKILL_FILE,
  hostSkillDir,
  hostState,
  install,
  packaged,
  projectCopy,
  sha256,
  state,
  target,
} from '../../src/core/skill';

const ROOT = path.resolve(__dirname, '..', '..');

let skillHome: string;

function sidecarOf(host: string): string {
  return path.join(path.dirname(target(host)), SIDECAR);
}

beforeEach(() => {
  // A disposable HOME, not HOUSTON_HOME: this module writes where an AGENT looks, which
  // is the developer's real `~/.claude` unless something points it elsewhere. That is
  // exactly what `HOUSTON_SKILL_HOME` exists for.
  skillHome = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-skillhome-'));
  process.env.HOUSTON_SKILL_HOME = skillHome;
});

afterEach(() => {
  fs.rmSync(skillHome, { recursive: true, force: true });
  delete process.env.HOUSTON_SKILL_HOME;
});

describe('the packaged skill', () => {
  it('is found through the package-data lookup, not through the checkout layout', () => {
    // houston has no bundler precisely because one rewrites this lookup. A skill
    // that cannot be found reports "reinstall houston" to somebody whose install is fine.
    expect(fs.existsSync(packaged())).toBe(true);
    expect(packaged().endsWith(path.join('data', 'skill', SKILL_FILE))).toBe(true);
  });
});

describe('hosts', () => {
  it('knows the two conventions an agent actually reads', () => {
    expect(Object.keys(HOSTS).sort()).toEqual(['agents', 'claude']);
    expect(target('claude')).toBe(path.join(skillHome, '.claude', 'skills', SKILL_DIR, SKILL_FILE));
    expect(target('agents')).toBe(path.join(skillHome, '.agents', 'skills', SKILL_DIR, SKILL_FILE));
  });

  it('raises NotFoundError for a host it does not know, naming the ones it does', () => {
    expect(() => target('emacs')).toThrow(NotFoundError);
    expect(() => target('emacs')).toThrow(/want agents \| claude or all/u);
    expect(() => hostSkillDir('emacs')).toThrow(NotFoundError);
  });

  it('refuses an unknown host as earlier releases do: quoted their way, and an own key', () => {
    // The host is quoted the way earlier releases quote it, where this once hard-coded
    // single quotes: `--host "o'x"` printed `'o'x'` where earlier releases print `"o'x"`.
    // And a known host is an OWN key of HOSTS: `HOSTS.constructor` is `Object`, so
    // `--host constructor` went on to join a function into a path and died unhandled
    // where earlier releases refuse it as an unknown host.
    const hosts = ["o'x", 'a\\b', 'x\ty', 'constructor', '__proto__', 'toString', 'emacs'];
    const ours = hosts.map((host) => {
      try {
        install(host);
        return ['ok', ''];
      } catch (error) {
        return [(error as Error).name, (error as Error).message];
      }
    });
    expect(ours[0]).toEqual([
      'NotFoundError',
      'unknown skill host "o\'x" (want agents | claude or all)',
    ]);
    expect(ours[3]?.[0]).toBe('NotFoundError');
  });

  it('owns the DIRECTORY a skill sits in, so a second caller cannot rebuild it wrongly', () => {
    // `migrate` needs the pre-rename copy, which sits BESIDE the current directory rather
    // than inside it. It used to derive that as `dirname(target(host))` -- the skill's own
    // directory, not its parent -- and so looked for `<host>/houston/rc-repro` and never
    // found the `<host>/rc-repro` that `skill install` actually left behind.
    expect(hostSkillDir('claude')).toBe(path.join(skillHome, '.claude', 'skills', SKILL_DIR));
    expect(hostSkillDir('claude', 'rc-repro')).toBe(
      path.join(skillHome, '.claude', 'skills', 'rc-repro'),
    );
    expect(hostSkillDir('agents', 'rc-repro')).toBe(
      path.join(skillHome, '.agents', 'skills', 'rc-repro'),
    );
    // The file lives inside the directory, which is the relationship that was miscounted.
    expect(target('claude')).toBe(path.join(hostSkillDir('claude'), SKILL_FILE));
    // And the pre-rename copy is a SIBLING of the current one, never a child.
    expect(path.dirname(hostSkillDir('claude', 'rc-repro'))).toBe(
      path.dirname(hostSkillDir('claude')),
    );
  });

  it('keeps HOUSTON_SKILL_HOME as spelled in its paths and states, as earlier releases do', () => {
    // A current copy under `<home>/x`, then the same variable spelled four ways. `path.join`
    // folded the `..` and the two-slash root away, so `<home>/nonexistent/../x` found that
    // copy and said `current`, where earlier releases keep the spelling, the kernel
    // needs `nonexistent` to walk out of, and the answer is `absent`.
    process.env.HOUSTON_SKILL_HOME = path.join(skillHome, 'x');
    install('all');
    const rows = [
      `${skillHome}/nonexistent/../x`,
      `/${skillHome}/x`,
      `${skillHome}//x/`,
      `${skillHome}/./x`,
    ];
    const ours = rows.map((row) => {
      process.env.HOUSTON_SKILL_HOME = row;
      return Object.keys(HOSTS)
        .sort()
        .map((host) => [target(host), hostState(host).status]);
    });
    expect(ours[0]?.map(([, status]) => status)).toEqual(['absent', 'absent']);
  });
});

describe('the four states', () => {
  it('is absent before anything is installed', () => {
    expect(hostState('claude')).toEqual({
      host: 'claude',
      status: 'absent',
      path: target('claude'),
      version: '',
    });
  });

  it('is current straight after an install, and installing again changes nothing', () => {
    const first = install('claude');
    expect(first.hosts).toEqual([{ host: 'claude', path: target('claude'), action: 'installed' }]);
    expect(hostState('claude').status).toBe('current');

    const again = install('claude');
    expect(again.hosts[0]?.action).toBe('unchanged');
    expect(hostState('claude').status).toBe('current');
  });

  it('is STALE when the package moved on but the file is still what we wrote', () => {
    install('claude');
    // The sidecar still matches the installed file; only the packaged copy differs. That
    // is the "houston was upgraded" case, and it is safe to overwrite.
    const installed = fs.readFileSync(target('claude'), 'utf8');
    const older = `${installed}\n<!-- an older build wrote this -->\n`;
    fs.writeFileSync(target('claude'), older);
    fs.writeFileSync(
      sidecarOf('claude'),
      JSON.stringify({ houston_version: '0.1.0', sha256: sha256(older) }, null, 1) + '\n',
    );
    expect(hostState('claude').status).toBe('stale');
    expect(hostState('claude').version).toBe('0.1.0');
    expect(install('claude').hosts[0]?.action).toBe('updated');
    expect(hostState('claude').status).toBe('current');
  });

  it('is MODIFIED when a human edited it, and that is never overwritten silently', () => {
    install('claude');
    fs.appendFileSync(target('claude'), '\n<!-- my own note -->\n');
    expect(hostState('claude').status).toBe('modified');

    expect(() => install('claude')).toThrow(ConflictError);
    expect(() => install('claude')).toThrow(/edited locally.*--force/su);
    // And the edit survived the refusal.
    expect(fs.readFileSync(target('claude'), 'utf8')).toContain('my own note');

    expect(install('claude', { force: true }).hosts[0]?.action).toBe('updated');
    expect(hostState('claude').status).toBe('current');
  });

  it('treats a missing or unreadable sidecar as stale rather than as an edit', () => {
    // Without a recorded hash there is nothing to distinguish the two, and STALE is the
    // safe side: it offers a reinstall instead of refusing one.
    install('claude');
    fs.appendFileSync(target('claude'), '\nchanged\n');
    fs.rmSync(sidecarOf('claude'));
    expect(hostState('claude').status).toBe('stale');

    install('claude', { force: true });
    fs.appendFileSync(target('claude'), '\nchanged\n');
    fs.writeFileSync(sidecarOf('claude'), 'not json at all');
    expect(hostState('claude').status).toBe('stale');
  });
});

describe('the sidecar', () => {
  it('records the version and the sha256 of what was written', () => {
    install('claude');
    const side = JSON.parse(fs.readFileSync(sidecarOf('claude'), 'utf8')) as Record<string, string>;
    expect(side.houston_version).toBe(getHoustonVersion());
    expect(side.sha256).toBe(sha256(fs.readFileSync(packaged(), 'utf8')));
    expect(side.installed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/u);
  });

  it('is indented by one and ends in a newline, as earlier releases format it', () => {
    // JSON indented by one space plus a trailing newline -- indent ONE, not two. This
    // file lives outside HOUSTON_HOME, one of the two this module writes there.
    install('claude');
    const mine = fs.readFileSync(sidecarOf('claude'), 'utf8');
    // `{`, three keys, `}`, then the empty string the trailing newline leaves behind.
    expect(mine.split('\n')).toHaveLength(6);
    expect(mine.split('\n')[1]).toMatch(/^ "[a-z_]+": /u);
    expect(mine.split('\n').at(-1)).toBe('');
  });
});

describe('state()', () => {
  it('reports every host, and is not current while one is absent', () => {
    install('claude');
    const seen = state();
    expect(seen.hosts.claude?.status).toBe('current');
    expect(seen.hosts.agents?.status).toBe('absent');
    expect(seen.hosts.claude?.scope).toBe('user');
    // Absent is not current -- there is nothing to have read -- but it does not make the
    // present one stale either. `current` is "every copy that EXISTS matches".
    expect(seen.current).toBe(true);
  });

  it('is false when nothing is installed anywhere', () => {
    const seen = state();
    // The repo's own `.claude/skills/houston/SKILL.md` is a PROJECT copy and is found by
    // walking up from the working directory, so it may be present here. The user hosts
    // are the ones this assertion is about.
    expect(seen.hosts.claude?.status).toBe('absent');
    expect(seen.hosts.agents?.status).toBe('absent');
    if (seen.hosts.project === undefined) expect(seen.current).toBe(false);
  });

  it('is false when any copy that exists is stale', () => {
    install('all');
    fs.writeFileSync(target('agents'), 'an older skill');
    fs.rmSync(sidecarOf('agents'));
    expect(state().current).toBe(false);
  });

  it('never raises, whatever the home looks like', () => {
    process.env.HOUSTON_SKILL_HOME = path.join(skillHome, 'not', 'a', 'directory');
    expect(() => state()).not.toThrow();
    expect(state().hosts.claude?.status).toBe('absent');
  });
});

describe('projectCopy', () => {
  it('stops at a .claude it may not enter, as earlier releases do', () => {
    // Earlier releases stop there on the permission error, and state() reports no project copy;
    // existsSync said "no" and walked on to a parent's copy.
    const top = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-skillwalk-'));
    try {
      const parentCopy = path.join(top, '.claude', 'skills', SKILL_DIR);
      fs.mkdirSync(parentCopy, { recursive: true });
      fs.copyFileSync(packaged(), path.join(parentCopy, SKILL_FILE));
      const child = path.join(top, 'child');
      fs.mkdirSync(path.join(child, '.claude'), { recursive: true });
      fs.chmodSync(path.join(child, '.claude'), 0o000);
      let ours: string;
      try {
        ours = String(projectCopy(child));
      } catch (error) {
        ours = (error as Error).name;
      }
      expect(ours).toBe('FileError');
    } finally {
      fs.chmodSync(path.join(top, 'child', '.claude'), 0o700);
      fs.rmSync(top, { recursive: true, force: true });
    }
  });

  it('walks upward and finds a checkout copy', () => {
    const nested = path.join(skillHome, 'repo', 'deep', 'inside');
    fs.mkdirSync(path.join(skillHome, 'repo', '.claude', 'skills', SKILL_DIR), {
      recursive: true,
    });
    fs.mkdirSync(nested, { recursive: true });
    const here = path.join(skillHome, 'repo', '.claude', 'skills', SKILL_DIR, SKILL_FILE);
    fs.writeFileSync(here, 'the checkout copy');
    expect(projectCopy(nested)).toBe(here);
  });

  it('answers null when there is no checkout copy above the caller', () => {
    const alone = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-noskill-'));
    try {
      expect(projectCopy(alone)).toBeNull();
    } finally {
      fs.rmSync(alone, { recursive: true, force: true });
    }
  });
});

describe('the copies checked into the repository', () => {
  it('match the packaged skill, so a fresh clone teaches what an install would', () => {
    // Three copies of one file is how they drift; the packaged copy is what
    // `skill install` writes on a machine with no checkout.
    const want = fs.readFileSync(packaged(), 'utf8');
    for (const rel of ['.claude/skills/houston/SKILL.md', '.agents/skills/houston/SKILL.md']) {
      expect(fs.readFileSync(path.join(ROOT, rel), 'utf8')).toBe(want);
    }
  });
});

describe('the copy an agent actually reads', () => {
  const before = process.cwd();
  afterEach(() => {
    process.chdir(before);
  });

  it('is the checkout copy when there is one, and a stale one makes the state stale', () => {
    // An agent reads `.claude/skills/` relative to the PROJECT before a home directory, so
    // reporting only the home copy told a developer `current: false` about a current skill.
    const project = path.join(skillHome, 'checkout');
    const dir = path.join(project, '.claude', 'skills', SKILL_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const local = path.join(dir, SKILL_FILE);
    fs.writeFileSync(local, fs.readFileSync(packaged(), 'utf8'), 'utf8');
    process.chdir(project);
    const seen = state();
    expect(seen.hosts.project?.status).toBe('current');
    expect(seen.hosts.project?.scope).toBe('project');
    // Nothing in the home, and absent copies are not copies somebody read.
    expect(seen.hosts.claude?.status).toBe('absent');
    expect(seen.current).toBe(true);
    fs.writeFileSync(local, 'what an older branch shipped\n', 'utf8');
    expect(state().current).toBe(false);
  });

  it('is nowhere at all, which is not current', () => {
    const empty = path.join(skillHome, 'elsewhere');
    fs.mkdirSync(empty, { recursive: true });
    process.chdir(empty);
    expect(state().current).toBe(false);
  });
});

describe('where an install writes', () => {
  it('is where the agent looks, never into the houston state directory', () => {
    // The agent knows nothing about HOUSTON_HOME -- and a test that got this wrong would
    // write into the developer's real ~/.claude.
    const stateDir = path.join(skillHome, 'state');
    const previous = process.env.HOUSTON_HOME;
    process.env.HOUSTON_HOME = stateDir;
    try {
      install('all');
      expect(fs.existsSync(path.join(skillHome, '.claude', 'skills', SKILL_DIR, SKILL_FILE))).toBe(
        true,
      );
      expect(fs.existsSync(stateDir)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.HOUSTON_HOME;
      else process.env.HOUSTON_HOME = previous;
    }
  });
});

describe('the numbers the skill states', () => {
  // The skill states only numbers the build still confirms. A number in prose has no reader: the
  // skill said `standard` seeds 283 messages while the plan built 287. These are the claims in it
  // that a build change can falsify.
  const text = () => fs.readFileSync(packaged(), 'utf8');

  it('states the standard seed shape the plan builds', () => {
    const match =
      /`standard` is (\d+) rooms, (\d+) messages, (\d+) threads across (\d+) users/u.exec(text());
    expect(match).not.toBeNull();
    const plan = seedPlan.planFrom('standard');
    expect(match?.slice(1).map(Number)).toEqual([
      plan.rooms.length,
      seedPlan.planTotalMessages(plan),
      seedPlan.planTotalReplies(plan),
      plan.users,
    ]);
  });

  it('lists exactly the presets this build has, bar the deployment axis under its old name', () => {
    const sentence = text().split('`capabilities.presets` lists what this build has:')[1] ?? '';
    const listed = new Set(
      [...(sentence.split('.')[0] ?? '').matchAll(/`([a-z0-9_-]+)`/gu)].map((m) => m[1]),
    );
    const catalog = new Set(presets.listPresets().map((pre) => pre.name));
    expect([...listed].filter((name) => !catalog.has(name as string))).toEqual([]);
    expect([...catalog].filter((name) => !listed.has(name))).toEqual(['multi-instance']);
    expect(text()).toContain('--preset multi-instance');
  });

  it('tabulates the exit codes callers branch on, 6 included', () => {
    const bullets = [...text().matchAll(/^ {3}- `(\d)` /gmu)].map((m) => Number(m[1]));
    const codes = Object.keys(EXIT_CODES)
      .map(Number)
      .filter((code) => code !== 0);
    expect([...new Set(bullets)].sort()).toEqual(codes.sort());
    expect(AuthorityGateError.advertised).toBe(true);
  });

  it('carries a real version in its sample envelope', () => {
    const version = (
      JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }
    ).version;
    expect(text()).toContain(`"houston_version":"${version}"`);
  });
});
