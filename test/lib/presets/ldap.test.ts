/**
 * The ldap preset's Directory lab parameters: groups and a service bind.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { choiceParam, safeLoadAll } from '../../../src/lib/presets/common';
import {
  AD_SEED,
  GENERATOR,
  SHIPPED_USERS_MAX,
  withCertificate,
} from '../../../src/lib/presets/ldap';
import { load, loadMany, resolve } from '../../../src/lib/presets/index';
import type { Preset } from '../../../src/lib/presets/types';

function ldifOf(preset: Preset): string {
  return (preset.files.find(([file]) => file.endsWith('.ldif')) as [string, string])[1];
}

/** The members of one posixGroup in an LDIF. */
function membersOf(ldif: string, cn: string): string[] {
  const block = ldif.split('\n\n').find((entry) => entry.startsWith(`dn: cn=${cn},`)) ?? '';
  return block
    .split('\n')
    .filter((line) => line.startsWith('memberUid: '))
    .map((line) => line.slice('memberUid: '.length));
}

describe('--set groups=on', () => {
  it('adds the lab groups, with the last user left out of rocket-chat', () => {
    const ldif = ldifOf(load('ldap', { users: '4', groups: 'on' }));
    expect(membersOf(ldif, 'rocket-chat')).toEqual(['user1', 'user2', 'user3']);
    expect(membersOf(ldif, 'rocket-admin')).toEqual(['user1']);
    expect(membersOf(ldif, 'employee')).toEqual(['user1', 'user2', 'user3', 'user4']);
    // The group every release has seeded is still there, still with everyone.
    expect(membersOf(ldif, 'rc-users')).toHaveLength(4);
  });

  it('lets only rocket-chat log in, matching memberUid against the username', () => {
    expect(load('ldap', { groups: 'on' }).env).toMatchObject({
      OVERWRITE_SETTING_LDAP_Group_Filter_Enable: 'true',
      OVERWRITE_SETTING_LDAP_Group_Filter_ObjectClass: 'posixGroup',
      OVERWRITE_SETTING_LDAP_Group_Filter_Group_Member_Attribute: 'memberUid',
      OVERWRITE_SETTING_LDAP_Group_Filter_Group_Member_Format: '#{username}',
      OVERWRITE_SETTING_LDAP_Group_Filter_Group_Name: 'rocket-chat',
    });
  });

  it("maps rocket-admin to admin and employee to #employees, in both releases' spellings", () => {
    const env = load('ldap', { groups: 'on' }).env;
    expect(env).toMatchObject({
      OVERWRITE_SETTING_LDAP_Sync_User_Data_Roles: 'true',
      OVERWRITE_SETTING_LDAP_Sync_User_Data_Roles_BaseDN: 'ou=groups,dc=example,dc=com',
      OVERWRITE_SETTING_LDAP_Sync_User_Data_Roles_Filter:
        '(&(cn=#{groupName})(memberUid=#{username}))',
      OVERWRITE_SETTING_LDAP_Sync_User_Data_RolesMap: '{"rocket-admin":"admin"}',
      OVERWRITE_SETTING_LDAP_Sync_User_Data_ChannelsMap: '{"employee":"employees"}',
      // The ids before 4.0.0 renamed them.
      OVERWRITE_SETTING_LDAP_Sync_User_Data_GroupsMap: '{"rocket-admin":"admin"}',
      OVERWRITE_SETTING_LDAP_Sync_User_Data_Groups_AutoChannelsMap: '{"employee":"employees"}',
    });
  });

  it('changes nothing when it is off', () => {
    const plain = load('ldap', {});
    expect(plain).toEqual(load('ldap', { groups: 'off', bind: 'admin' }));
    expect(Object.keys(plain.env).some((key) => key.includes('Group_Filter'))).toBe(false);
    expect(membersOf(ldifOf(plain), 'rocket-chat')).toEqual([]);
  });
});

