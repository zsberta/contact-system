export interface ServerInfoProcessMemory {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
}

export interface ServerInfoDbStatus {
  ok: boolean;
  latencyMs?: number;
  error?: string;
  pool: { total: number; idle: number; waiting: number; max: number };
}

export interface ServerInfoUploads {
  dir: string;
  totalBytes: number;
  fileCount: number;
  truncated: boolean;
  error: string | null;
}

export interface ServerInfoDiskMount {
  target: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usePct: number | null;
  error: string | null;
}

export interface ServerInfoApp {
  nodeVersion: string;
  platform: string;
  arch: string;
  hostname: string;
  uptimeSec: number;
  loadAvg: number[];
  cpuCount: number | null;
  memTotalBytes: number;
  memFreeBytes: number;
  processMemory: ServerInfoProcessMemory;
  eventLoopLagMs: number | null;
  env: string;
  db: ServerInfoDbStatus;
  uploads: ServerInfoUploads;
  disk: { root: ServerInfoDiskMount; uploadsMount: ServerInfoDiskMount };
}

export interface ServerInfoQueue {
  pending: number;
  inFlight: number;
  tokensAvailable: number;
  burstCapacity: number;
  refillIntervalMs: number;
  maxAttempts: number;
}

export interface ServerInfoEmailKindRow {
  kind: string;
  total: number;
  delivered: number;
  failed: number;
}

export interface ServerInfoEmailFailure {
  createdAt: string | null;
  action: string;
  entityLabel: string | null;
  recipient: string | null;
  subject: string | null;
  error: string | null;
}

export interface ServerInfoEmail {
  transport: string;
  sendingEnabled: boolean;
  smtpConfigured: boolean;
  queue: ServerInfoQueue;
  sent24h: number;
  failed24h: number;
  byKind7d: ServerInfoEmailKindRow[];
  recentFailures: ServerInfoEmailFailure[];
}

export interface ServerInfoTables {
  users: number;
  projects: number;
  forms: number;
  formSubmissions: number;
  reservations: number;
  bookings: number;
  upcomingBookings: number;
  customers: number;
  activityLogs: number;
  errors24h: number;
}

export interface ServerInfoEngine {
  serverVersion: string | null;
  operatingSystem: string | null;
  architecture: string | null;
  kernelVersion: string | null;
  osType: string | null;
  ncpu: number | null;
  memTotalBytes: number | null;
  containersTotal: number | null;
  containersRunning: number | null;
  containersPaused: number | null;
  containersStopped: number | null;
  imagesTotal: number | null;
}

export interface ServerInfoContainer {
  id: string;
  names: string[];
  image: string;
  state: string;
  status: string;
  createdAt: string | null;
  sizeRwBytes: number | null;
  sizeRootFsBytes: number | null;
}

export interface ServerInfoDiskPart {
  count: number;
  totalBytes: number;
}

export interface ServerInfoDiskUsage {
  images: ServerInfoDiskPart;
  containers: ServerInfoDiskPart;
  volumes: ServerInfoDiskPart;
  buildCache: ServerInfoDiskPart;
  reclaimableBytes: number;
}

export interface ServerInfoDocker {
  configured: boolean;
  lastPollAt: string | null;
  lastError: string | null;
  engine: ServerInfoEngine | null;
  containers: ServerInfoContainer[] | null;
  diskUsage: ServerInfoDiskUsage | null;
}

export interface ServerInfoSnapshot {
  collectedAt: string;
  app: ServerInfoApp;
  email: ServerInfoEmail | { error: string };
  tables: ServerInfoTables | { error: string };
  docker: ServerInfoDocker;
}
