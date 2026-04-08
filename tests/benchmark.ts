// ─────────────────────────────────────────────────────────────────────────────
// node-event-streaming — Benchmark
// tests/benchmark.ts
//
// Run: npx ts-node tests/benchmark.ts
// ─────────────────────────────────────────────────────────────────────────────

import { EventStreaming } from '../src/server';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

// ── Config ────────────────────────────────────────────────────────────────────

const DATA_DIR = './benchmark-data';
const DATA_DIR_COMPRESSED = './benchmark-data-compressed';

// two instances — one without compression, one with
const streamer = new EventStreaming(DATA_DIR);
const streamerCompressed = new EventStreaming(DATA_DIR_COMPRESSED, {
  compression: true,
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const formatNum = (n: number) => n.toLocaleString();

const memMB = () => {
  const m = process.memoryUsage();
  return {
    heapUsed: +(m.heapUsed / 1024 / 1024).toFixed(1),
    heapTotal: +(m.heapTotal / 1024 / 1024).toFixed(1),
    rss: +(m.rss / 1024 / 1024).toFixed(1),
  };
};

const printResult = (
  label: string,
  count: number,
  ms: number,
  extra?: Record<string, string>,
) => {
  const perSec = Math.round((count / ms) * 1000);
  console.log(`\n  📊  ${label}`);
  console.log(`       records    : ${formatNum(count)}`);
  console.log(`       time       : ${ms} ms`);
  console.log(`       throughput : ${formatNum(perSec)} msg/sec`);
  const mem = memMB();
  console.log(`       heap used  : ${mem.heapUsed} MB  (rss: ${mem.rss} MB)`);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      console.log(`       ${k.padEnd(12)} : ${v}`);
    }
  }
};

const section = (title: string) => {
  console.log('\n' + '─'.repeat(52));
  console.log(`  ${title}`);
  console.log('─'.repeat(52));
};

const cleanDataDir = () => {
  if (fs.existsSync(DATA_DIR))
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  if (fs.existsSync(DATA_DIR_COMPRESSED))
    fs.rmSync(DATA_DIR_COMPRESSED, { recursive: true, force: true });
};

const getDiskSize = (dataDir: string, topic: string): number => {
  const diskPath = path.join(dataDir, topic);
  if (!fs.existsSync(diskPath)) return 0;
  return fs
    .readdirSync(diskPath)
    .filter((f) => f.endsWith('.log'))
    .reduce((s, f) => s + fs.statSync(path.join(diskPath, f)).size, 0);
};

// ── Test 1: produce() — ring buffer write speed ───────────────────────────────

const test1 = () => {
  section('TEST 1 — produce()  ×100k  (ring buffer)');
  const COUNT = 100_000;
  const start = Date.now();
  for (let i = 0; i < COUNT; i++) {
    streamer.produce({
      topic: 'bench-produce',
      key: String(i % 1000),
      data: { id: i, lat: '23.8041', lng: '90.4152', ts: Date.now() },
    });
  }
  printResult('produce()', COUNT, Date.now() - start);
};

// ── Test 2: produceBatch() — batched write speed ──────────────────────────────

const test2 = () => {
  section('TEST 2 — produceBatch()  ×100k  (500 per batch)');
  const COUNT = 100_000;
  const BATCH = 500;
  const start = Date.now();
  for (let i = 0; i < COUNT; i += BATCH) {
    streamer.produceBatch(
      Array.from({ length: BATCH }, (_, j) => ({
        topic: 'bench-batch',
        key: String((i + j) % 1000),
        data: { id: i + j, lat: '23.8041', lng: '90.4152', ts: Date.now() },
      })),
    );
  }
  printResult('produceBatch()', COUNT, Date.now() - start);
};

// ── Test 3: subscribe() — consumer throughput ─────────────────────────────────

