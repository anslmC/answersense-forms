import { EXTENSION_NAME } from './Utils';

export type PerformanceContext = 'BACKGROUND' | 'CONTENT' | 'UI';

export type PerformanceOutcome =
  'SUCCESS' | 'FAILURE' | 'CANCELLED' | 'DEADLINE' | 'STALE' | 'UNKNOWN';

export type MeasurementStatus =
  'MEASURED' | 'NOT_APPLICABLE' | 'NOT_COLLECTED' | 'UNAVAILABLE';

export interface TokenUsageTiming {
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
}

export interface BatchPerformanceRecord {
  readonly batchIndex: number;
  readonly batchCount: number;
  readonly questionCount: number;
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
  readonly waveIndex: number;
  readonly attempt: number | null;
  readonly splitDepth: number;
  readonly queueWaitMs: number | null;
  readonly requestStartedAtMs: number | null;
  readonly requestDurationMs: number | null;
  readonly totalBatchDurationMs: number | null;
  readonly outcome: 'SUCCESS' | 'FAILURE' | 'CANCELLED' | 'DEADLINE';
  readonly failureCategory: string | null;
  readonly activeConcurrency: number;
  readonly queuedBatches: number;
  readonly modelId: string | null;
  readonly usage: TokenUsageTiming | null;
}

export interface TransportPerformanceRecord {
  readonly batchIndex: number | null;
  readonly attempt: number | null;
  readonly modelId: string;
  readonly requestPreparationMs: number | null;
  readonly payloadBuildMs: number | null;
  readonly serializationMs: number | null;
  readonly networkRequestMs: number | null;
  readonly httpStatus: number | null;
  readonly responseBodyReadMs: number | null;
  readonly jsonParseMs: number | null;
  readonly pollingUsed: boolean;
  readonly pollCount: number;
  readonly pollWaitMs: number | null;
  readonly pollRequestMs: number | null;
  readonly pollNetworkMs: number | null;
  readonly pollBodyReadMs: number | null;
  readonly totalTransportMs: number | null;
  readonly fallbackUsed: boolean;
  readonly retryAfterMs: number | null;
  readonly usage: TokenUsageTiming | null;
  readonly outcome: 'SUCCESS' | 'FAILURE';
  readonly failureCategory: string | null;
}

export interface RecoveryPerformanceEvent {
  readonly type:
    | 'RETRY'
    | 'SPLIT'
    | 'CONCURRENCY_REDUCED'
    | 'DEADLINE'
    | 'CANCELLED'
    | 'FINALIZED';
  readonly waveIndex: number | null;
  readonly questionCount: number;
  readonly attempt: number | null;
  readonly splitDepth: number;
  readonly reason: string | null;
  readonly delayMs: number | null;
  readonly backoffMs: number | null;
  readonly concurrency: number | null;
}

export interface RecoveryPerformanceSummary {
  readonly initialExecutionMs: number;
  readonly recoveryDurationMs: number;
  readonly totalRecoveryDurationMs: number;
  readonly retryCount: number;
  readonly retryReasons: Readonly<Record<string, number>>;
  readonly splitCount: number;
  readonly maxSplitDepth: number;
  readonly recoveredCount: number;
  readonly unresolvedCount: number;
  readonly concurrencyReductionCount: number;
  readonly retryEligibilityWaitMs: number;
  readonly backoffWaitMs: number;
  readonly deadlineReached: boolean;
  readonly cancelled: boolean;
}

export interface BrowserPerformanceEvent {
  readonly phase: string;
  readonly durationMs: number;
  readonly questionCount: number | null;
  readonly filledCount: number | null;
  readonly failedCount: number | null;
  readonly attemptCount: number | null;
}

export interface ResultProcessingPerformance {
  readonly responseValidationMs: number | null;
  readonly salvageMs: number | null;
  readonly assemblyMs: number | null;
  readonly strictValidationMs: number | null;
  readonly totalProcessingMs: number | null;
  readonly expectedQuestionCount: number;
  readonly returnedResultCount: number;
  readonly generatedCount: number;
  readonly abstainedCount: number;
  readonly failedCount: number;
  readonly validationFailedCount: number;
  readonly salvagedResultCount: number;
}

