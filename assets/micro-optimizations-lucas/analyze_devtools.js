// Analyzes a Flutter DevTools performance export (devToolsSnapshot JSON):
//  1. flutterFrames: per-frame UI ("build") and raster times.
//  2. traceBinary: the embedded Perfetto protobuf trace, decoded here with a
//     minimal protobuf reader, to get per-frame durations of the framework
//     pipeline phases on the UI thread (BUILD, LAYOUT, PAINT, COMPOSITING...).
// Usage: node analyze_devtools.js <export.json> [--dump-names] [--trace-out file]
const fs = require('fs');

const file = process.argv[2];
const dumpNames = process.argv.includes('--dump-names');
const traceOutIdx = process.argv.indexOf('--trace-out');
const j = JSON.parse(fs.readFileSync(file, 'utf8'));
const perf = j.performance;
const bytes = Uint8Array.from(perf.traceBinary);
if (traceOutIdx > 0) fs.writeFileSync(process.argv[traceOutIdx + 1], bytes);

// ---------- minimal protobuf reader ----------
function readVarint(buf, pos) {
  let result = 0n, shift = 0n, b;
  do {
    b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    shift += 7n;
  } while (b & 0x80);
  return [result, pos];
}
function* fields(buf, start = 0, end = buf.length) {
  let pos = start;
  while (pos < end) {
    let key;
    [key, pos] = readVarint(buf, pos);
    const field = Number(key >> 3n), wire = Number(key & 7n);
    if (wire === 0) {
      let v; [v, pos] = readVarint(buf, pos);
      yield { field, wire, value: v };
    } else if (wire === 2) {
      let len; [len, pos] = readVarint(buf, pos);
      const s = pos, e = pos + Number(len);
      yield { field, wire, start: s, end: e };
      pos = e;
    } else if (wire === 1) {
      yield { field, wire, start: pos, end: pos + 8 }; pos += 8;
    } else if (wire === 5) {
      yield { field, wire, start: pos, end: pos + 4 }; pos += 4;
    } else throw new Error('wire type ' + wire + ' at ' + pos);
  }
}
const str = (buf, f) => Buffer.from(buf.subarray(f.start, f.end)).toString('utf8');

// ---------- decode packets ----------
const trackNames = new Map(); // uuid -> thread/track name
const internedNames = new Map(); // `${seq}:${iid}` -> name
const events = []; // {ts, type, name, track}
const seqDefaultTrack = new Map();

for (const pkt of fields(bytes)) {
  if (pkt.field !== 1) continue;
  let ts = null, seq = 0, trackEvent = null, trackDesc = null, interned = null, defaults = null;
  for (const f of fields(bytes, pkt.start, pkt.end)) {
    if (f.field === 8 && f.wire === 0) ts = f.value;
    else if (f.field === 10 && f.wire === 0) seq = Number(f.value);
    else if (f.field === 11 && f.wire === 2) trackEvent = f;
    else if (f.field === 60 && f.wire === 2) trackDesc = f;
    else if (f.field === 12 && f.wire === 2) interned = f;
    else if (f.field === 59 && f.wire === 2) defaults = f;
  }
  if (trackDesc) {
    let uuid = null, name = null;
    for (const f of fields(bytes, trackDesc.start, trackDesc.end)) {
      if (f.field === 1 && f.wire === 0) uuid = f.value;
      else if (f.field === 2 && f.wire === 2) name = str(bytes, f);
      else if (f.field === 4 && f.wire === 2) {
        for (const t of fields(bytes, f.start, f.end)) {
          if (t.field === 5 && t.wire === 2) name = name ?? str(bytes, t);
          if (t.field === 2 && t.wire === 0 && name == null) name = 'tid ' + t.value;
        }
      } else if (f.field === 3 && f.wire === 2 && name == null) name = 'process';
    }
    if (uuid != null) trackNames.set(uuid, name ?? String(uuid));
  }
  if (interned) {
    for (const f of fields(bytes, interned.start, interned.end)) {
      if (f.field === 2 && f.wire === 2) {
        let iid = null, name = null;
        for (const e of fields(bytes, f.start, f.end)) {
          if (e.field === 1 && e.wire === 0) iid = e.value;
          if (e.field === 2 && e.wire === 2) name = str(bytes, e);
        }
        if (iid != null) internedNames.set(`${seq}:${iid}`, name);
      }
    }
  }
  if (defaults) {
    for (const f of fields(bytes, defaults.start, defaults.end)) {
      if (f.field === 11 && f.wire === 2) {
        for (const d of fields(bytes, f.start, f.end)) if (d.field === 11 && d.wire === 0) seqDefaultTrack.set(seq, d.value);
      }
    }
  }
  if (trackEvent && ts != null) {
    let type = null, name = null, nameIid = null, track = seqDefaultTrack.get(seq) ?? null;
    for (const f of fields(bytes, trackEvent.start, trackEvent.end)) {
      if (f.field === 9 && f.wire === 0) type = Number(f.value);
      else if (f.field === 23 && f.wire === 2) name = str(bytes, f);
      else if (f.field === 10 && f.wire === 0) nameIid = f.value;
      else if (f.field === 11 && f.wire === 0) track = f.value;
    }
    if (name == null && nameIid != null) name = internedNames.get(`${seq}:${nameIid}`) ?? `iid:${nameIid}`;
    events.push({ ts, type, name, track });
  }
}

