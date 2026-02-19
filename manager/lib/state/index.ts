/**
 * State management module
 *
 * Re-exports StateManager and all related types/utilities from a single entry point,
 * providing a consolidated public API for state management.
 */

// Re-export StateManager class from the main state file
// Note: StateManager remains in the parent directory to minimize refactoring risk
export { StateManager } from '../state';

// Re-export all types, constants, and utilities from types module
export {
  // Constants
  POLLING_CONFIG,
  ONE_DAY_MS,
  // Utility functions
  buildSessionKey,
  parseSessionKey,
  createIdleSession,
} from './types';

export type {
  // Interfaces
  HpcService,
  JobInfo,
  HpcServiceFactory,
  ParsedSessionKey,
  ActiveSession,
  ClusterHealthState,
  AppState,
  UserAccountCache,
  PollingInfo,
  ClearSessionOptions,
  // Re-exported from db modules
  Session,
  ClusterHealth,
  HealthHistoryEntry,
} from './types';
