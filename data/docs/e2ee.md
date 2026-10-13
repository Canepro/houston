# Encrypted conversations (E2EE)

The `e2ee` preset turns on Rocket.Chat's end-to-end encryption and creates three
test users. Everything else happens in Rocket.Chat, as it does for a customer: each
user's keys are made in their own browser the first time they sign in, and Rocket.Chat
shows their E2EE password once. Houston never holds a key or an E2EE password.

```bash
houston up --version 8.8.0 --name ticket-1234 --preset e2ee --wait
houston up --version 8.8.0 --name ticket-1234 --preset e2ee --set policy=enforced --wait
houston down --name ticket-1234 --volumes
```

## Options

Each option sets the Rocket.Chat setting of the same name under **Workspace >
Settings > End-to-end encryption**. End-to-end encryption itself is always on.

| `--set` | Rocket.Chat settings | Default |
|---|---|---|
| `policy=optional` | Encrypt direct messages: off. Encrypt private rooms: off. People choose per room. | yes |
| `policy=default` | Encrypt direct messages: on. Encrypt private rooms: on. People may turn it off. | |
| `policy=enforced` | As `default`, plus Force end-to-end encryption on private rooms. Needs Rocket.Chat 8.8.0 or later; an older version is refused, because it would ignore the setting. | |
| `files=on\|off` | Encrypt files | `on` |
| `allow_unencrypted=on\|off` | Unencrypted messages in encrypted rooms | `off` |
| `users=on\|off` | Creates `e2e-alice`, `e2e-bob` and `e2e-carol`, each with its username as its password | `on` |

Any other E2E setting, such as mentions, is an ordinary `--setting`:
`--setting E2E_Enabled_Mentions=true`.

## Try it

1. Open Rocket.Chat on **localhost or over HTTPS** (`--https`, or `--domain`). A
   browser encrypts only on a secure origin, so `http://<this machine's address>:<port>`
   from another computer will not work. On Kubernetes the workspace URL is a
   port-forward to localhost, which counts.
2. Sign in as `e2e-alice` in one browser profile and `e2e-bob` in another (a private
   window is a separate profile). Each sees **Save your new E2EE password**: copy it,
   then **I saved my password**. On another device, Rocket.Chat asks for it with
   **Enter your E2E password**.
3. Start an encrypted conversation: a DM's **⋮ > Enable E2EE**, or **Encrypted** under
   **Advanced Settings** when creating a private room. With `policy=default` or
   `enforced`, new DMs and private rooms are already encrypted.

## Sample data

Sample data works with every policy. Houston's seeder sends plaintext and cannot
encrypt, so while it runs it turns **Encrypt direct messages**, **Encrypt private
rooms** and **Force end-to-end encryption on private rooms** off, and turns them back on
when it ends. If the seed is killed, `houston ready` or the next `houston serve` turns
them back on.

The sample rooms are therefore unencrypted, like rooms that existed before the policy;
every room created after the seed follows the policy. Add encrypted content from the
browsers.

## Backups, restores and upgrades

They need nothing special. Users' keys live in the database, encrypted with each
user's E2EE password, so a backup carries them and a restore brings them back. After a
restore, people unlock their keys with the same E2EE passwords they saved.

## Rocket.Chat behaviours worth knowing

Seen on Rocket.Chat 8.5.1 and 8.8.0. Houston reproduces them; it does not patch the
server.

- **Enforced applies at creation.** A room's owner can still turn encryption off later
  through `/api/v1/groups.setEncrypted`.
- **`chat.postMessage` and incoming webhooks store plaintext** in an encrypted room
  even with `allow_unencrypted=off`; `chat.sendMessage` and the composer refuse it.
- **`files=off` with `allow_unencrypted=off` blocks uploads** in encrypted rooms, with
  the untranslated message `You_cant_send_unencrypted_files_in_an_encrypted_room`.
- **A new room's key can stick on one client**: that person sees "Check back later" or
  cannot read the others. Reloading their page fixes it.
- **Removing a member does not change the room key.**