const test3 = async () => {
  section('TEST 3 — subscribe()  eachMessage  ×50k');
  const COUNT = 50_000;
  let received = 0;
  let startTime = 0;
  const unsubscribe = streamer.subscribe(
    { topic: 'bench-consumer', groupId: 'bench', fromBeginning: true },
    async () => {
      if (received === 0) startTime = Date.now();
      received++;
    },
  );
  for (let i = 0; i < COUNT; i++) {
    streamer.produce({
      topic: 'bench-consumer',
      key: String(i % 1000),
      data: { id: i },
    });
  }
  while (received < COUNT) await sleep(10);
  printResult('subscribe() handler', COUNT, Date.now() - startTime);
  unsubscribe();
};

// ── Test 4: query() — index lookup speed ─────────────────────────────────────

const test4 = () => {
  section('TEST 4 — query()  ×10k  (ring buffer, key lookup)');
  const QUERIES = 10_000;
  const start = Date.now();
  for (let i = 0; i < QUERIES; i++) {
    streamer.query({
      topic: 'bench-produce',
      key: String(i % 1000),
      limit: 10,
      order: 'desc',
    });
  }
  printResult('query()', QUERIES, Date.now() - start);
};

// ── Test 5: queryStream() — stream throughput ─────────────────────────────────

const test5 = async () => {
  section('TEST 5 — queryStream()  ×10k  history');
  const COUNT = 10_000;
  let received = 0;
  for (let i = 0; i < COUNT; i++) {
    streamer.produce({ topic: 'bench-stream', key: '1', data: { id: i } });
  }
  const start = Date.now();
  const stream = streamer.queryStream({
    topic: 'bench-stream',
    key: '1',
    historySize: COUNT,
  });
  await new Promise<void>((resolve) => {
    stream.on('data', () => {
      received++;
      if (received >= COUNT) {
        stream.destroy();
        resolve();
      }
    });
  });
  printResult('queryStream()', COUNT, Date.now() - start);
};

// ── Test 6: sustained load — memory leak detection ───────────────────────────

const test6 = async () => {
  section('TEST 6 — Sustained load  10 sec  (compression OFF)');
  const DURATION_MS = 10_000;
  const end = Date.now() + DURATION_MS;
  let total = 0;
  const memStart = process.memoryUsage().heapUsed;
  console.log('  running...');
  while (Date.now() < end) {
    streamer.produceBatch(
      Array.from({ length: 500 }, (_, i) => ({
        topic: 'bench-sustained',
        key: String(i % 1000),
        data: { id: i, lat: '23.8041', lng: '90.4152', ts: Date.now() },
      })),
    );
    total += 500;
    await sleep(1);
  }
  const memEnd = process.memoryUsage().heapUsed;
  const memDelta = +((memEnd - memStart) / 1024 / 1024).toFixed(1);
  const perSec = Math.round((total / DURATION_MS) * 1000);
  const leak = memDelta > 100;
  console.log(`\n  📊  Sustained load (compression OFF)`);
  console.log(`       total      : ${formatNum(total)} records`);
  console.log(`       throughput : ${formatNum(perSec)} msg/sec`);
  console.log(`       mem start  : ${(memStart / 1024 / 1024).toFixed(1)} MB`);
  console.log(`       mem end    : ${(memEnd / 1024 / 1024).toFixed(1)} MB`);
  console.log(
    `       mem delta  : ${memDelta} MB  ${leak ? '⚠️  possible memory leak' : '✅ stable'}`,
  );
};

// ── Test 7: disk flush without compression ────────────────────────────────────

const test7 = async () => {
  section('TEST 7 — Disk flush  compression OFF  (10k records)');
  const COUNT = 10_000;
  const start = Date.now();
  for (let i = 0; i < COUNT; i++) {
    streamer.produce({
      topic: 'bench-disk-raw',
      key: String(i % 100),
      data: { id: i, lat: '23.8041', lng: '90.4152' },
    });
  }
  await sleep(500);
  const diskSize = getDiskSize(DATA_DIR, 'bench-disk-raw');
  printResult('produce() → disk flush', COUNT, Date.now() - start, {
    compression: 'OFF',
    'disk size': `${(diskSize / 1024).toFixed(1)} KB`,
    'per record': `${diskSize > 0 ? (diskSize / COUNT).toFixed(0) : '?'} bytes`,
  });
};

// ── Test 8: produce() with compression ───────────────────────────────────────

