/** Synthetic dates for this receipt only; rich content is still created through REST. */
import { ConflictError, PreflightError } from '../lib/errors';
import type { SeedDatabase } from '../core/seed-db';
import { DISCUSSION } from './kinds';
import type { Plan } from './plan';
import type { Receipt } from './receipt';
import { type Bag, id, list } from './client';

const DAY = 86_400_000;
export interface DateChange {
  id: string;
  rid: string;
  old: string;
  ts: string;
  fileIds: readonly string[];
  attachments: readonly { index: number; ts: string }[];
  related?: boolean;
}

function timelineCoverage(receipt: Receipt, dates: readonly DateChange[]): Bag | null {
  const captured = new Set(
    [...receipt.entries.values()]
      .filter((e) => e.state === 'done' && /^(message|opening|notice|quote):/u.test(e.key))
      .map((e) => id(e.data.id)),
  );
  const covered = new Set(dates.map((m) => id(m.id)));
  const missing = [...captured].filter((mid) => !covered.has(mid));
  const unexpected = [...covered].filter((mid) => !captured.has(mid));
  if (
    missing.length === 0 &&
    unexpected.length === 0 &&
    covered.size === dates.length &&
    !captured.has('')
  )
    return null;
  return {
    kind: 'history-coverage',
    room: 'history',
    want: captured.size,
    got: covered.size,
    detail: `${String(missing.length)} captured dates missing, ${String(unexpected.length)} unrecorded identities, ${String(dates.length - covered.size)} repeated identities`,
  };
}

export function timeline(
  plan: Plan,
  receipt: Receipt,
  preimages: readonly Bag[],
  anchors: Readonly<Record<string, string>> = {},
): { messages: DateChange[]; constrained: Bag[] } {
  const reference = Date.parse(receipt.manifest.reference);
  const start = reference - (plan.historyDays ?? 0) * DAY;
  const originals = new Map(preimages.map((m) => [id(m.id), m]));
  const changes = new Map<string, DateChange>();
  const constrained: Bag[] = [];
  for (const room of plan.rooms) {
    const created = receipt.done(`room:${room.name}`);
    if (created === null) continue;
    let floor = start;
    const oldAnchor = anchors[room.name];
    if (room.kind === DISCUSSION) {
      if (created.reused === true && oldAnchor !== undefined) {
        floor = Math.max(floor, Date.parse(oldAnchor) + 1000);
        if (floor > start)
          constrained.push({
            room: room.name,
            anchor: oldAnchor,
            start: new Date(floor).toISOString(),
          });
      } else if (id(created.anchor) !== '')
        floor = Math.max(
          floor,
          Date.parse(changes.get(id(created.anchor))?.ts ?? receipt.manifest.reference) + 1000,
        );
    }
    const captured = [...receipt.entries.values()]
      .filter(
        (e) =>
          e.state === 'done' && e.data.room === room.name && /^(message|opening):/u.test(e.key),
      )
      .map((e) => e.data);
    // Opening records precede the new room conversation. API lists are newest first.
    const opening = captured
      .filter((m) => m.kind === 'opening')
      .sort((a, b) => Date.parse(id(a.ts)) - Date.parse(id(b.ts)));
    const ordered = [
      ...opening,
      ...room.content
        .map((c) => receipt.done(`message:${room.name}:${c.key}`))
        .filter((m): m is Bag => m !== null),
    ];
    if (floor + ordered.length + 1000 >= reference)
      throw new ConflictError(
        `discussion ${room.name} has no historical space after its existing anchor`,
      );
    const span = reference - 1000 - floor;
    for (let i = 0; i < ordered.length; i += 1) {
      const message = ordered[i] as Bag;
      const original = originals.get(id(message.id));
      if (original === undefined)
        throw new PreflightError('a captured historical message is missing');
      const ts = new Date(
        Math.floor(floor + (span * i) / Math.max(1, ordered.length)),
      ).toISOString();
      changes.set(id(message.id), {
        id: id(message.id),
        rid: id(message.rid),
        old: id(original.ts),
        ts,
        fileIds: Array.isArray(message.fileIds) ? (message.fileIds as string[]) : [],
        attachments: [],
      });
    }
    // New parent notices share the discussion's birth date; old notices are never captured.
    for (const entry of receipt.entries.values())
      if (entry.state === 'done' && entry.key.startsWith(`notice:${room.name}:`)) {
        const original = originals.get(id(entry.data.id));
        if (original === undefined)
          throw new PreflightError('a captured discussion notice is missing');
        changes.set(id(entry.data.id), {
          id: id(entry.data.id),
          rid: id(entry.data.rid),
          old: id(original.ts),
          ts: new Date(floor).toISOString(),
          fileIds: [],
          attachments: [],
        });
      }
  }
  for (const entry of receipt.entries.values())
    if (entry.state === 'done' && entry.key.startsWith('opening:')) {
      const change = changes.get(id(entry.data.id));
      if (change === undefined) continue;
      const attachments: { index: number; ts: string }[] = [];
      for (const [index, attachment] of list(entry.data.attachments).entries()) {
        const match = /(?:[?&])msg=([^&]+)/u.exec(id(attachment.message_link));
        const parent =
          match === null ? undefined : changes.get(decodeURIComponent(match[1] as string));
        if (parent !== undefined) attachments.push({ index, ts: parent.ts });
      }
      changes.set(change.id, { ...change, attachments });
    }
  for (const entry of receipt.entries.values())
    if (entry.state === 'done' && entry.key.startsWith('quote:')) {
      const original = originals.get(id(entry.data.id));
      if (original === undefined) throw new PreflightError('a captured pin quote is missing');
      const attachments = list(entry.data.attachments).map((a) => {
        const source = changes.get(id(a.source));
        if (source === undefined || !Number.isSafeInteger(a.index))
          throw new PreflightError('pin quote source is not part of the captured batch');
        return { index: a.index as number, ts: source.ts };
      });
      changes.set(id(entry.data.id), {
        id: id(entry.data.id),
        rid: id(entry.data.rid),
        old: id(original.ts),
        ts: id(original.ts),
        fileIds: [],
        attachments,
        related: true,
      });
    }
  return { messages: [...changes.values()], constrained };
}