// ---------- build slices (BEGIN=1 / END=2 per track) ----------
const stacks = new Map();
const slices = []; // {name, track, start, dur(us)}
events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
for (const e of events) {
  const key = String(e.track);
  if (!stacks.has(key)) stacks.set(key, []);
  const st = stacks.get(key);
  if (e.type === 1) st.push(e);
  else if (e.type === 2) {
    const b = st.pop();
    if (b) slices.push({ name: b.name, track: b.track, start: b.ts, dur: Number(e.ts - b.ts) / 1000, depth: st.length });
  }
}

const trackLabel = (t) => trackNames.get(t) ?? String(t);
if (dumpNames) {
  const agg = new Map();
  for (const s of slices) {
    const k = `${trackLabel(s.track)} | ${s.name}`;
    const a = agg.get(k) ?? { n: 0, total: 0 };
    a.n++; a.total += s.dur; agg.set(k, a);
  }
  [...agg.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 60)
    .forEach(([k, a]) => console.log(`${a.n.toString().padStart(6)}  ${(a.total / a.n).toFixed(1).padStart(9)} us avg  ${k}`));
  process.exit(0);
}

// ---------- stats ----------
function stats(values) {
  const v = [...values].sort((a, b) => a - b);
  const pct = (p) => v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)];
  const avg = v.reduce((a, b) => a + b, 0) / v.length;
  return { n: v.length, avg, p50: pct(50), p90: pct(90), p99: pct(99), max: v[v.length - 1] };
}
const fmt = (s, unit = 'ms', div = 1000) =>
  `n=${String(s.n).padStart(4)}  avg=${(s.avg / div).toFixed(3)}  p50=${(s.p50 / div).toFixed(3)}  p90=${(s.p90 / div).toFixed(3)}  p99=${(s.p99 / div).toFixed(3)}  max=${(s.max / div).toFixed(3)} ${unit}`;

const frames = perf.flutterFrames;
const spanUs = (frames[frames.length - 1].startTime + frames[frames.length - 1].elapsed - frames[0].startTime);
console.log(`File: ${file}`);
console.log(`App: profileBuild=${j.connectedApp.isProfileBuild}  flutter=${j.connectedApp.flutterVersion}  DevTools=${j.devToolsVersion}`);
console.log(`Frames: ${frames.length} over ${(spanUs / 1e6).toFixed(2)} s  => ${(frames.length / (spanUs / 1e6)).toFixed(1)} frames/s`);
console.log(`UI thread per frame      : ${fmt(stats(frames.map((f) => f.build)))}`);
console.log(`Raster thread per frame  : ${fmt(stats(frames.map((f) => f.raster)))}`);
console.log(`Frames over 16.7 ms (UI or raster): ${frames.filter((f) => f.build > 16667 || f.raster > 16667).length}`);

// Framework phases on the UI thread: each DevTools frame [startTime,
// startTime + elapsed] (µs) gets the phase slices (ns) that start inside it.
const phases = ['BUILD', 'LAYOUT', 'UPDATING COMPOSITING BITS', 'PAINT', 'COMPOSITING', 'FINALIZE TREE', 'SEMANTICS'];
const byPhase = new Map(phases.map((p) => [p, slices.filter((s) => s.name === p).sort((a, b) => (a.start < b.start ? -1 : 1))]));
const matched = new Map(phases.map((p) => [p, []]));
let framesWithPaint = 0;
for (const f of frames) {
  const s = BigInt(f.startTime) * 1000n, e = BigInt(f.startTime + f.elapsed) * 1000n;
  for (const p of phases) {
    const hits = byPhase.get(p).filter((x) => x.start >= s && x.start <= e);
    if (hits.length) matched.get(p).push(hits.reduce((a, x) => a + x.dur, 0));
    if (p === 'PAINT' && hits.length) framesWithPaint++;
  }
}
console.log(`Frames matched to a PAINT slice in the trace: ${framesWithPaint} / ${frames.length}`);
for (const p of phases) {
  const ds = matched.get(p);
  if (ds.length) console.log(`Phase ${p.padEnd(26)}: ${fmt(stats(ds))}`);
}