const test8 = () => {
  section('TEST 8 — produce()  ×100k  (compression ON)');
  const COUNT = 100_000;
  const start = Date.now();
  for (let i = 0; i < COUNT; i++) {
    streamerCompressed.produce({
      topic: 'bench-produce-compressed',
      key: String(i % 1000),
      data: { id: i, lat: '23.8041', lng: '90.4152', ts: Date.now() },
    });
  }
  printResult('produce() compressed', COUNT, Date.now() - start);
};

// ── Test 9: disk size comparison ──────────────────────────────────────────────

const test9 = async () => {
  section('TEST 9 — Disk size  OFF vs ON  (10k records)');
  const COUNT = 10_000;

  for (let i = 0; i < COUNT; i++) {
    streamer.produce({
      topic: 'bench-size-raw',
      key: String(i % 100),
      data: { id: i, lat: '23.8041', lng: '90.4152', ts: Date.now() },
    });
  }
  for (let i = 0; i < COUNT; i++) {
    streamerCompressed.produce({
      topic: 'bench-size-compressed',
      key: String(i % 100),
      data: { id: i, lat: '23.8041', lng: '90.4152', ts: Date.now() },
    });
  }

  await sleep(500);

  const rawSize = getDiskSize(DATA_DIR, 'bench-size-raw');
  const compressedSize = getDiskSize(
    DATA_DIR_COMPRESSED,
    'bench-size-compressed',
  );
  const reduction =
    rawSize > 0
      ? (((rawSize - compressedSize) / rawSize) * 100).toFixed(1)
      : '?';

  console.log(`\n  📊  Disk size comparison (${formatNum(COUNT)} records)`);
  console.log(
    `       compression OFF : ${(rawSize / 1024).toFixed(1)} KB  →  ${rawSize > 0 ? (rawSize / COUNT).toFixed(0) : '?'} bytes/record`,
  );
  console.log(
    `       compression ON  : ${(compressedSize / 1024).toFixed(1)} KB  →  ${compressedSize > 0 ? (compressedSize / COUNT).toFixed(0) : '?'} bytes/record`,
  );
  console.log(`       size reduction  : ${reduction}%`);
  console.log(`       memory          : ${memMB().heapUsed} MB heap`);
};

// ── Test 10: sustained load with compression ──────────────────────────────────

const test10 = async () => {
  section('TEST 10 — Sustained load  10 sec  (compression ON)');
  const DURATION_MS = 10_000;
  const end = Date.now() + DURATION_MS;
  let total = 0;
  const memStart = process.memoryUsage().heapUsed;
  console.log('  running...');
  while (Date.now() < end) {
    streamerCompressed.produceBatch(
      Array.from({ length: 500 }, (_, i) => ({
        topic: 'bench-sustained-compressed',
        key: String(i % 1000),
        data: { id: i, lat: '23.8041', lng: '90.4152', ts: Date.now() },
      })),
    );
    total += 500;
    await sleep(1);
  }
  const memEnd = process.memoryUsage().heapUsed;
  const memDelta = +((memEnd - memStart) / 1024 / 1024).toFixed(1);
  const perSec = Math.round((total / DURATION_MS) * 1000);
  const leak = memDelta > 100;
  console.log(`\n  📊  Sustained load (compression ON)`);
  console.log(`       total      : ${formatNum(total)} records`);
  console.log(`       throughput : ${formatNum(perSec)} msg/sec`);
  console.log(`       mem start  : ${(memStart / 1024 / 1024).toFixed(1)} MB`);
  console.log(`       mem end    : ${(memEnd / 1024 / 1024).toFixed(1)} MB`);
  console.log(
    `       mem delta  : ${memDelta} MB  ${leak ? '⚠️  possible memory leak' : '✅ stable'}`,
  );
};

// ── Test 11: disk flush with compression ──────────────────────────────────────