export async function applyHistory(
  plan: Plan,
  receipt: Receipt,
  database: SeedDatabase,
  log: (message: string) => void,
): Promise<Bag> {
  if (plan.historyDays === null) return {};
  await database.assertTarget();
  const target = receipt.done('database:target');
  if (target !== null && target.target !== database.target)
    throw new ConflictError('historical seed database differs from its recorded target');
  if (target === null) receipt.record('database:target', 'done', { target: database.target });
  let recorded = receipt.done('history:timeline');
  if (recorded === null) {
    const captured = [...receipt.entries.values()]
      .filter((e) => e.state === 'done' && /^(message|opening|notice):/u.test(e.key))
      .map((e) => e.data);
    const ids = captured.map((m) => id(m.id));
    const pins = [...receipt.entries.values()]
      .filter((e) => e.state === 'done' && e.key.startsWith('pin:'))
      .map((e) => ({
        id: receipt.done(`message:${e.key.slice(4)}`)?.id,
        rid: receipt.done(`message:${e.key.slice(4)}`)?.rid,
        userId: e.data.userId,
        ts: receipt.done(`message:${e.key.slice(4)}`)?.ts,
        text: receipt.done(`message:${e.key.slice(4)}`)?.text,
        author:
          id(receipt.done(`message:${e.key.slice(4)}`)?.username) ||
          id(receipt.done(`message:${e.key.slice(4)}`)?.author) ||
          'admin',
      }))
      .filter(
        (p) =>
          typeof p.id === 'string' &&
          typeof p.rid === 'string' &&
          typeof p.userId === 'string' &&
          p.userId !== '',
      );
    const discussions = plan.rooms
      .filter((r) => r.kind === DISCUSSION && receipt.done(`room:${r.name}`)?.reused === true)
      .map((r) => ({ name: r.name, rid: id(receipt.done(`room:${r.name}`)?.rid) }));
    const before = await database.run(
      `var ids=${JSON.stringify(ids)};var docs=db.rocketchat_message.find({_id:{$in:ids}},{_id:1,rid:1,ts:1,u:1}).toArray();var quotes=[];for(var p of ${JSON.stringify(pins)}){var matches=[];for(var q of db.rocketchat_message.find({rid:p.rid,t:'message_pinned','u._id':p.userId}).toArray()){var attached=[];for(var i=0;i<(q.attachments||[]).length;i++){var match=/[?&]msg=([^&]+)/.exec(q.attachments[i].message_link||'');var a=q.attachments[i];var original=a.ts instanceof Date?a.ts.toISOString():a.ts;if(match&&decodeURIComponent(match[1])===p.id||original===p.ts&&a.text===p.text&&a.author_name===p.author)attached.push({index:i,source:p.id});}if(attached.length)matches.push({id:q._id,rid:q.rid,ts:q.ts.toISOString(),userId:q.u._id,attachments:attached});}if(matches.length!==1)throw new Error('pin quote identity is incomplete or ambiguous');quotes.push(matches[0]);}var anchors={};for(var r of ${JSON.stringify(discussions)}){var a=db.rocketchat_message.find({rid:r.rid,_id:{$nin:ids},t:{$exists:false}}).sort({ts:1}).limit(1).toArray()[0];if(a)anchors[r.name]=a.ts.toISOString();}print('HOUSTON_SEED:'+JSON.stringify({messages:docs.map(function(m){return {id:m._id,rid:m.rid,ts:m.ts.toISOString(),userId:m.u._id};}),anchors:anchors,quotes:quotes}));`,
    );
    const preimages = list(before.messages);
    if (preimages.length !== ids.length)
      throw new PreflightError('historical seed preimages are incomplete');
    for (const m of captured) {
      const original = preimages.find((p) => p.id === m.id);
      if (original?.rid !== m.rid || (id(m.userId) !== '' && original?.userId !== m.userId))
        throw new ConflictError('historical seed preimage identity does not match its API receipt');
    }
    for (const quote of list(before.quotes)) {
      if (
        id(quote.id) === '' ||
        id(quote.rid) === '' ||
        !pins.some((p) => p.rid === quote.rid && p.userId === quote.userId) ||
        list(quote.attachments).some(
          (a) =>
            !pins.some(
              (p) => p.id === a.source && p.rid === quote.rid && p.userId === quote.userId,
            ),
        )
      )
        throw new ConflictError('pin quote identity does not match its captured action');
      receipt.record(`quote:${id(quote.id)}`, 'done', { ...quote, kind: 'quote' });
      preimages.push(quote);
    }
    const dates = timeline(plan, receipt, preimages, before.anchors as Record<string, string>);
    recorded = {
      ...dates,
      reference: receipt.manifest.reference,
      days: plan.historyDays,
      target: database.target,
    };
    receipt.record('history:timeline', 'done', recorded);
  }
  const dates = recorded.messages as DateChange[];
  if (timelineCoverage(receipt, dates) !== null)
    throw new ConflictError(
      'historical seed timeline does not cover the complete captured batch; saved dates cannot be expanded or replaced',
    );
  for (let offset = 0; offset < dates.length; offset += 200) {
    const key = `history:dates:${offset}`;
    const completed = receipt.done(key);
    if (completed?.ok === true && completed.count === dates.slice(offset, offset + 200).length)
      continue;
    if (completed !== null) receipt.record(key, 'rejected', {});
    await database.assertTarget();
    const chunk = dates.slice(offset, offset + 200);
    // Both old and intended timestamps are accepted, so interruption within a chunk is safe.
    await receipt.step(
      key,
      { ids: chunk.map((m) => m.id) },
      async () => {
        const result = await database.run(
          `var changes=${JSON.stringify(chunk)};var now=new Date();for(var m of changes){var before=db.rocketchat_message.findOne({_id:m.id,rid:m.rid});if(!before||[m.old,m.ts].indexOf(before.ts.toISOString())<0)throw new Error('historical preimage changed');var fields={ts:new Date(m.ts),_updatedAt:now};for(var a of m.attachments)fields['attachments.'+a.index+'.ts']=new Date(a.ts);db.rocketchat_message.updateOne({_id:m.id,rid:m.rid},{$set:fields});for(var fid of m.fileIds){var f=db.rocketchat_uploads.findOne({_id:fid});if(!f)throw new Error('captured upload missing');db.rocketchat_uploads.updateOne({_id:fid},{$set:{uploadedAt:new Date(m.ts),_updatedAt:now}});db.getCollection('rocketchat_uploads.files').updateOne({_id:fid},{$set:{uploadDate:new Date(m.ts)}});}}print('HOUSTON_SEED:'+JSON.stringify({ok:true,count:changes.length}));`,
        );
        if (result.ok !== true || result.count !== chunk.length)
          throw new PreflightError('historical seed date update was incomplete');
        return result;
      },
      async () => null,
    );
    log(`history: adjusted ${Math.min(offset + 200, dates.length)}/${dates.length} captured dates`);
  }
  await database.assertTarget();
  const roots = [
    ...new Set(
      [...receipt.entries.values()]
        .filter((e) => e.state === 'done' && e.key.startsWith('message:'))
        .map((e) => id(e.data.tmid))
        .filter((v) => v !== ''),
    ),
  ];
  const rooms = plan.rooms
    .map((r) => receipt.done(`room:${r.name}`))
    .filter((r): r is Bag => r !== null);
  const notices = plan.rooms
    .filter((r) => r.kind === DISCUSSION)
    .map((r) => ({
      parent: receipt.done(`room:${r.parent}`)?.rid,
      discussion: receipt.done(`room:${r.name}`)?.rid,
    }))
    .filter((n) => typeof n.parent === 'string' && typeof n.discussion === 'string');
  const metadata = async (): Promise<Bag> => {
    const result = await database.run(
      `var now=new Date();for(var root of ${JSON.stringify(roots)}){var last=db.rocketchat_message.find({tmid:root,_hidden:{$ne:true}}).sort({ts:-1}).limit(1).toArray()[0];if(last)db.rocketchat_message.updateOne({_id:root},{$set:{tlm:last.ts,_updatedAt:now}});}for(var r of ${JSON.stringify(rooms)}){var latest=db.rocketchat_message.find({rid:r.rid,_hidden:{$ne:true},$or:[{t:'e2e'},{t:{$exists:false},tmid:{$exists:false}},{t:{$exists:false},tshow:true}]}).sort({ts:-1,_id:-1}).limit(1).toArray()[0];if(latest)db.rocketchat_room.updateOne({_id:r.rid},{$set:{lastMessage:latest,lm:latest.ts,_updatedAt:now}});}for(var n of ${JSON.stringify(notices)}){var room=db.rocketchat_room.findOne({_id:n.discussion});var notice=db.rocketchat_message.find({rid:n.parent,drid:n.discussion,t:'discussion-created'}).toArray();if(!room||notice.length!==1)throw new Error('discussion notice identity is incomplete or ambiguous');db.rocketchat_message.updateOne({_id:notice[0]._id,rid:n.parent,drid:n.discussion},{$set:{dlm:room.lm,dcount:room.msgs,_updatedAt:now}});}print('HOUSTON_SEED:'+JSON.stringify({ok:true,rooms:${rooms.length}}));`,
    );
    if (result.ok !== true)
      throw new PreflightError('historical seed metadata update was incomplete');
    return result;
  };
  if (receipt.done('history:metadata')?.ok === false)
    receipt.record('history:metadata', 'rejected', {});
  const adjusted = await receipt.step('history:metadata', {}, metadata, metadata);
  if (adjusted.ok !== true)
    throw new PreflightError('historical seed metadata update was incomplete');
  const times = dates.filter((m) => m.related !== true).map((m) => Date.parse(m.ts));
  return {
    days: plan.historyDays,
    reference: receipt.manifest.reference,
    oldest: times.length === 0 ? null : new Date(Math.min(...times)).toISOString(),
    latest: times.length === 0 ? null : new Date(Math.max(...times)).toISOString(),
    messages: dates.filter((m) => m.related !== true).length,
    related_quotes: dates.filter((m) => m.related === true).length,
    constrained: recorded.constrained ?? [],
    synthetic: true,
  };
}