describe('--set bind=service', () => {
  it('binds Rocket.Chat as the read-only user osixia creates, on both runtimes', () => {
    const preset = load('ldap', { bind: 'service' });
    expect(preset.env).toMatchObject({
      OVERWRITE_SETTING_LDAP_Authentication_UserDN: 'cn=readonly,dc=example,dc=com',
      OVERWRITE_SETTING_LDAP_Authentication_Password: 'readonly',
    });
    expect(preset.services.openldap?.environment).toMatchObject({
      LDAP_READONLY_USER: 'true',
      LDAP_READONLY_USER_USERNAME: 'readonly',
    });
    const kube = resolve('ldap', 'kubernetes', { bind: 'service' });
    const deployment = kube.kubernetesManifests
      .flatMap((manifest) => safeLoadAll(manifest))
      .find((doc) => (doc as { kind?: string }).kind === 'Deployment') as {
      spec: { template: { spec: { containers: { env: { name: string; value: string }[] }[] } } };
    };
    expect(deployment.spec.template.spec.containers[0]?.env).toEqual(
      expect.arrayContaining([{ name: 'LDAP_READONLY_USER', value: 'true' }]),
    );
  });
});

describe('the lab parameters', () => {
  it('refuse a value outside their choices, naming them', () => {
    expect(() => load('ldap', { groups: 'yes' })).toThrow(
      "--set groups='yes' expects one of: off, on",
    );
    expect(() => choiceParam({ bind: 'root' }, 'bind', ['admin', 'service'])).toThrow(
      'expects one of: admin, service',
    );
  });

  it('qualify as ldap.* when composed', () => {
    const both = loadMany(['ldap', 'email'], { ldap: { groups: 'on' } }, 'docker');
    expect(both.env.OVERWRITE_SETTING_LDAP_Group_Filter_Enable).toBe('true');
    expect(Object.keys(both.paramsHelp)).toEqual(
      expect.arrayContaining(['ldap.groups', 'ldap.bind']),
    );
  });
});