const test11 = async () => {
  section('TEST 11 — Disk flush  compression ON  (10k records)');
  const COUNT = 10_000;
  const start = Date.now();
  for (let i = 0; i < COUNT; i++) {
    streamerCompressed.produce({
      topic: 'bench-disk-compressed',
      key: String(i % 100),
      data: { id: i, lat: '23.8041', lng: '90.4152' },
    });
  }
  await sleep(500);
  const diskSize = getDiskSize(DATA_DIR_COMPRESSED, 'bench-disk-compressed');
  printResult('produce() → disk flush compressed', COUNT, Date.now() - start, {
    compression: 'ON',
    'disk size': `${(diskSize / 1024).toFixed(1)} KB`,
    'per record': `${diskSize > 0 ? (diskSize / COUNT).toFixed(0) : '?'} bytes`,
  });
};

// ── Test 12: read speed comparison ────────────────────────────────────────────

const test12 = async () => {
  section('TEST 12 — query() read speed  OFF vs ON  (1k queries)');
  const COUNT = 5_000;
  const QUERIES = 1_000;

  for (let i = 0; i < COUNT; i++) {
    streamer.produce({
      topic: 'bench-read-raw',
      key: String(i % 100),
      data: { id: i, lat: '23.8041', lng: '90.4152' },
    });
    streamerCompressed.produce({
      topic: 'bench-read-compressed',
      key: String(i % 100),
      data: { id: i, lat: '23.8041', lng: '90.4152' },
    });
  }

  await sleep(500);

  const startRaw = Date.now();
  for (let i = 0; i < QUERIES; i++) {
    streamer.query({
      topic: 'bench-read-raw',
      key: String(i % 100),
      limit: 10,
      order: 'desc',
    });
  }
  const rawMs = Date.now() - startRaw;

  const startComp = Date.now();
  for (let i = 0; i < QUERIES; i++) {
    streamerCompressed.query({
      topic: 'bench-read-compressed',
      key: String(i % 100),
      limit: 10,
      order: 'desc',
    });
  }
  const compMs = Date.now() - startComp;

  console.log(
    `\n  📊  Read speed (${formatNum(QUERIES)} queries × 10 records)`,
  );
  console.log(
    `       compression OFF : ${rawMs} ms  →  ${Math.round((QUERIES / rawMs) * 1000).toLocaleString()} queries/sec`,
  );
  console.log(
    `       compression ON  : ${compMs} ms  →  ${Math.round((QUERIES / compMs) * 1000).toLocaleString()} queries/sec`,
  );
  console.log(`       memory          : ${memMB().heapUsed} MB heap`);
};

// ── Summary ───────────────────────────────────────────────────────────────────

const printSummary = () => {
  console.log('\n' + '═'.repeat(52));
  console.log('  SUMMARY');
  console.log('═'.repeat(52));
  console.log('  Tests 1-7  → compression OFF');
  console.log('  Tests 8-12 → compression ON');
  console.log('  Test 9     → disk size comparison');
  console.log('  Test 12    → read speed comparison');
  console.log('═'.repeat(52));
};

// ── Run ───────────────────────────────────────────────────────────────────────

const run = async () => {
  console.log('╔' + '═'.repeat(50) + '╗');
  console.log('║   node-event-streaming  —  Benchmark         ║');
  console.log('╚' + '═'.repeat(50) + '╝');
  console.log(`\n  Node.js  : ${process.version}`);
  console.log(`  OS       : ${os.platform()} ${os.arch()}`);
  console.log(`  CPU      : ${os.cpus()[0].model}`);
  console.log(`  CPUs     : ${os.cpus().length} cores`);
  console.log(
    `  RAM      : ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)} GB`,
  );
  console.log('\n  streamer           → compression OFF');
  console.log('  streamerCompressed → compression ON');

  cleanDataDir();

  // compression OFF
  test1();
  test2();
  await test3();
  test4();
  await test5();
  await test6();
  await test7();

  // compression ON
  test8();
  await test9();
  await test10();
  await test11();
  await test12();

  printSummary();

  console.log('\n  ✅  All tests complete');
  streamer.close();
  streamerCompressed.close();
  cleanDataDir();
  process.exit(0);
};

run().catch((err) => {
  console.error('benchmark failed:', err);
  streamer.close();
  streamerCompressed.close();
  cleanDataDir();
  process.exit(1);
});