export interface GenerationPerformanceReport {
  readonly correlationId: string;
  readonly context: PerformanceContext;
  readonly durationMs: number;
  readonly outcome: PerformanceOutcome;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly measurementStatus: Readonly<Record<string, MeasurementStatus>>;
  readonly phases: Readonly<Record<string, number>>;
  readonly counts: Readonly<Record<string, number>>;
  readonly batches: readonly BatchPerformanceRecord[];
  readonly transports: readonly TransportPerformanceRecord[];
  readonly recovery: RecoveryPerformanceSummary | null;
  readonly recoveryEvents: readonly RecoveryPerformanceEvent[];
  readonly resultProcessing: ResultProcessingPerformance;
  readonly browser: readonly BrowserPerformanceEvent[];
  readonly provider: GenerationPerformanceReport | null;
}

export function monotonicNow(): number {
  try {
    const performance = globalThis.performance;
    if (performance && typeof performance.now === 'function') {
      return performance.now();
    }
  } catch {
    // Fall through to the clock fallback.
  }
  return Date.now();
}

export function elapsedSince(start: number, end = monotonicNow()): number {
  return normalizeDuration(end - start);
}

function normalizeDuration(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : 0;
}

function safeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : null;
}

function safeTiming(value: unknown): number | null {
  return safeNumber(value);
}

function safeString(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 128);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function emptyResultProcessing(): ResultProcessingPerformance {
  return {
    responseValidationMs: null,
    salvageMs: null,
    assemblyMs: null,
    strictValidationMs: null,
    totalProcessingMs: null,
    expectedQuestionCount: 0,
    returnedResultCount: 0,
    generatedCount: 0,
    abstainedCount: 0,
    failedCount: 0,
    validationFailedCount: 0,
    salvagedResultCount: 0,
  };
}

function maxCounts(
  current: Readonly<Record<string, number>>,
  incoming: Readonly<Record<string, number>> | undefined
): Record<string, number> {
  const merged: Record<string, number> = { ...current };
  for (const [key, value] of Object.entries(incoming ?? {})) {
    const count = safeNumber(value);
    if (count === null) {
      continue;
    }
    merged[key] = Math.max(merged[key] ?? 0, count);
  }
  return merged;
}

function maxTiming(current: number | null, incoming: unknown): number | null {
  const value = safeTiming(incoming);
  if (value === null) {
    return current;
  }
  return current === null ? value : Math.max(current, value);
}

function maxRecoverySummary(
  current: RecoveryPerformanceSummary | null,
  incoming: RecoveryPerformanceSummary | null
): RecoveryPerformanceSummary | null {
  if (!incoming) {
    return current;
  }
  if (!current) {
    return {
      ...incoming,
      retryReasons: { ...incoming.retryReasons },
    };
  }
  return {
    initialExecutionMs: Math.max(
      current.initialExecutionMs,
      incoming.initialExecutionMs
    ),
    recoveryDurationMs: Math.max(
      current.recoveryDurationMs,
      incoming.recoveryDurationMs
    ),
    totalRecoveryDurationMs: Math.max(
      current.totalRecoveryDurationMs,
      incoming.totalRecoveryDurationMs
    ),
    retryCount: Math.max(current.retryCount, incoming.retryCount),
    retryReasons: maxCounts(current.retryReasons, incoming.retryReasons),
    splitCount: Math.max(current.splitCount, incoming.splitCount),
    maxSplitDepth: Math.max(current.maxSplitDepth, incoming.maxSplitDepth),
    recoveredCount: Math.max(current.recoveredCount, incoming.recoveredCount),
    unresolvedCount: Math.max(
      current.unresolvedCount,
      incoming.unresolvedCount
    ),
    concurrencyReductionCount: Math.max(
      current.concurrencyReductionCount,
      incoming.concurrencyReductionCount
    ),
    retryEligibilityWaitMs: Math.max(
      current.retryEligibilityWaitMs,
      incoming.retryEligibilityWaitMs
    ),
    backoffWaitMs: Math.max(current.backoffWaitMs, incoming.backoffWaitMs),
    deadlineReached: current.deadlineReached || incoming.deadlineReached,
    cancelled: current.cancelled || incoming.cancelled,
  };
}

function mergeMeasurementStatus(
  current: Record<string, MeasurementStatus>,
  incoming: Readonly<Record<string, MeasurementStatus>> | undefined
): void {
  for (const [key, value] of Object.entries(incoming ?? {})) {
    if (!isMeasurementStatus(value)) {
      continue;
    }
    if (current[key] === 'MEASURED') {
      continue;
    }
    if (value === 'MEASURED' || current[key] === undefined) {
      current[key] = value;
    }
  }
}

