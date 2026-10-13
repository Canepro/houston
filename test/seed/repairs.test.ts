import type * as ModNS from '../../src/seed/repairs';

describe('the repairs a killed seed leaves behind', () => {
  afterEach(() => {
    jest.resetModules();
  });

  function load() {
    jest.resetModules();
    const registered: [string, unknown][] = [];
    const settings: [string, unknown][] = [];
    jest.doMock('../../src/core/journal', () => ({
      RATE_LIMITER_OFF: 'rate_limiter_off',
      EMAIL_2FA_OFF: 'email_2fa_off',
      E2EE_DEFAULT_OFF: 'e2ee_default_off',
      EMAIL_2FA_SETTING: 'Accounts_TwoFactorAuthentication_By_Email_Enabled',
      registerRepair: (kind: string, handler: unknown) => registered.push([kind, handler]),
    }));
    jest.doMock('../../src/core/runner/record', () => ({
      readMeta: (name: string) =>
        Promise.resolve({ name, rootUrl: `http://${name}`, adminPassword: 'pw' }),
      adminPass: (meta: { adminPassword: string }) => meta.adminPassword,
    }));
    jest.doMock('../../src/core/rcapi', () => ({
      setSetting: (_u: string, _a: unknown, _p: string, sid: string, value: unknown) => {
        settings.push([sid, value]);
        return Promise.resolve(true);
      },
    }));
    return { mod: require('../../src/seed/repairs') as typeof ModNS, registered, settings };
  }

  it('registers a handler for each kind of note the seeder writes', () => {
    // `apply.seed` records both around the settings it turns off, and the `finally` that
    // puts them back is the block a SIGKILL does not run.
    const { mod, registered } = load();
    mod.installJournalRepairs();
    expect(registered.map(([kind]) => kind)).toEqual([
      'rate_limiter_off',
      'email_2fa_off',
      'e2ee_default_off',
    ]);
  });

  it('puts the setting back ON, which is what the note means', () => {
    const { mod, registered, settings } = load();
    mod.installJournalRepairs();
    const entry = { workspace: 'TICKET-1', detail: { setting: 'E2E_Enabled_Default_DirectRooms' } };
    const login = () => Promise.resolve({ token: 't', userId: 'u' });
    return Promise.all(
      registered.map(([, handler]) =>
        (handler as (e: unknown, m: unknown, l: unknown) => Promise<boolean>)(entry, null, login),
      ),
    ).then((answers) => {
      expect(answers).toEqual([true, true, true]);
      expect(settings).toEqual([
        ['API_Enable_Rate_Limiter', true],
        ['Accounts_TwoFactorAuthentication_By_Email_Enabled', true],
        ['E2E_Enabled_Default_DirectRooms', true],
      ]);
    });
  });

  it('turns on only an encryption default the seeder turns off, whatever the note names', async () => {
    // The note is read back from disk: its setting is not trusted to name anything else.
    const { mod, registered, settings } = load();
    mod.installJournalRepairs();
    const handler = registered.find(([kind]) => kind === 'e2ee_default_off')?.[1] as (
      e: unknown,
      m: unknown,
      l: unknown,
    ) => Promise<boolean>;
    const login = () => Promise.resolve({ token: 't', userId: 'u' });
    const note = (setting: unknown) => ({ workspace: 'T', detail: { setting } });
    expect(await handler(note('Accounts_RegistrationForm'), null, login)).toBe(false);
    expect(await handler(note(undefined), null, login)).toBe(false);
    expect(settings).toEqual([]);
    expect(await handler(note('E2E_Force_Encryption_For_Private_Rooms'), null, login)).toBe(true);
    expect(settings).toEqual([['E2E_Force_Encryption_For_Private_Rooms', true]]);
  });

  it('answers false rather than guessing when there is no way to log in', async () => {
    // A repair that cannot authenticate has not repaired anything, and reporting success
    // would close a note over a setting still left off.
    const { mod, registered, settings } = load();
    mod.installJournalRepairs();
    const handler = registered[0]?.[1] as (e: unknown, m: unknown, l: unknown) => Promise<boolean>;
    expect(await handler({ workspace: 'T' }, null, null)).toBe(false);
    expect(await handler({ workspace: 'T' }, null, () => Promise.resolve(null))).toBe(false);
    expect(settings).toEqual([]);
  });
});
