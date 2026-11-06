/**
 * Generates the performance fixtures described in plan.md §3.
 *
 *   npm run fixtures                 # everything except huge.json
 *   npm run fixtures -- --huge       # also huge.json (~200 MB) and its double-stringified copy
 *   npm run fixtures -- --only=medium,deep
 *
 * Output is deterministic (seeded PRNG) and goes to ./fixtures.
 */
import { createWriteStream, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { join, resolve } from 'node:path';

const OUT = resolve(__dirname, '..', 'fixtures');
mkdirSync(OUT, { recursive: true });

const args = process.argv.slice(2);
const withHuge = args.includes('--huge');
const only = args
  .find((a) => a.startsWith('--only='))
  ?.slice(7)
  .split(',');
const want = (name: string): boolean => (only ? only.includes(name) : name !== 'huge' || withHuge);

// ── deterministic random ──
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rand = mulberry32(42);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));

const FIRST = [
  'Alice',
  'Bob',
  'Chandra',
  'Dmitri',
  'Elena',
  'Farah',
  'Goran',
  'Hana',
  'Ivo',
  'Jun',
  'Kemi',
  'Lars',
];
const LAST = ['Smith', 'Perera', 'Nakamura', 'Okafor', 'Silva', 'Novak', 'Haddad', 'Kim', 'Müller', 'Rossi'];
const CITIES = ['Colombo', 'Oslo', 'Lagos', 'Lima', 'Kyoto', 'Austin', 'Porto', 'Hanoi', 'Zürich', 'Cairo'];
const WORDS = [
  'alpha',
  'beta',
  'gamma',
  'delta',
  'omega',
  'vip',
  'trial',
  'beta-tester',
  'admin',
  'emoji 🎉',
];
const SKUS = ['SKU-1001', 'SKU-2002', 'SKU-3003', 'SKU-4004', 'SKU-5005'];

function sentence(n: number): string {
  return Array.from({ length: n }, () => pick(WORDS)).join(' ');
}

function makeUser(i: number): unknown {
  const first = pick(FIRST);
  const last = pick(LAST);
  return {
    id: i,
    uuid: `${(i * 2654435761).toString(16).padStart(8, '0')}-${int(1000, 9999)}-4${int(100, 999)}`,
    name: `${first} ${last}`,
    email: `${first}.${last}${i}@example.com`.toLowerCase(),
    active: rand() > 0.3,
    score: Math.round(rand() * 10000) / 100,
    createdAt: new Date(1_600_000_000_000 + i * 86_400_000).toISOString(),
    tags: Array.from({ length: int(0, 4) }, () => pick(WORDS)),
    address: {
      street: `${int(1, 999)} ${pick(LAST)} Road, Building ${int(1, 40)}, Floor ${int(1, 20)}`,
      city: pick(CITIES),
      zip: String(int(10000, 99999)),
      geo: {
        lat: Math.round((rand() * 180 - 90) * 1e5) / 1e5,
        lng: Math.round((rand() * 360 - 180) * 1e5) / 1e5,
      },
    },
    orders: Array.from({ length: int(0, 3) }, (_, k) => ({
      sku: pick(SKUS),
      qty: int(1, 9),
      price: Math.round(rand() * 50000) / 100,
      note: k === 0 && rand() > 0.8 ? 'Line one\nLine "two"\ttabbed' : null,
    })),
    notes: rand() > 0.7 ? null : sentence(int(12, 30)),
    summary: `${first} from ${pick(CITIES)}: ${sentence(int(15, 35))}`,
    profile: {
      bio: sentence(int(25, 55)),
      headline: sentence(int(8, 16)),
      website: rand() > 0.5 ? `https://example.com/u/${i}` : null,
    },
  };
}

function makeOrder(i: number): unknown {
  const o: Record<string, unknown> = {
    orderId: `ORD-${String(i).padStart(6, '0')}`,
    placedAt: new Date(1_700_000_000_000 + i * 60_000).toISOString(),
    status: pick(['paid', 'shipped', 'refunded', 'pending']),
    total: Math.round(rand() * 100000) / 100,
    customer: {
      id: int(1, 5000),
      name: `${pick(FIRST)} ${pick(LAST)}`,
      country: pick(['LK', 'NO', 'NG', 'PE', 'JP']),
    },
    items: Array.from({ length: int(1, 4) }, () => ({
      sku: pick(SKUS),
      qty: int(1, 5),
      unit: int(100, 9999) / 100,
    })),
    tags: Array.from({ length: int(0, 3) }, () => pick(WORDS)),
  };
  // Records with different shapes, as in real API exports.
  if (rand() > 0.7) o.coupon = { code: `SAVE${int(5, 50)}`, pct: int(5, 50) };
  if (rand() > 0.9) o.giftMessage = 'Happy birthday! "Enjoy", =SUM(A1)';
  return o;
}