function isMeasurementStatus(value: unknown): value is MeasurementStatus {
  return (
    value === 'MEASURED' ||
    value === 'NOT_APPLICABLE' ||
    value === 'NOT_COLLECTED' ||
    value === 'UNAVAILABLE'
  );
}

function sanitizeBatch(record: BatchPerformanceRecord): BatchPerformanceRecord {
  return {
    ...record,
    batchIndex: safeNumber(record.batchIndex) ?? 0,
    batchCount: safeNumber(record.batchCount) ?? 0,
    questionCount: safeNumber(record.questionCount) ?? 0,
    estimatedInputTokens: safeNumber(record.estimatedInputTokens) ?? 0,
    estimatedOutputTokens: safeNumber(record.estimatedOutputTokens) ?? 0,
    waveIndex: safeNumber(record.waveIndex) ?? 0,
    attempt: safeNumber(record.attempt),
    splitDepth: safeNumber(record.splitDepth) ?? 0,
    queueWaitMs: safeTiming(record.queueWaitMs),
    requestStartedAtMs: safeTiming(record.requestStartedAtMs),
    requestDurationMs: safeTiming(record.requestDurationMs),
    totalBatchDurationMs: safeTiming(record.totalBatchDurationMs),
    activeConcurrency: safeNumber(record.activeConcurrency) ?? 0,
    queuedBatches: safeNumber(record.queuedBatches) ?? 0,
    modelId: record.modelId ? safeString(record.modelId) : null,
    failureCategory: record.failureCategory
      ? safeString(record.failureCategory)
      : null,
    usage: sanitizeUsage(record.usage),
  };
}

function sanitizeTransport(
  record: TransportPerformanceRecord
): TransportPerformanceRecord {
  return {
    ...record,
    batchIndex: safeNumber(record.batchIndex),
    attempt: safeNumber(record.attempt),
    modelId: safeString(record.modelId),
    requestPreparationMs: safeTiming(record.requestPreparationMs),
    payloadBuildMs: safeTiming(record.payloadBuildMs),
    serializationMs: safeTiming(record.serializationMs),
    networkRequestMs: safeTiming(record.networkRequestMs),
    httpStatus: safeNumber(record.httpStatus),
    responseBodyReadMs: safeTiming(record.responseBodyReadMs),
    jsonParseMs: safeTiming(record.jsonParseMs),
    pollingUsed: record.pollingUsed === true,
    pollCount: safeNumber(record.pollCount) ?? 0,
    pollWaitMs: safeTiming(record.pollWaitMs),
    pollRequestMs: safeTiming(record.pollRequestMs),
    pollNetworkMs: safeTiming(record.pollNetworkMs),
    pollBodyReadMs: safeTiming(record.pollBodyReadMs),
    totalTransportMs: safeTiming(record.totalTransportMs),
    fallbackUsed: record.fallbackUsed === true,
    retryAfterMs: safeTiming(record.retryAfterMs),
    usage: sanitizeUsage(record.usage),
    failureCategory: record.failureCategory
      ? safeString(record.failureCategory)
      : null,
  };
}

function sanitizeUsage(value: unknown): TokenUsageTiming | null {
  if (!isRecord(value)) {
    return null;
  }
  const promptTokens = safeNumber(value.promptTokens);
  const completionTokens = safeNumber(value.completionTokens);
  const totalTokens = safeNumber(value.totalTokens);
  if (
    promptTokens === null &&
    completionTokens === null &&
    totalTokens === null
  ) {
    return null;
  }
  return { promptTokens, completionTokens, totalTokens };
}

function sanitizeRecoveryEvent(
  event: RecoveryPerformanceEvent
): RecoveryPerformanceEvent {
  return {
    ...event,
    waveIndex: safeNumber(event.waveIndex),
    questionCount: safeNumber(event.questionCount) ?? 0,
    attempt: safeNumber(event.attempt),
    splitDepth: safeNumber(event.splitDepth) ?? 0,
    reason: event.reason ? safeString(event.reason) : null,
    delayMs: safeTiming(event.delayMs),
    backoffMs: safeTiming(event.backoffMs),
    concurrency: safeNumber(event.concurrency),
  };
}

