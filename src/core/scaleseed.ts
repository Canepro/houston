/**
 * Data-scale prefill for `seed --scale` -- bulk MongoDB inserts.
 *
 * The REST seed authors realistic, app-consistent content but is far too slow for scale
 * repros ("50k users", "a room with 800k messages won't load"): each message is a ~10-40ms
 * HTTP round trip. This path writes documents straight to MongoDB via mongosh `insertMany`
 * (tens of thousands/sec).
 *
 * TRADE-OFF, stated plainly: this BYPASSES Rocket.Chat's application hooks. The documents
 * are minimal-but-readable -- enough that RC lists/loads them (directory, admin user list,
 * room history, search) -- but bulk users have NO login credentials and messages fire no
 * notifications/mentions/threading side effects. Use it to reproduce SCALE and PERFORMANCE
 * behaviour, not feature behaviour; use the REST seed (default) when you need real,
 * loginable users.
 *
 * Everything runs through `docker compose exec mongodb` (mongosh, legacy `mongo`
 * fallback), mirroring `perf/mongoprof`.
 */
import { toBigInt, isPrintableText, numberText, quotedText, stripText } from '../lib/format';

import { databaseOf } from './database-of';
import { composeExecCapture } from './runner/engine';

/**
 * The DEFAULT database, kept only as the fallback when the workspace's own MONGO_URL
 * cannot be read.
 *
 * `env --set MONGO_URL=...` is a supported and documented override, and hardcoding this
 * meant the bulk insert (or the profiler) addressed a database Rocket.Chat was not reading
 * -- reporting `inserted: 50000` while the directory stayed empty, and `--clear-scale` then
 * reporting it had removed them, so the round trip was internally consistent and externally
 * wrong. `backup.databaseOf()` exists for exactly this reason and says so: "dumping the
 * wrong database would produce an empty backup that only looks fine."
 */
export const DB = 'rocketchat';

/** The database this workspace's Rocket.Chat actually uses. */
export async function dbOf(name: string): Promise<string> {
  // The shared lookup lives in `core/database-of.ts` and both this module and backup
  // import it, which is the layering rule's own resolution for a function two siblings
  // need. An empty answer falls back to `DB`: a lookup must never fail the insert.
  return (await databaseOf(name)) || DB;
}

async function uriFor(name: string): Promise<string> {
  return `mongodb://localhost:27017/${await dbOf(name)}`;
}

/** docs per insertMany -- well under the 16MB BSON cap */
const BATCH = 5000;
/** stamped on every doc so `seed --scale --clear` can undo it */
const SCALE_TAG = 'houston_scale';
/**
 * What rc-repro stamped. Only ever MATCHED, never written: it lives in the workspace's own
 * database, so a rename cannot reach it and documents seeded before the rename keep it for
 * as long as that database exists.
 */
const LEGACY_SCALE_TAG = 'rcrepro_scale';

// NOTE: RC prefixes most collections (rocketchat_room, rocketchat_message) but the users
// collection is plain `users` -- the JS below reflects that.

/**
 * Room names are whitelisted to `[\w-]` here, which is what keeps them out of the generated
 * JS as anything but a plain identifier. `quotedText` below is a second layer, NOT a
 * general-purpose JS escaper, so if this class is ever widened, switch the interpolation to
 * a JSON encoder.
 *
 * `\d` AND `\w` ARE UNICODE here: a digit is any Unicode decimal digit, a word character a
 * Unicode letter or number, or `_`. JavaScript's stay ASCII even under `/u`, so
 * `messages=5@général` and `users=٣` were refused here and have always run. Still no wider
 * than that class, so the note above holds: a letter, a digit, `_` or `-`. The shape below
 * is JavaScript's Unicode classes; `specOf` then holds each character to the Unicode 15.0
 * tables (`numberText`, `isPrintableText`) -- Node's are 17.0, and a character assigned
 * since is unassigned in 15.0, neither a digit nor printable (measured over every code
 * point: `\w` is exactly the characters of `[\p{L}\p{N}_]` that are printable).
 */
const SPEC_SHAPE = /^(users|messages)=(\p{Nd}+)(?:@([\p{L}\p{N}_-]+))?$/u;

/** `_SPEC_RE.match(part)`: `[kind, digits, room]`, or null. */
function specOf(part: string): [string, string, string | undefined] | null {
  const m = SPEC_SHAPE.exec(part);
  if (m === null) return null;
  const [, kind, digits, room] = m as unknown as [string, string, string, string | undefined];
  if (!/^[0-9]+$/u.test(numberText(digits))) return null;
  if (room !== undefined && !Array.from(room).every((ch) => isPrintableText(ch))) return null;
  return [kind, digits, room];
}