/** Streams `{ "meta": …, "items": [ records… ] }` pretty-printed until a line or byte target is met. */
async function writeRecords(
  file: string,
  opts: { lines?: number; bytes?: number; make: (i: number) => unknown; seed: number },
): Promise<{ lines: number; bytes: number; records: number }> {
  rand = mulberry32(opts.seed);
  const out = createWriteStream(join(OUT, file), { encoding: 'utf8' });
  let lines = 0;
  let bytes = 0;
  const write = async (s: string): Promise<void> => {
    lines += s.split('\n').length - 1;
    bytes += Buffer.byteLength(s);
    if (!out.write(s)) await once(out, 'drain');
  };
  await write(
    `{\n  "meta": {\n    "generator": "gen-fixtures",\n    "file": "${file}",\n    "seed": ${opts.seed}\n  },\n  "items": [\n`,
  );
  let i = 0;
  for (;;) {
    const rec = JSON.stringify(opts.make(i), null, 2).replace(/\n/g, '\n    ');
    const done = (opts.lines && lines >= opts.lines) || (opts.bytes && bytes >= opts.bytes);
    if (done && i > 0) break;
    await write(`${i > 0 ? ',\n' : ''}    ${rec}`);
    i++;
  }
  await write('\n  ]\n}\n');
  out.end();
  await once(out, 'finish');
  return { lines, bytes, records: i };
}

/** Writes JSON.stringify(<contents of src>) without holding both copies for huge files. */
async function writeDoubleStringified(src: string, dest: string): Promise<void> {
  const size = statSync(join(OUT, src)).size;
  if (size < 64 * 1024 * 1024) {
    writeFileSync(join(OUT, dest), JSON.stringify(readFileSync(join(OUT, src), 'utf8')));
    return;
  }
  const { createReadStream } = await import('node:fs');
  const out = createWriteStream(join(OUT, dest), { encoding: 'utf8' });
  out.write('"');
  // Escaping is per-character, so it can be applied chunk by chunk (chunks split on UTF-8 boundaries
  // are handled by the stream's decoder).
  for await (const chunk of createReadStream(join(OUT, src), { encoding: 'utf8', highWaterMark: 4 << 20 })) {
    if (!out.write(JSON.stringify(chunk).slice(1, -1))) await once(out, 'drain');
  }
  out.write('"');
  out.end();
  await once(out, 'finish');
}

function deep(depth: number): unknown {
  // Built iteratively so the generator itself doesn't need a deep stack.
  let node: unknown = { leaf: true, value: 'bottom' };
  for (let d = depth - 1; d >= 0; d--) {
    node = d % 3 === 2 ? [d, node] : { level: d, child: node };
  }
  return node;
}

function wide(keys: number): unknown {
  rand = mulberry32(7);
  const o: Record<string, unknown> = {};
  for (let i = 0; i < keys; i++) o[`key_${String(i).padStart(5, '0')}`] = i % 5 === 0 ? sentence(3) : i;
  return o;
}

function longStrings(): unknown {
  const block = 'Lorem ipsum "quoted" \\ backslash\nnew line\ttab 🚀 ';
  const big = block.repeat(Math.ceil((1024 * 1024) / block.length)).slice(0, 1024 * 1024);
  return { a: big, nested: { b: big.toUpperCase(), list: [big.slice(0, 500_000), 'short'] }, small: 1 };
}

function log(name: string): void {
  const s = statSync(join(OUT, name)).size;
  console.log(`  ${name.padEnd(30)} ${(s / 1024 / 1024).toFixed(2).padStart(8)} MB`);
}

async function main(): Promise<void> {
  console.log(`Writing fixtures to ${OUT}`);
  const produced: string[] = [];
  const record = async (name: string, file: string, task: () => unknown): Promise<void> => {
    if (!want(name)) return;
    await task();
    produced.push(file);
    log(file);
  };

  await record('small', 'small.json', () =>
    writeRecords('small.json', { lines: 1_000, make: makeUser, seed: 1 }),
  );
  await record('medium', 'medium.json', () =>
    writeRecords('medium.json', { lines: 100_000, make: makeUser, seed: 2 }),
  );
  await record('large', 'large.json', () =>
    writeRecords('large.json', { lines: 1_000_000, make: makeUser, seed: 3 }),
  );
  await record('huge', 'huge.json', () =>
    writeRecords('huge.json', { bytes: 200 * 1024 * 1024, make: makeUser, seed: 4 }),
  );
  await record('deep', 'deep.json', () =>
    writeFileSync(join(OUT, 'deep.json'), JSON.stringify(deep(500), null, 2)),
  );
  await record('wide', 'wide.json', () =>
    writeFileSync(join(OUT, 'wide.json'), JSON.stringify(wide(10_000), null, 2)),
  );
  await record('long-strings', 'long-strings.json', () =>
    writeFileSync(join(OUT, 'long-strings.json'), JSON.stringify(longStrings(), null, 2)),
  );
  await record('api-export', 'api-export.json', () => {
    rand = mulberry32(5);
    writeFileSync(
      join(OUT, 'api-export.json'),
      JSON.stringify(
        Array.from({ length: 10_000 }, (_, i) => makeOrder(i)),
        null,
        2,
      ),
    );
  });

  for (const file of produced) {
    const dest = file.replace(/\.json$/, '.double.json');
    await writeDoubleStringified(file, dest);
    log(dest);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
