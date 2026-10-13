import { ValidationError } from '../../../src/lib/errors';
import { load, loadMany, resolve, scenarioNames } from '../../../src/lib/presets/index';
import { EMAIL_2FA } from '../../../src/lib/presets/common';
import { E2EE_TEST_USERS, refuseEnforcedBefore880 } from '../../../src/lib/presets/e2ee';

const FORCE = 'OVERWRITE_SETTING_E2E_Force_Encryption_For_Private_Rooms';

/** The E2E settings a preset writes, without the prefix. */
function e2eSettings(params: Record<string, unknown> = {}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(load('e2ee', params).env)
      .filter(([key]) => key.startsWith('OVERWRITE_SETTING_E2E_'))
      .map(([key, value]) => [key.slice('OVERWRITE_SETTING_'.length), value]),
  );
}

describe('the e2ee preset', () => {
  it('turns encryption on and leaves new rooms to people by default', () => {
    expect(e2eSettings()).toEqual({
      E2E_Enable: 'true',
      E2E_Enabled_Default_DirectRooms: 'false',
      E2E_Enabled_Default_PrivateRooms: 'false',
      E2E_Enable_Encrypt_Files: 'true',
      E2E_Allow_Unencrypted_Messages: 'false',
    });
  });

  it('encrypts new DMs and private rooms with policy=default, and forces private rooms only when enforced', () => {
    expect(e2eSettings({ policy: 'default' })).toMatchObject({
      E2E_Enabled_Default_DirectRooms: 'true',
      E2E_Enabled_Default_PrivateRooms: 'true',
    });
    expect(e2eSettings({ policy: 'default' })).not.toHaveProperty(
      'E2E_Force_Encryption_For_Private_Rooms',
    );
    expect(e2eSettings({ policy: 'enforced' })).toMatchObject({
      E2E_Enabled_Default_DirectRooms: 'true',
      E2E_Enabled_Default_PrivateRooms: 'true',
      E2E_Force_Encryption_For_Private_Rooms: 'true',
    });
  });

  it('sets file encryption and plaintext acceptance from their switches', () => {
    expect(e2eSettings({ files: 'off', allow_unencrypted: 'on' })).toMatchObject({
      E2E_Enable_Encrypt_Files: 'false',
      E2E_Allow_Unencrypted_Messages: 'true',
    });
  });

  it('creates the test users after boot, with email two-factor off unless Mailpit is there', () => {
    const preset = load('e2ee');
    expect(preset.postReady).toEqual([{ action: 'e2ee_users' }]);
    expect(preset.env[EMAIL_2FA]).toBe('false');
    expect(preset.notes.join('\n')).toContain(E2EE_TEST_USERS.join(', '));
    expect(loadMany(['e2ee', 'email'], {}, 'docker').env[EMAIL_2FA]).toBe('true');
  });

  it('with users=off creates no one and leaves email two-factor alone', () => {
    const preset = load('e2ee', { users: 'off' });
    expect(preset.postReady).toEqual([]);
    expect(preset.env).not.toHaveProperty(EMAIL_2FA);
    expect(preset.softEnv).toEqual([]);
  });

  it('needs no service, port, licence or file, on either runtime', () => {
    expect(scenarioNames()).toContain('e2ee');
    for (const runtime of ['docker', 'kubernetes']) {
      const preset = resolve('e2ee', runtime, { policy: 'enforced' });
      expect(preset.env[FORCE]).toBe('true');
      expect([preset.services, preset.ports, preset.files, preset.kubernetesManifests]).toEqual([
        {},
        [],
        [],
        [],
      ]);
      expect(preset.requiresLicense).toBe(false);
    }
  });

  // A plain Error, as every preset's: `up` turns it into the usage error (exit 2).
  it.each([
    [{ policy: 'strict' }, "--set policy='strict' expects one of: optional, default, enforced"],
    [{ files: 'maybe' }, "--set files='maybe' expects one of: on, off"],
    [{ users: 'yes please' }, "--set users='yes please' expects one of: on, off"],
    [
      { mentions: 'on' },
      "unknown --set param(s) for preset 'e2ee': mentions - valid: allow_unencrypted, files, policy, users",
    ],
  ])('refuses %j, saying what it takes', (params, said) => {
    expect(() => load('e2ee', params)).toThrow(said);
  });
});

describe('policy=enforced on a Rocket.Chat before 8.8.0', () => {
  const enforced = load('e2ee', { policy: 'enforced' });

  it.each(['8.5.1', '7.10.0', '8.7.9'])(
    'is refused on %s, naming the version it needs',
    (version) => {
      expect(() => refuseEnforcedBefore880(enforced, version)).toThrow(
        new ValidationError(
          `e2ee policy=enforced needs Rocket.Chat 8.8.0 or later; ${version} would not enforce it. ` +
            'Choose a newer version, or policy=default.',
        ),
      );
    },
  );

  it.each(['8.8.0', '8.8.0-rc.1', '8.10.2', '9.0.0', 'develop'])(
    'is let through on %s',
    (version) => {
      expect(() => refuseEnforcedBefore880(enforced, version)).not.toThrow();
    },
  );

  it('leaves every other policy alone on an old version', () => {
    expect(() =>
      refuseEnforcedBefore880(load('e2ee', { policy: 'default' }), '6.0.0'),
    ).not.toThrow();
  });
});