/** A guard against a mistyped digit, not a real ceiling. */
const MAX_DOCS = 20_000_000;

/** `n` with a comma between each group of three digits: `1,234,567`. */
export function withCommas(n: number | bigint): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
}

export interface ScaleSpec {
  users?: number;
  messages?: [number, string];
}

/**
 * `'users=50000,messages=800000@team-chat'` ->
 * `{users: 50000, messages: [800000, 'team-chat']}`. Throws on bad input.
 */
export function parseScale(spec: string): ScaleSpec {
  const out: ScaleSpec = {};
  for (const rawPart of spec.split(',')) {
    // `stripText(part)`: its whitespace set, where `trim` strips a BOM and keeps U+001C.
    const part = stripText(rawPart);
    if (part === '') continue;
    const m = specOf(part);
    if (m === null) {
      throw new Error(`bad --scale term ${quotedText(part)} (want users=N or messages=N@room)`);
    }
    const kind = m[0] as 'users' | 'messages';
    // `toBigInt` of the digits: the cap is tested, and a refusal quotes, the number typed.
    const n = toBigInt(m[1]);
    const room = m[2];
    if (kind in out) {
      // Previously last-wins: "messages=10@a,messages=20@b" silently kept only (20, 'b').
      throw new Error(`--scale sets ${kind} more than once - give it once`);
    }
    if (n > BigInt(MAX_DOCS)) {
      throw new Error(
        `${kind}=${withCommas(n)} exceeds the ${withCommas(MAX_DOCS)} safety cap - a mistyped ` +
          'digit would otherwise insert for hours with no progress output',
      );
    }
    if (kind === 'users') {
      if (room !== undefined) {
        // Previously accepted and silently dropped.
        throw new Error(
          `users=${String(n)} does not take a room (@${room}) - a room only ` +
            'applies to messages=N@room',
        );
      }
      out.users = Number(n);
    } else {
      if (room === undefined) throw new Error('messages=N needs a target room: messages=N@room');
      out.messages = [Number(n), room];
    }
  }
  return out;
}

async function evaluate(name: string, js: string): Promise<[number, string]> {
  // Wrap the body so a JS/Mongo error (e.g. a BulkWriteError) is printed as {error} on
  // STDOUT and the shell still exits 0. `composeExecCapture` drops stderr, so without this
  // a JS error would look like "empty output" -- and worse, the non-zero exit would trigger
  // the `mongo` fallback to RE-RUN the (non-idempotent) insert. The fallback is now
  // reserved for a genuinely missing mongosh binary (the shell fails to start -> rc != 0,
  // no output).
  const wrapped = `try {\n${js}\n} catch (e) { print(JSON.stringify({error: '' + e})); }`;
  const uri = await uriFor(name);
  let out = '';
  for (const shell of ['mongosh', 'mongo']) {
    const [rc, captured] = await composeExecCapture(name, 'mongodb', [
      shell,
      '--quiet',
      uri,
      '--eval',
      wrapped,
    ]);
    out = captured;
    if (rc === 0) return [rc, out];
    if (out.trim() !== '') {
      // The shell RAN and printed something, so the script executed at least partly. A
      // non-zero exit here means it was killed mid-flight (OOM, container stop, Ctrl-C) --
      // NOT that the binary is missing. Falling through would re-run a non-idempotent
      // insertMany and duplicate every batch already committed (and, for users, collide on
      // the unique index because `start` is recounted from the partial state).
      return [rc, out];
    }
  }
  return [1, out];
}

/**
 * Insert `count` minimal users (scaleuserN). No password -- not loginable.
 *
 * mongosh builds each batch itself, so the `--eval` string stays tiny.
 */
