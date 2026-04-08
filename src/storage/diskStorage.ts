import * as fs from 'fs';
import * as path from 'path';
import { LogRecord } from '../interface/interface';
import { gunzipSync, gzipSync } from 'zlib';

interface SegmentMeta {
  filePath: string;
  baseOffset: number;
  lastOffset: number;
  sizeBytes: number;
  oldestTimestamp: number;
  newestTimestamp: number;
  recordCount: number;
  isActive: boolean;
}

const MAX_SEGMENT_BYTES = 256 * 1024 * 1024;
const FLUSH_INTERVAL_MS = 50;
const FLUSH_BATCH_SIZE = 500;
const GZIP_LEVEL = 1;

export default class DiskStore {
  private currentFd: number = -1;
  private currentSegmentSize = 0;
  private currentSegmentBase = 0;
  public totalFlushed = 0;
  public totalDropped = 0;
  private diskQueue: string[] = [];
  private readonly MAX_QUEUE = 100_000;
  private isWorkerRunning = false;
  private readonly compress: boolean;

  constructor(
    private readonly dir: string,
    private readonly topic: string,
    compress: boolean = false,
  ) {
    this.compress = compress;
    fs.mkdirSync(this.segDir, { recursive: true });
    this.openOrCreateActiveSegment();
    this.startWorker();
  }

  private get segDir(): string {
    return path.join(this.dir, this.topic);
  }

  private listPaths(): string[] {
    return fs
      .readdirSync(this.segDir)
      .filter((f) => f.endsWith('.log'))
      .sort()
      .map((f) => path.join(this.segDir, f));
  }

  private openSegment(base: number): void {
    if (this.currentFd !== -1) fs.closeSync(this.currentFd);
    const file = path.join(
      this.segDir,
      String(base).padStart(10, '0') + '.log',
    );
    this.currentFd = fs.openSync(file, 'a');
    this.currentSegmentBase = base;
    this.currentSegmentSize = 0;
  }

  private openOrCreateActiveSegment(): void {
    const files = this.listPaths();
    if (files.length === 0) {
      this.openSegment(0);
      return;
    }

    const last = files[files.length - 1];
    const base = parseInt(path.basename(last, '.log'), 10);
    const size = fs.statSync(last).size;

    if (size >= MAX_SEGMENT_BYTES) {
      this.openSegment(base + 1);
    } else {
      this.currentSegmentBase = base;
      this.currentSegmentSize = size;
      this.currentFd = fs.openSync(last, 'a');
    }
  }

  enqueue(record: LogRecord): void {
    if (this.diskQueue.length >= this.MAX_QUEUE) {
      this.diskQueue.shift();
      this.totalDropped++;
      if (this.totalDropped % 1000 === 0) {
        console.warn(
          `[node-event-streaming][${this.topic}] ` +
            `${this.totalDropped} records dropped — disk can't keep up`,
        );
      }
    }
    this.diskQueue.push(JSON.stringify(record) + '\n');
  }

  private startWorker(): void {
    if (this.isWorkerRunning) return;
    this.isWorkerRunning = true;

    const tick = (): void => {
      if (this.diskQueue.length === 0) {
        setTimeout(tick, FLUSH_INTERVAL_MS).unref();
        return;
      }

      const batch = this.diskQueue.splice(0, FLUSH_BATCH_SIZE);
      const payload = batch.join('');
      const byteLength = Buffer.byteLength(payload, 'utf-8');

      if (this.currentSegmentSize + byteLength >= MAX_SEGMENT_BYTES)
        this.openSegment(this.currentSegmentBase + 1);

      if (this.compress) {
        // compressed — [4-byte length][gzip data]
        const raw = Buffer.from(payload, 'utf-8');
        const compressed = gzipSync(raw, { level: GZIP_LEVEL });
        const header = Buffer.alloc(4);
        header.writeUInt32BE(compressed.length, 0);
        fs.writeSync(this.currentFd, Buffer.concat([header, compressed]));
        this.currentSegmentSize += 4 + compressed.length;
      } else {
        // raw — plain JSON lines
        fs.writeSync(this.currentFd, payload, null, 'utf-8');
        this.currentSegmentSize += byteLength;
      }

      this.totalFlushed += batch.length;

      if (this.diskQueue.length > 0) setImmediate(tick);
      else setTimeout(tick, FLUSH_INTERVAL_MS).unref();
    };

    setImmediate(tick);
  }