describe('a directory too large to ship', () => {
  /** What the generator writes for these params, run the way the container runs it. */
  function generate(env: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-gen-'));
    try {
      const script = path.join(dir, 'gen-users.sh');
      const out = path.join(dir, 'out.ldif');
      fs.writeFileSync(script, GENERATOR);
      const run = spawnSync('sh', [script, out], {
        env: { ...process.env, ...env },
        encoding: 'utf8',
      });
      expect(run.status).toBe(0);
      return fs.readFileSync(out, 'utf8');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('is generated byte for byte as houston ships it, groups and all', () => {
    for (const [users, groups] of [
      ['0', 'off'],
      ['1', 'on'],
      ['37', 'off'],
      ['37', 'on'],
    ] as const) {
      const shipped = ldifOf(load('ldap', { users, groups, domain: 'corp.example.org' }));
      expect(
        generate({
          HOUSTON_LDAP_USERS: users,
          HOUSTON_LDAP_BASE_DN: 'dc=corp,dc=example,dc=org',
          HOUSTON_LDAP_DOMAIN: 'corp.example.org',
          HOUSTON_LDAP_GROUPS: groups,
        }),
      ).toBe(shipped);
    }
  });

  it('ships the generator instead of the LDIF past 500 users, on both runtimes', () => {
    expect(SHIPPED_USERS_MAX).toBe(500);
    const at = load('ldap', { users: '500' });
    expect(at.files.map(([file]) => file)).toEqual(['ldap/50-rc-users.ldif']);
    const big = load('ldap', { users: '130000', groups: 'on' });
    expect(big.files.map(([file]) => file)).toEqual(['ldap/gen-users.sh']);
    expect(big.services.openldap).toMatchObject({
      entrypoint: [
        '/bin/sh',
        '-c',
        expect.stringContaining('&& exec /container/tool/run --copy-service'),
      ],
      environment: { HOUSTON_LDAP_USERS: '130000', HOUSTON_LDAP_GROUPS: 'on' },
    });
    // The ConfigMap a client-side apply annotates is the script, not 37 MB of LDIF.
    const kube = resolve('ldap', 'kubernetes', { users: '130000' }).kubernetesManifests.join('\n');
    expect(Buffer.byteLength(kube)).toBeLessThan(262_144);
    expect(kube).toContain('gen-users.sh');
  });
});

describe('--set tls=ldaps|starttls', () => {
  const CERT = { crt: 'LEAF-PEM', key: 'KEY-PEM', ca: 'CA-PEM' };

  it("serves LDAPS on 636 or StartTLS on 389, with houston's files and no client certificate", () => {
    const ldaps = load('ldap', { tls: 'ldaps' });
    expect(ldaps.env).toMatchObject({
      OVERWRITE_SETTING_LDAP_Port: '636',
      OVERWRITE_SETTING_LDAP_Encryption: 'ssl',
      OVERWRITE_SETTING_LDAP_Reject_Unauthorized: 'true',
    });
    expect(ldaps.services.openldap?.environment).toMatchObject({
      LDAP_TLS_CRT_FILENAME: 'ldap.crt',
      LDAP_TLS_CA_CRT_FILENAME: 'ca.crt',
      LDAP_TLS_VERIFY_CLIENT: 'never',
    });
    expect(ldaps.services.openldap?.volumes).toEqual(
      expect.arrayContaining([
        './ldap/certs/ldap.key:/container/service/slapd/assets/certs/ldap.key:ro',
      ]),
    );
    expect(ldaps.extra).toEqual({ directory_tls: 'ldaps', directory_trust: 'houston' });
    expect(load('ldap', { tls: 'starttls' }).env).toMatchObject({
      OVERWRITE_SETTING_LDAP_Port: '389',
      OVERWRITE_SETTING_LDAP_Encryption: 'tls',
    });
    expect(load('ldap', {}).extra).toEqual({});
  });

  it('gets the certificate as files on Compose and a Secret on Kubernetes, and the CA unless trust=none', () => {
    const docker = withCertificate(load('ldap', { tls: 'ldaps' }), CERT, 'docker');
    expect(docker.files.map(([file]) => file)).toEqual(
      expect.arrayContaining(['ldap/certs/ldap.crt', 'ldap/certs/ldap.key', 'ldap/certs/ca.crt']),
    );
    expect(docker.env.OVERWRITE_SETTING_LDAP_CA_Cert).toBe('CA-PEM');
    const untrusted = withCertificate(
      load('ldap', { tls: 'ldaps', trust: 'none' }),
      CERT,
      'docker',
    );
    expect('OVERWRITE_SETTING_LDAP_CA_Cert' in untrusted.env).toBe(false);
    const kube = withCertificate(
      resolve('ldap', 'kubernetes', { tls: 'starttls' }),
      CERT,
      'kubernetes',
    );
    const docs = kube.kubernetesManifests.flatMap((manifest) => safeLoadAll(manifest)) as {
      kind: string;
      metadata: { name: string };
      stringData?: Record<string, string>;
      spec?: { template: { spec: { volumes: { name: string }[] } } };
    }[];
    expect(
      docs.find((doc) => doc.kind === 'Secret' && doc.metadata.name === 'openldap-tls')?.stringData,
    ).toEqual({
      'ldap.crt': 'LEAF-PEM',
      'ldap.key': 'KEY-PEM',
      'ca.crt': 'CA-PEM',
    });
    const deployment = docs.find(
      (doc) => doc.kind === 'Deployment' && doc.metadata.name === 'openldap',
    );
    // LDAPS is reachable through the Service, not only inside the pod.
    const service = (
      resolve('ldap', 'kubernetes', { tls: 'ldaps' }).kubernetesManifests.flatMap((manifest) =>
        safeLoadAll(manifest),
      ) as { kind: string; metadata: { name: string }; spec: { ports: { port: number }[] } }[]
    ).find((doc) => doc.kind === 'Service' && doc.metadata.name === 'openldap');
    expect(service?.spec.ports.map((port) => port.port)).toEqual([389, 636]);
    expect(deployment?.spec?.template.spec.volumes.map((volume) => volume.name)).toEqual([
      'bootstrap',
      'tls',
    ]);
  });
});

describe('--set directory=ad', () => {
  const AD = { directory: 'ad' };

  it('points Rocket.Chat at Samba as AD, through the LDAP_AD_* fields it reads in that mode', () => {
    const env = load('ldap', AD).env;
    expect(env).toMatchObject({
      OVERWRITE_SETTING_LDAP_Server_Type: 'ad',
      OVERWRITE_SETTING_LDAP_Host: 'samba-ad',
      OVERWRITE_SETTING_LDAP_BaseDN: 'DC=example,DC=com',
      OVERWRITE_SETTING_LDAP_Authentication_UserDN: 'CN=Administrator,CN=Users,DC=example,DC=com',
      OVERWRITE_SETTING_LDAP_AD_User_Search_Field: 'sAMAccountName',
      OVERWRITE_SETTING_LDAP_AD_Username_Field: 'sAMAccountName',
      OVERWRITE_SETTING_LDAP_Unique_Identifier_Field: 'objectGUID',
      OVERWRITE_SETTING_LDAP_User_Search_Filter:
        '(&(objectCategory=person)(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))',
    });
    // The plain fields are not what an `ad` server type reads, so they are not set at all.
    expect('OVERWRITE_SETTING_LDAP_User_Search_Field' in env).toBe(false);
  });

  it('lets in only rocket-chat members through the nesting, and syncs by in-chain membership', () => {
    const env = load('ldap', { ...AD, groups: 'on', bind: 'service' }).env;
    expect(env.OVERWRITE_SETTING_LDAP_User_Search_Filter).toContain(
      '(memberOf:1.2.840.113556.1.4.1941:=CN=rocket-chat,OU=Groups,DC=example,DC=com)',
    );
    expect(env).toMatchObject({
      OVERWRITE_SETTING_LDAP_Sync_User_Data_Roles_BaseDN: 'OU=Groups,DC=example,DC=com',
      OVERWRITE_SETTING_LDAP_Sync_User_Data_Roles_Filter:
        '(&(objectClass=group)(cn=#{groupName})(member:1.2.840.113556.1.4.1941:=#{userdn}))',
      OVERWRITE_SETTING_LDAP_Authentication_UserDN: 'CN=readonly,CN=Users,DC=example,DC=com',
    });
    expect('OVERWRITE_SETTING_LDAP_Group_Filter_Enable' in env).toBe(false);
  });

  it('runs Samba in place of OpenLDAP on Compose, seeded by the script, phpLDAPadmin on it', () => {
    const preset = load('ldap', AD);
    expect(Object.keys(preset.services)).toEqual(['samba-ad', 'phpldapadmin']);
    expect(preset.services['samba-ad']).toMatchObject({
      image: expect.stringMatching(/^smblds\/smblds@sha256:[0-9a-f]{64}$/u),
      entrypoint: ['/bin/sh', '-c', expect.stringContaining('/entrypoint.d/50-houston-seed')],
      environment: { REALM: 'EXAMPLE.COM', DOMAIN: 'EXAMPLE', INSECURE_LDAP: 'true' },
    });
    expect(preset.services.phpldapadmin?.environment).toMatchObject({
      PHPLDAPADMIN_LDAP_HOSTS: 'samba-ad',
    });
    expect(preset.files).toEqual([['ldap/ad-seed.sh', AD_SEED]]);
    expect(preset.dependsOn).toEqual(['samba-ad']);
  });

  it('is the same seed on Kubernetes, with LDAPS on the Service and the certificate for samba-ad', () => {
    const kube = resolve('ldap', 'kubernetes', { ...AD, tls: 'ldaps' });
    const docs = kube.kubernetesManifests.flatMap((manifest) => safeLoadAll(manifest)) as {
      kind: string;
      metadata: { name: string };
      data?: Record<string, string>;
      spec?: { ports?: { port: number }[] };
    }[];
    expect(docs.map((doc) => `${doc.kind}/${doc.metadata.name}`)).toEqual([
      'ConfigMap/samba-ad-seed',
      'Deployment/samba-ad',
      'Service/samba-ad',
      'Deployment/phpldapadmin',
      'Service/phpldapadmin',
    ]);
    expect(docs[0]?.data).toEqual({ 'ad-seed.sh': AD_SEED });
    expect(docs[2]?.spec?.ports?.map((port) => port.port)).toEqual([389, 636]);
    expect(kube.extra).toEqual({
      directory_tls: 'ldaps',
      directory_trust: 'houston',
      directory_host: 'samba-ad',
    });
    expect(kube.env.OVERWRITE_SETTING_LDAP_Encryption).toBe('ssl');
  });

  it('changes nothing when it is openldap', () => {
    expect(load('ldap', { directory: 'openldap' })).toEqual(load('ldap', {}));
    expect(() => load('ldap', { directory: 'ldap' })).toThrow('expects one of: openldap, ad');
  });
});

describe("the AD directory's seed", () => {
  /** Run the seed as the image runs it, with an `ldbadd` that keeps what it was given. */
  function seed(dir: string, env: Record<string, string>): string {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, 'ldbadd'),
      '#!/bin/sh\ncat "$3" >> "$(dirname "$2")/added.ldif"\n',
      {
        mode: 0o755,
      },
    );
    const script = path.join(dir, 'ad-seed.sh');
    fs.writeFileSync(script, AD_SEED);
    const run = spawnSync('sh', [script], {
      env: {
        ...process.env,
        PATH: `${bin}:${String(process.env.PATH)}`,
        HOUSTON_AD_PRIVATE: dir,
        HOUSTON_LDAP_BASE_DN: 'DC=example,DC=com',
        HOUSTON_LDAP_DOMAIN: 'example.com',
        HOUSTON_LDAP_GROUPS: 'off',
        HOUSTON_LDAP_SERVICE: 'off',
        ...env,
      },
      encoding: 'utf8',
    });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    return fs.readFileSync(path.join(dir, 'added.ldif'), 'utf8');
  }

  /** The values of one attribute of one entry. */
  function values(ldif: string, dn: string, attribute: string): string[] {
    const entry = ldif.split('\n\n').find((block) => block.startsWith(`dn: ${dn}\n`)) ?? '';
    return entry
      .split('\n')
      .filter((line) => line.startsWith(`${attribute}: `) || line.startsWith(`${attribute}:: `))
      .map((line) => line.slice(line.indexOf(' ') + 1));
  }

  it("gives each user AD's unicodePwd: the password quoted, UTF-16LE, base64", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-ad-'));
    try {
      const ldif = seed(dir, { HOUSTON_LDAP_USERS: '12', HOUSTON_LDAP_SERVICE: 'on' });
      for (const [name, parent] of [
        ['user1', 'OU=Users'],
        ['user12', 'OU=Users'],
        ['readonly', 'CN=Users'],
      ]) {
        const dn = `CN=${String(name)},${String(parent)},DC=example,DC=com`;
        expect(values(ldif, dn, 'unicodePwd')).toEqual([
          Buffer.from(`"${String(name)}"`, 'utf16le').toString('base64'),
        ]);
        expect(values(ldif, dn, 'userPrincipalName')).toEqual([`${String(name)}@example.com`]);
        expect(values(ldif, dn, 'userAccountControl')).toEqual(['512']);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('nests rocket-chat > staff > all but the last user, and seeds once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-ad-'));
    try {
      const env = { HOUSTON_LDAP_USERS: '4', HOUSTON_LDAP_GROUPS: 'on' };
      const ldif = seed(dir, env);
      const group = (cn: string) => values(ldif, `CN=${cn},OU=Groups,DC=example,DC=com`, 'member');
      const users = (...n: number[]) =>
        n.map((i) => `CN=user${String(i)},OU=Users,DC=example,DC=com`);
      expect(group('rocket-chat')).toEqual(['CN=staff,OU=Groups,DC=example,DC=com']);
      expect(group('staff')).toEqual(users(1, 2, 3));
      expect(group('rocket-admin')).toEqual(users(1));
      expect(group('employee')).toEqual(users(1, 2, 3, 4));
      // A restart runs the seed again; the directory is already there, so nothing is added.
      expect(seed(dir, env)).toBe(ldif);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('--set idp=saml|oidc', () => {
  type Realm = {
    users: unknown[];
    clients: { clientId: string }[];
    requiredActions?: { alias: string; defaultAction: boolean }[];
    components: Record<
      string,
      {
        config: Record<string, string[]>;
        subComponents: Record<string, { name: string; config: Record<string, string[]> }[]>;
      }[]
    >;
  };
  const realmOf = (preset: Preset): Realm =>
    JSON.parse(
      (preset.files.find(([file]) => file === 'ldap/keycloak-realm.json') as [string, string])[1],
    ) as Realm;
  const directoryOf = (realm: Realm) =>
    realm.components[
      'org.keycloak.storage.UserStorageProvider'
    ]?.[0] as Realm['components'][string][number];
  const mapper = (realm: Realm, name: string) =>
    directoryOf(realm).subComponents['org.keycloak.storage.ldap.mappers.LDAPStorageMapper']?.find(
      (m) => m.name === name,
    )?.config;

  it('puts a Keycloak federating the directory in front, with no users of its own', () => {
    const preset = load('ldap', { idp: 'saml' });
    expect(Object.keys(preset.services)).toEqual(['openldap', 'phpldapadmin', 'keycloak']);
    expect(preset.dependsOn).toEqual(['openldap', 'keycloak']);
    expect(preset.ports).toEqual([8082, 8081]);
    const realm = realmOf(preset);
    expect(realm.users).toEqual([]);
    expect(realm.clients.map((client) => client.clientId)).toEqual(['houston-saml-sp']);
    expect(directoryOf(realm).config).toMatchObject({
      vendor: ['other'],
      connectionUrl: ['ldap://openldap:389'],
      bindDn: ['cn=admin,dc=example,dc=com'],
      usernameLDAPAttribute: ['uid'],
      editMode: ['READ_ONLY'],
    });
    // A realm import creates no mappers, so the username one has to be there.
    expect(mapper(realm, 'username')).toMatchObject({ 'ldap.attribute': ['uid'] });
    expect(mapper(realm, 'groups')).toMatchObject({ 'membership.ldap.attribute': ['memberUid'] });
    // Rocket.Chat keeps its LDAP login and gains SAML, with the IdP's certificate fetched.
    expect(preset.env).toMatchObject({
      OVERWRITE_SETTING_LDAP_Enable: 'true',
      OVERWRITE_SETTING_SAML_Custom_Default_entry_point:
        'http://localhost:8081/realms/houston/protocol/saml',
    });
    expect(preset.postReady.map((step) => step.action)).toEqual([
      'saml_idp_cert',
      'keycloak_master_ssl_off',
    ]);
  });

  it("follows the AD flavour's attributes and nesting, and asks for TOTP with mfa=on", () => {
    const kube = resolve('ldap', 'kubernetes', { directory: 'ad', idp: 'oidc', mfa: 'on' });
    const docs = kube.kubernetesManifests.flatMap((manifest) => safeLoadAll(manifest)) as {
      kind: string;
      metadata: { name: string };
      data?: Record<string, string>;
    }[];
    const realmText = docs.find((doc) => doc.metadata.name === 'keycloak-realm')?.data?.[
      'houston-realm.json'
    ];
    const realm = JSON.parse(String(realmText)) as Realm;
    expect(directoryOf(realm).config).toMatchObject({
      vendor: ['ad'],
      connectionUrl: ['ldap://samba-ad:389'],
      usernameLDAPAttribute: ['sAMAccountName'],
      uuidLDAPAttribute: ['objectGUID'],
    });
    expect(mapper(realm, 'groups')).toMatchObject({
      'user.roles.retrieve.strategy': ['LOAD_GROUPS_BY_MEMBER_ATTRIBUTE_RECURSIVELY'],
    });
    expect(realm.requiredActions).toEqual([
      expect.objectContaining({ alias: 'CONFIGURE_TOTP', defaultAction: true }),
    ]);
    expect(realm.clients.map((client) => client.clientId)).toEqual(['rc-oidc']);
    expect(docs.map((doc) => `${doc.kind}/${doc.metadata.name}`)).toEqual(
      expect.arrayContaining(['Deployment/samba-ad', 'Deployment/keycloak', 'Service/keycloak']),
    );
    expect(kube.ports).toEqual([8082, 8085]);
    expect(kube.postReady.map((step) => step.action)).toEqual([
      'keycloak_master_ssl_off',
      'create_oauth_provider',
    ]);
    expect(kube.notes.join('\n')).toContain('127.0.0.1  keycloak');
  });

  it('refuses mfa without an IdP, and a second Keycloak beside the saml preset', () => {
    expect(() => load('ldap', { mfa: 'on' })).toThrow('add --set idp=saml or idp=oidc');
    expect(() => loadMany(['ldap', 'saml'], { ldap: { idp: 'saml' } }, 'docker')).toThrow(
      'both define the service "keycloak"',
    );
    expect(load('ldap', { idp: 'none', mfa: 'off' })).toEqual(load('ldap', {}));
  });
});