export async function bulkUsers(
  name: string,
  count: number,
  { batch = BATCH }: { batch?: number } = {},
): Promise<[number, string]> {
  const js = `
    var TOTAL = ${String(Math.trunc(count))}, BATCH = ${String(Math.trunc(batch))}, made = 0;
    var start = db['users'].countDocuments({'${SCALE_TAG}': true});
    for (var off = 0; off < TOTAL; off += BATCH) {
      var docs = [];
      for (var i = off; i < Math.min(off + BATCH, TOTAL); i++) {
        var n = start + i + 1;
        docs.push({
          createdAt: new Date(), _updatedAt: new Date(),
          username: 'scaleuser' + n, name: 'Scale User ' + n,
          emails: [{address: 'scaleuser' + n + '@scale.example', verified: true}],
          type: 'user', status: 'offline', active: true, roles: ['user'],
          '${SCALE_TAG}': true
        });
      }
      db['users'].insertMany(docs, {ordered: false});
      made += docs.length;
    }
    print(JSON.stringify({inserted: made}));
    `;
  return await evaluate(name, js);
}

/**
 * Insert `count` messages into `room` (by name or _id), then fix the room's msgs counter
 * and lastMessage so RC's UI stays consistent.
 */
export async function bulkMessages(
  name: string,
  count: number,
  room: string,
  { batch = BATCH }: { batch?: number } = {},
): Promise<[number, string]> {
  const quoted = quotedText(room);
  const js = `
    var room = db['rocketchat_room'].findOne({$or: [{name: ${quoted}}, {_id: ${quoted}}]});
    if (!room) { print(JSON.stringify({error: 'room not found: ' + ${quoted}})); } else {
      var TOTAL = ${String(Math.trunc(count))}, BATCH = ${String(Math.trunc(batch))}, made = 0;
      var author = {_id: 'rocket.cat', username: 'rocket.cat', name: 'Rocket.Cat'};
      var last = null;
      for (var off = 0; off < TOTAL; off += BATCH) {
        var docs = [];
        for (var i = off; i < Math.min(off + BATCH, TOTAL); i++) {
          last = {
            rid: room._id, msg: 'scale message ' + (i + 1),
            ts: new Date(), _updatedAt: new Date(), u: author,
            '${SCALE_TAG}': true
          };
          docs.push(last);
        }
        var r = db['rocketchat_message'].insertMany(docs, {ordered: false});
        made += docs.length;
        // PER BATCH, not once at the end. \`clear()\` decrements by the number of
        // TAGGED documents it finds, so a prefill killed after batch 1 of 10 left
        // 5000 tagged messages with the room counter never incremented -- and the
        // clear then subtracted 5000 from the room's real count. README says
        // "--clear-scale removes exactly what --scale added"; that only holds if the
        // counter is advanced as the documents land.
        db['rocketchat_room'].updateOne({_id: room._id},
          {$inc: {msgs: docs.length}, $set: {lm: new Date(), lastMessage: last}});
      }
      print(JSON.stringify({inserted: made, room: room._id}));
    }
    `;
  return await evaluate(name, js);
}

/**
 * Remove everything this module inserted (matched by the scale tag), and put each affected
 * room back to a consistent state: decrement its msgs counter and reset lastMessage/lm to
 * the newest REMAINING message (or clear them if the room is now empty) -- otherwise the
 * room would point at a deleted message.
 */
export async function clear(name: string): Promise<[number, string]> {
  // MATCHES THE PRE-RENAME TAG TOO. The tag is stamped into the WORKSPACE's own MongoDB,
  // not into anything this tool keeps, so it is the one leftover a rename cannot reach by
  // moving a directory: documents inserted by rc-repro carry `rcrepro_scale` for as long as
  // that database exists. Clearing only the new tag would leave a bulk seed permanently
  // unremovable -- the one operation `--clear` exists to provide -- with no error to explain
  // why nothing happened.
  const matchEither = `{$or: [{'${SCALE_TAG}': true}, ` + `{'${LEGACY_SCALE_TAG}': true}]}`;
  const js = `
    var perRoom = db['rocketchat_message'].aggregate([
      {$match: ${matchEither}},
      {$group: {_id: '$rid', n: {$sum: 1}}}
    ]).toArray();
    var u = db['users'].deleteMany(${matchEither}).deletedCount;
    var m = db['rocketchat_message'].deleteMany(${matchEither}).deletedCount;
    perRoom.forEach(function (g) {
      var newest = db['rocketchat_message'].find({rid: g._id}).sort({ts: -1}).limit(1).toArray()[0];
      var upd = {$inc: {msgs: -g.n}};
      if (newest) { upd.$set = {lastMessage: newest, lm: newest.ts}; }
      else { upd.$unset = {lastMessage: '', lm: ''}; }
      db['rocketchat_room'].updateOne({_id: g._id}, upd);
    });
    print(JSON.stringify({users: u, messages: m, rooms: perRoom.length}));
    `;
  return await evaluate(name, js);
}