function sanitizeBrowser(
  event: BrowserPerformanceEvent
): BrowserPerformanceEvent {
  return {
    ...event,
    phase: safeString(event.phase),
    durationMs: normalizeDuration(event.durationMs),
    questionCount: safeNumber(event.questionCount),
    filledCount: safeNumber(event.filledCount),
    failedCount: safeNumber(event.failedCount),
    attemptCount: safeNumber(event.attemptCount),
  };
}

function batchIdentity(record: BatchPerformanceRecord): string {
  return [
    record.batchIndex,
    record.waveIndex,
    record.attempt ?? 'null',
    record.questionCount,
    record.requestDurationMs ?? 'null',
    record.totalBatchDurationMs ?? 'null',
  ].join(':');
}

function transportIdentity(record: TransportPerformanceRecord): string {
  return [
    record.batchIndex ?? 'null',
    record.attempt ?? 'null',
    record.httpStatus ?? 'null',
    record.totalTransportMs ?? 'null',
    record.pollCount,
  ].join(':');
}

function browserIdentity(record: BrowserPerformanceEvent): string {
  return [record.phase, record.durationMs, record.questionCount ?? 'null'].join(
    ':'
  );
}

export interface PerformanceCarrier {
  readonly performance?: GenerationPerformanceReport;
}

export function readPerformanceReport(
  value: unknown
): GenerationPerformanceReport | null {
  try {
    if (!isRecord(value)) {
      return null;
    }
    const report = (value as PerformanceCarrier).performance;
    return isRecord(report) && typeof report.correlationId === 'string'
      ? (report as unknown as GenerationPerformanceReport)
      : null;
  } catch {
    return null;
  }
}