  flush(): void {
    while (this.diskQueue.length > 0) {
      const batch = this.diskQueue.splice(0, FLUSH_BATCH_SIZE);
      const payload = batch.join('');
      const byteLength = Buffer.byteLength(payload, 'utf-8');
      if (this.currentSegmentSize + byteLength >= MAX_SEGMENT_BYTES)
        this.openSegment(this.currentSegmentBase + 1);
      fs.writeSync(this.currentFd, payload, null, 'utf-8');
      this.currentSegmentSize += byteLength;
      this.totalFlushed += batch.length;
    }
  }

  *readByOffsets(
    offsets: Set<number>,
    getSegment?: (offset: number) => number | undefined,
  ): Generator<LogRecord> {
    if (offsets.size === 0) return;

    const bySegment = new Map<number, Set<number>>();
    for (const off of offsets) {
      const seg = getSegment?.(off) ?? 0;
      if (!bySegment.has(seg)) bySegment.set(seg, new Set());
      bySegment.get(seg)!.add(off);
    }

    for (const [segBase, segOffsets] of bySegment) {
      const file = path.join(
        this.segDir,
        String(segBase).padStart(10, '0') + '.log',
      );
      if (!fs.existsSync(file)) continue;

      const content = fs.readFileSync(file, 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec: LogRecord = JSON.parse(line);
          if (segOffsets.has(rec.offset)) {
            yield rec;
            segOffsets.delete(rec.offset);
            if (segOffsets.size === 0) break;
          }
        } catch {
          /* skip */
        }
      }
    }
  }

  *replayAll(): Generator<LogRecord> {
    const meta = this.readMeta();
    for (const file of this.listPaths()) {
      if (meta.compression) {
        yield* this.readCompressed(file);
      } else {
        yield* this.readRaw(file);
      }
    }
  }
  private *readRaw(file: string): Generator<LogRecord> {
    const content = fs.readFileSync(file, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line) as LogRecord;
      } catch {}
    }
  }

  private *readCompressed(file: string): Generator<LogRecord> {
    const buf = fs.readFileSync(file);
    let pos = 0;
    while (pos + 4 <= buf.length) {
      const chunkLen = buf.readUInt32BE(pos);
      pos += 4;
      if (pos + chunkLen > buf.length) break;
      const compressed = buf.subarray(pos, pos + chunkLen);
      pos += chunkLen;
      try {
        const raw = gunzipSync(compressed).toString('utf-8');
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          try {
            yield JSON.parse(line) as LogRecord;
          } catch {}
        }
      } catch {}
    }
  }

  buildSegmentMetas(): SegmentMeta[] {
    const files = this.listPaths();
    return files.map((file) => {
      const base = parseInt(path.basename(file, '.log'), 10);
      const stat = fs.statSync(file);
      let first: LogRecord | null = null;
      let last: LogRecord | null = null;
      let count = 0;

      const content = fs.readFileSync(file, 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec: LogRecord = JSON.parse(line);
          if (!first) first = rec;
          last = rec;
          count++;
        } catch {
          /* skip */
        }
      }

      return {
        filePath: file,
        baseOffset: base,
        lastOffset: last?.offset ?? -1,
        sizeBytes: stat.size,
        oldestTimestamp: first?.timestamp ?? 0,
        newestTimestamp: last?.timestamp ?? 0,
        recordCount: count,
        isActive: base === this.currentSegmentBase,
      };
    });
  }

  deleteSegment(baseOffset: number): number {
    const file = path.join(
      this.segDir,
      String(baseOffset).padStart(10, '0') + '.log',
    );
    if (baseOffset === this.currentSegmentBase) {
      console.warn(`[stream] skipping active segment ${baseOffset}`);
      return 0;
    }
    try {
      const size = fs.statSync(file).size;
      fs.unlinkSync(file);
      return size;
    } catch (e) {
      console.error(`[stream] failed to delete segment ${file}:`, e);
      return 0;
    }
  }

  private isCompressed(file: string): boolean {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(2);
    fs.readSync(fd, buf, 0, 2, 0);
    fs.closeSync(fd);
    return buf[0] === 0x1f && buf[1] === 0x8b;
  }

  private writeMeta(): void {
    const meta = { compression: this.compress };
    fs.writeFileSync(
      path.join(this.segDir, '_meta.json'),
      JSON.stringify(meta),
    );
  }

  private readMeta(): { compression: boolean } {
    try {
      const metaPath = path.join(this.segDir, '_meta.json');
      if (fs.existsSync(metaPath))
        return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    } catch {}
    return { compression: false };
  }

  get totalDiskBytes(): number {
    return this.listPaths().reduce((s, f) => {
      try {
        return s + fs.statSync(f).size;
      } catch {
        return s;
      }
    }, 0);
  }

  get segmentCount(): number {
    return this.listPaths().length;
  }

  close(): void {
    this.flush();
    if (this.currentFd !== -1) fs.closeSync(this.currentFd);
  }
}