export async function verifyHistory(receipt: Receipt, database: SeedDatabase): Promise<Bag> {
  await database.assertTarget();
  const timeline = receipt.done('history:timeline');
  const dates = timeline?.messages as DateChange[] | undefined;
  if (dates === undefined) throw new PreflightError('historical seed has no recorded timeline');
  const coverage = timelineCoverage(receipt, dates);
  if (coverage !== null) return { ok: false, faults: [coverage], checked: 0 };
  const rooms = [...receipt.entries.values()]
    .filter((e) => e.state === 'done' && e.key.startsWith('room:'))
    .map((e) => id(e.data.rid));
  const notices = [...receipt.entries.values()]
    .filter(
      (e) =>
        e.state === 'done' &&
        e.key.startsWith('room:') &&
        typeof e.data.parent === 'string' &&
        e.data.parent !== '',
    )
    .map((e) => ({ parent: e.data.parent, discussion: e.data.rid }));
  return await database.run(
    `var faults=[];var dates=${JSON.stringify(dates)};for(var m of dates){var actual=db.rocketchat_message.findOne({_id:m.id,rid:m.rid});if(!actual||!(actual.ts instanceof Date)||actual.ts.toISOString()!==m.ts)faults.push({kind:'date',room:m.rid,want:m.ts,got:actual?actual.ts:null,detail:m.id});if(actual)for(var a of m.attachments){if(!(actual.attachments[a.index].ts instanceof Date)||actual.attachments[a.index].ts.toISOString()!==a.ts)faults.push({kind:'copied-date',room:m.rid,want:a.ts,got:null,detail:m.id});}for(var fid of m.fileIds){var f=db.rocketchat_uploads.findOne({_id:fid});var g=db.getCollection('rocketchat_uploads.files').findOne({_id:fid});if(!f||!(f.uploadedAt instanceof Date)||f.uploadedAt.toISOString()!==m.ts||g&&g.uploadDate.toISOString()!==m.ts)faults.push({kind:'upload-date',room:m.rid,want:m.ts,got:null,detail:fid});}if(actual&&actual.tmid){var parent=db.rocketchat_message.findOne({_id:actual.tmid});var latest=db.rocketchat_message.find({tmid:actual.tmid,_hidden:{$ne:true}}).sort({ts:-1}).limit(1).toArray()[0];if(!parent||!parent.tlm||parent.tlm.toISOString()!==latest.ts.toISOString())faults.push({kind:'thread-date',room:m.rid,want:latest.ts,got:parent?parent.tlm:null,detail:actual.tmid});}}for(var rid of ${JSON.stringify(rooms)}){var latest=db.rocketchat_message.find({rid:rid,_hidden:{$ne:true},$or:[{t:'e2e'},{t:{$exists:false},tmid:{$exists:false}},{t:{$exists:false},tshow:true}]}).sort({ts:-1,_id:-1}).limit(1).toArray()[0];var room=db.rocketchat_room.findOne({_id:rid});if(latest&&(!room||!room.lastMessage||room.lastMessage._id!==latest._id||room.lm.toISOString()!==latest.ts.toISOString()))faults.push({kind:'room-date',room:rid,want:latest._id,got:room&&room.lastMessage?room.lastMessage._id:null,detail:''});}for(var n of ${JSON.stringify(notices)}){var child=db.rocketchat_room.findOne({_id:n.discussion});var notices=db.rocketchat_message.find({rid:n.parent,drid:n.discussion,t:'discussion-created'}).toArray();if(!child||notices.length!==1||!(notices[0].dlm instanceof Date)||!child.lm||notices[0].dlm.toISOString()!==child.lm.toISOString()||notices[0].dcount!==child.msgs)faults.push({kind:'discussion-activity',room:n.parent,want:child?child.lm:null,got:notices.length===1?notices[0].dlm:null,detail:n.discussion});}print('HOUSTON_SEED:'+JSON.stringify({ok:faults.length===0,faults:faults,checked:dates.length}));`,
  );
}
