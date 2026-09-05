import type { ProcessingCycle } from '../Models/Logical';

let cycleSequence = 0;

function createCycleId(): string {
  const randomUuid = globalThis.crypto?.randomUUID;
  if (randomUuid) {
    return randomUuid.call(globalThis.crypto);
  }

  cycleSequence += 1;
  return `cycle-${Date.now()}-${cycleSequence}`;
}

export function createProcessingCycle(
  idFactory: () => string = createCycleId,
): ProcessingCycle {
  const cycleId = idFactory();
  if (!cycleId.trim()) {
    throw new Error('A processing cycle requires a non-empty cycleId.');
  }
  return { cycleId };
}

export function isCurrentCycle(
  responseCycleId: string,
  currentCycle: ProcessingCycle,
): boolean {
  return responseCycleId === currentCycle.cycleId;
}
