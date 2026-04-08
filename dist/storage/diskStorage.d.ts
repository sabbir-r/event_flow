import { LogRecord } from '../interface/interface';
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
export default class DiskStore {
    private readonly dir;
    private readonly topic;
    private currentFd;
    private currentSegmentSize;
    private currentSegmentBase;
    totalFlushed: number;
    totalDropped: number;
    private diskQueue;
    private readonly MAX_QUEUE;
    private isWorkerRunning;
    private readonly compress;
    constructor(dir: string, topic: string, compress?: boolean);
    private get segDir();
    private listPaths;
    private openSegment;
    private openOrCreateActiveSegment;
    enqueue(record: LogRecord): void;
    private startWorker;
    flush(): void;
    readByOffsets(offsets: Set<number>, getSegment?: (offset: number) => number | undefined): Generator<LogRecord>;
    replayAll(): Generator<LogRecord>;
    private readRaw;
    private readCompressed;
    buildSegmentMetas(): SegmentMeta[];
    deleteSegment(baseOffset: number): number;
    private isCompressed;
    private writeMeta;
    private readMeta;
    get totalDiskBytes(): number;
    get segmentCount(): number;
    close(): void;
}
export {};
