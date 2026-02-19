/**
 * LockManager - mutex for concurrent operation prevention
 * Extracted from StateManager to allow independent testing and reuse.
 */

import { LockError } from '../errors';
import { log } from '../logger';

export class LockManager {
  private locks = new Map<string, number>();

  /**
   * Acquire lock for an operation
   * @throws {LockError} If lock already held
   */
  acquireLock(operation: string): void {
    if (this.locks.has(operation)) {
      throw new LockError('Operation already in progress', { operation });
    }
    this.locks.set(operation, Date.now());
    log.lock(`Acquired: ${operation}`);
  }

  /**
   * Release lock for an operation
   */
  releaseLock(operation: string): void {
    if (this.locks.has(operation)) {
      const held = Date.now() - this.locks.get(operation)!;
      log.lock(`Released: ${operation}`, { heldMs: held });
      this.locks.delete(operation);
    }
  }

  /**
   * Check if lock is held
   */
  isLocked(operation: string): boolean {
    return this.locks.has(operation);
  }

  /**
   * Get all active locks (for debugging)
   */
  getActiveLocks(): string[] {
    return Array.from(this.locks.keys());
  }
}