export function attachPerformanceToError<T>(
  error: T,
  report: GenerationPerformanceReport | null
): T {
  try {
    if (
      report &&
      typeof error === 'object' &&
      error !== null &&
      !('performance' in error)
    ) {
      Object.defineProperty(error, 'performance', {
        value: report,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  } catch {
    // Instrumentation must never affect generation.
  }
  return error;
}

export class GenerationPerformanceRecorder {
  private readonly startedAt: number;
  private readonly phases: Record<string, number> = {};
  private readonly counts: Record<string, number> = {};
  private readonly batches: BatchPerformanceRecord[] = [];
  private readonly transports: TransportPerformanceRecord[] = [];
  private readonly recoveryEvents: RecoveryPerformanceEvent[] = [];
  private readonly browser: BrowserPerformanceEvent[] = [];
  private readonly measurementStatus: Record<string, MeasurementStatus> = {};
  private readonly mergedReportKeys = new Set<string>();
  private recovery: RecoveryPerformanceSummary | null = null;
  private resultProcessing = emptyResultProcessing();
  private providerId: string | null = null;
  private modelId: string | null = null;
  private outcome: PerformanceOutcome = 'UNKNOWN';
  private finalDurationMs: number | null = null;
  private maxObservedConcurrency = 0;
  private maxQueuedBatches = 0;
  private providerReport: GenerationPerformanceReport | null = null;

  constructor(
    private correlationId: string,
    private readonly context: PerformanceContext = 'CONTENT',
    startedAt = monotonicNow()
  ) {
    this.startedAt = startedAt;
  }

  correlate(correlationId: string): void {
    try {
      this.correlationId = correlationId;
    } catch {
      // Instrumentation must never affect generation.
    }
  }

  setProvider(providerId: string, modelId?: string | null): void {
    try {
      this.providerId = safeString(providerId) || null;
      if (modelId !== undefined && modelId !== null) {
        this.modelId = safeString(modelId) || null;
      }
    } catch {
      // Instrumentation must never affect generation.
    }
  }

  setModelId(modelId: string): void {
    try {
      this.modelId = safeString(modelId) || null;
    } catch {
      // Instrumentation must never affect generation.
    }
  }

  setMeasurementStatus(name: string, status: MeasurementStatus): void {
    try {
      const key = safeString(name);
      if (key) {
        this.measurementStatus[key] = status;
      }
    } catch {
      // Instrumentation must never affect generation.
    }
  }

  addPhase(name: string, durationMs: number): void {
    try {
      const key = safeString(name);
      if (!key) {
        return;
      }
      this.phases[key] = normalizeDuration(
        (this.phases[key] ?? 0) + durationMs
      );
      this.measurementStatus.phases = 'MEASURED';
    } catch {
      // Instrumentation must never affect generation.
    }
  }

  addCount(name: string, value = 1): void {
    try {
      const key = safeString(name);
      const increment = safeNumber(value);
      if (!key || increment === null) {
        return;
      }
      this.counts[key] = (this.counts[key] ?? 0) + increment;
    } catch {
      // Instrumentation must never affect generation.
    }
  }

  setCount(name: string, value: number): void {
    try {
      const key = safeString(name);
      const count = safeNumber(value);
      if (key && count !== null) {
        this.counts[key] = count;
      }
    } catch {
      // Instrumentation must never affect generation.
    }
  }

  recordBatch(record: BatchPerformanceRecord): void {
    try {
      if (this.batches.length >= 200) {
        return;
      }
      this.batches.push(sanitizeBatch(record));
      this.measurementStatus.batches = 'MEASURED';
    } catch {
      // Instrumentation must never affect generation.
    }
  }

  recordTransport(record: TransportPerformanceRecord): void {
    try {
      if (this.transports.length >= 400) {
        return;
      }
      this.transports.push(sanitizeTransport(record));
      this.measurementStatus.transports = 'MEASURED';
    } catch {
      // Instrumentation must never affect generation.
    }
  }

  recordRecoveryEvent(event: RecoveryPerformanceEvent): void {
    try {
      if (this.recoveryEvents.length >= 200) {
        return;
      }
      this.recoveryEvents.push(sanitizeRecoveryEvent(event));
      this.measurementStatus.recoveryEvents = 'MEASURED';
    } catch {
      // Instrumentation must never affect generation.
    }
  }

  setRecoverySummary(summary: Partial<RecoveryPerformanceSummary>): void {
    try {
      const current =
        this.recovery ??
        ({
          initialExecutionMs: 0,
          recoveryDurationMs: 0,
          totalRecoveryDurationMs: 0,
          retryCount: 0,
          retryReasons: {},
          splitCount: 0,
          maxSplitDepth: 0,
          recoveredCount: 0,
          unresolvedCount: 0,
          concurrencyReductionCount: 0,
          retryEligibilityWaitMs: 0,
          backoffWaitMs: 0,
          deadlineReached: false,
          cancelled: false,
        } satisfies RecoveryPerformanceSummary);
      this.recovery = {
        ...current,
        ...summary,
        retryReasons: {
          ...(summary.retryReasons ?? current.retryReasons),
        },
      };
      this.measurementStatus.recovery = 'MEASURED';
    } catch {
      // Instrumentation must never affect generation.
    }
  }

  setResultProcessing(processing: Partial<ResultProcessingPerformance>): void {
    try {
      this.resultProcessing = {
        ...this.resultProcessing,
        ...processing,
      };
      this.measurementStatus.resultProcessing = 'MEASURED';
    } catch {
      // Instrumentation must never affect generation.
    }
  }

  recordBrowser(event: BrowserPerformanceEvent): void {
    try {
      if (this.browser.length >= 100) {
        return;
      }
      this.browser.push(sanitizeBrowser(event));
      this.measurementStatus.browser = 'MEASURED';
    } catch {
      // Instrumentation must never affect generation.
    }
  }

  observeConcurrency(active: number, queued: number): void {
    try {
      this.maxObservedConcurrency = Math.max(
        this.maxObservedConcurrency,
        safeNumber(active) ?? 0
      );
      this.maxQueuedBatches = Math.max(
        this.maxQueuedBatches,
        safeNumber(queued) ?? 0
      );
    } catch {
      // Instrumentation must never affect generation.
    }
  }

  attachProviderReport(report: GenerationPerformanceReport | null): void {
    try {
      this.providerReport = report;
    } catch {
      // Instrumentation must never affect generation.
    }
  }

  mergeChildReport(
    report: GenerationPerformanceReport | null | undefined
  ): void {
    try {
      if (!report || !isRecord(report)) {
        return;
      }
      const reportKey = [
        report.context,
        report.correlationId,
        report.durationMs,
        report.outcome,
        Object.keys(report.phases ?? {}).length,
        report.batches?.length ?? 0,
        report.transports?.length ?? 0,
      ].join('|');
      if (this.mergedReportKeys.has(reportKey)) {
        return;
      }
      this.mergedReportKeys.add(reportKey);

      if (!this.modelId && typeof report.modelId === 'string') {
        this.modelId = safeString(report.modelId) || null;
      }
      if (!this.providerId && typeof report.providerId === 'string') {
        this.providerId = safeString(report.providerId) || null;
      }
      if (
        (this.context === 'UI' || this.correlationId.startsWith('ui-')) &&
        typeof report.correlationId === 'string' &&
        report.correlationId
      ) {
        this.correlationId = report.correlationId;
      }

      for (const [name, value] of Object.entries(report.phases ?? {})) {
        const duration = safeNumber(value);
        if (duration === null) {
          continue;
        }
        this.phases[name] = Math.max(this.phases[name] ?? 0, duration);
      }
      const mergedCounts = maxCounts(this.counts, report.counts);
      for (const [key, value] of Object.entries(mergedCounts)) {
        this.counts[key] = value;
      }

      const existingBatches = new Set(this.batches.map(batchIdentity));
      for (const batch of report.batches ?? []) {
        const sanitized = sanitizeBatch(batch);
        const identity = batchIdentity(sanitized);
        if (!existingBatches.has(identity)) {
          existingBatches.add(identity);
          if (this.batches.length < 200) {
            this.batches.push(sanitized);
          }
        }
      }

      const existingTransports = new Set(
        this.transports.map(transportIdentity)
      );
      for (const transport of report.transports ?? []) {
        const sanitized = sanitizeTransport(transport);
        const identity = transportIdentity(sanitized);
        if (!existingTransports.has(identity)) {
          existingTransports.add(identity);
          if (this.transports.length < 400) {
            this.transports.push(sanitized);
          }
        }
      }

      const existingRecoveryEvents = new Set(
        this.recoveryEvents.map((event) => JSON.stringify(event))
      );
      for (const event of report.recoveryEvents ?? []) {
        const sanitized = sanitizeRecoveryEvent(event);
        const identity = JSON.stringify(sanitized);
        if (!existingRecoveryEvents.has(identity)) {
          existingRecoveryEvents.add(identity);
          if (this.recoveryEvents.length < 200) {
            this.recoveryEvents.push(sanitized);
          }
        }
      }

      this.recovery = maxRecoverySummary(
        this.recovery,
        report.recovery ?? null
      );

      const incomingProcessing = report.resultProcessing;
      if (isRecord(incomingProcessing)) {
        this.resultProcessing = {
          ...this.resultProcessing,
          responseValidationMs: maxTiming(
            this.resultProcessing.responseValidationMs,
            incomingProcessing.responseValidationMs
          ),
          salvageMs: maxTiming(
            this.resultProcessing.salvageMs,
            incomingProcessing.salvageMs
          ),
          assemblyMs: maxTiming(
            this.resultProcessing.assemblyMs,
            incomingProcessing.assemblyMs
          ),
          strictValidationMs: maxTiming(
            this.resultProcessing.strictValidationMs,
            incomingProcessing.strictValidationMs
          ),
          expectedQuestionCount: Math.max(
            this.resultProcessing.expectedQuestionCount,
            safeNumber(incomingProcessing.expectedQuestionCount) ?? 0
          ),
          returnedResultCount: Math.max(
            this.resultProcessing.returnedResultCount,
            safeNumber(incomingProcessing.returnedResultCount) ?? 0
          ),
          generatedCount: Math.max(
            this.resultProcessing.generatedCount,
            safeNumber(incomingProcessing.generatedCount) ?? 0
          ),
          abstainedCount: Math.max(
            this.resultProcessing.abstainedCount,
            safeNumber(incomingProcessing.abstainedCount) ?? 0
          ),
          failedCount: Math.max(
            this.resultProcessing.failedCount,
            safeNumber(incomingProcessing.failedCount) ?? 0
          ),
          validationFailedCount: Math.max(
            this.resultProcessing.validationFailedCount,
            safeNumber(incomingProcessing.validationFailedCount) ?? 0
          ),
          salvagedResultCount: Math.max(
            this.resultProcessing.salvagedResultCount,
            safeNumber(incomingProcessing.salvagedResultCount) ?? 0
          ),
        };
        if (
          this.resultProcessing.responseValidationMs !== null ||
          this.resultProcessing.salvageMs !== null ||
          this.resultProcessing.assemblyMs !== null ||
          this.resultProcessing.strictValidationMs !== null
        ) {
          this.measurementStatus.resultProcessing = 'MEASURED';
        }
      }

      const existingBrowser = new Set(this.browser.map(browserIdentity));
      for (const event of report.browser ?? []) {
        const sanitized = sanitizeBrowser(event);
        const identity = browserIdentity(sanitized);
        if (!existingBrowser.has(identity)) {
          existingBrowser.add(identity);
          if (this.browser.length < 100) {
            this.browser.push(sanitized);
          }
        }
      }

      mergeMeasurementStatus(this.measurementStatus, report.measurementStatus);
      this.providerReport = report;
    } catch {
      // Instrumentation must never affect generation.
    }
  }

  finish(outcome: PerformanceOutcome, durationMs?: number): void {
    try {
      this.outcome = outcome;
      if (durationMs !== undefined) {
        this.finalDurationMs = normalizeDuration(durationMs);
      }
    } catch {
      // Instrumentation must never affect generation.
    }
  }

  get elapsedMs(): number {
    return elapsedSince(this.startedAt);
  }

  get hasMeasurements(): boolean {
    return (
      this.batches.length > 0 ||
      this.transports.length > 0 ||
      this.recoveryEvents.length > 0 ||
      this.recovery !== null ||
      this.browser.length > 0 ||
      Object.keys(this.phases).length > 0 ||
      Object.keys(this.counts).length > 0 ||
      this.resultProcessing.responseValidationMs !== null ||
      this.resultProcessing.salvageMs !== null ||
      this.resultProcessing.strictValidationMs !== null ||
      this.resultProcessing.assemblyMs !== null
    );
  }

  getReport(): GenerationPerformanceReport {
    const transportUsageByBatch = new Map<number, TokenUsageTiming>();
    const transportModelByBatch = new Map<number, string>();
    for (const transport of this.transports) {
      if (transport.batchIndex === null) {
        continue;
      }
      if (transport.usage) {
        transportUsageByBatch.set(transport.batchIndex, transport.usage);
      }
      if (transport.modelId) {
        transportModelByBatch.set(transport.batchIndex, transport.modelId);
      }
    }
    const processingTimings = [
      this.resultProcessing.responseValidationMs,
      this.resultProcessing.salvageMs,
      this.resultProcessing.assemblyMs,
      this.resultProcessing.strictValidationMs,
    ].filter((value): value is number => value !== null);
    return {
      correlationId: safeString(this.correlationId) || 'unknown',
      context: this.context,
      durationMs: this.finalDurationMs ?? elapsedSince(this.startedAt),
      outcome: this.outcome,
      providerId: this.providerId,
      modelId: this.modelId,
      measurementStatus: { ...this.measurementStatus },
      phases: { ...this.phases },
      counts: {
        ...this.counts,
        maxObservedConcurrency: this.maxObservedConcurrency,
        maxQueuedBatches: this.maxQueuedBatches,
      },
      batches: this.batches.map((batch) => {
        const usage =
          batch.usage ?? transportUsageByBatch.get(batch.batchIndex);
        return {
          ...batch,
          modelId:
            batch.modelId ??
            transportModelByBatch.get(batch.batchIndex) ??
            this.modelId,
          usage: usage ? { ...usage } : null,
        };
      }),
      transports: this.transports.map((transport) => ({
        ...transport,
        usage: transport.usage ? { ...transport.usage } : null,
      })),
      recovery: this.recovery
        ? {
            ...this.recovery,
            retryReasons: { ...this.recovery.retryReasons },
          }
        : null,
      recoveryEvents: this.recoveryEvents.map((event) => ({ ...event })),
      resultProcessing: {
        ...this.resultProcessing,
        totalProcessingMs:
          processingTimings.length > 0
            ? normalizeDuration(
                processingTimings.reduce((total, value) => total + value, 0)
              )
            : null,
      },
      browser: this.browser.map((event) => ({ ...event })),
      provider: this.providerReport,
    };
  }

  log(): void {
    try {
      if (!this.hasMeasurements) {
        return;
      }
      const report = this.getReport();
      try {
        (
          globalThis as typeof globalThis & {
            __answersensePerformance?: GenerationPerformanceReport;
          }
        ).__answersensePerformance = report;
      } catch {
        // The debug snapshot is optional.
      }
      console.debug(`[${EXTENSION_NAME}] generation performance`, report);
    } catch {
      // Instrumentation must never affect generation.
    }
  }

  toJSON(): GenerationPerformanceReport {
    return this.getReport();
  }
}
