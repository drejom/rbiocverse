/**
 * useGlobalErrorHandler - Installs global error handlers for uncaught errors
 *
 * Catches:
 * - Unhandled promise rejections
 * - Window errors (runtime errors)
 * - Reports them to backend via logger
 */

import { useEffect } from 'react';
import log from '../lib/logger';

/**
 * Hook to install global error handlers
 * Call once at app root level
 */
export function useGlobalErrorHandler(): void {
  useEffect(() => {
    // Handle unhandled promise rejections
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const error = event.reason;
      log.error('Unhandled promise rejection', {
        action: 'unhandledRejection',
        error: error instanceof Error ? error : new Error(String(error)),
      });
    };

    // Handle window errors (runtime errors)
    const handleWindowError = (event: ErrorEvent) => {
      // Ignore ResizeObserver loop errors (common, harmless)
      if (event.message?.includes('ResizeObserver loop')) {
        return;
      }

      log.error('Uncaught error', {
        action: 'windowError',
        error: event.error || new Error(event.message),
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      });
    };

    window.addEventListener('unhandledrejection', handleUnhandledRejection);
    window.addEventListener('error', handleWindowError);

    return () => {
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
      window.removeEventListener('error', handleWindowError);
    };
  }, []);
}

export default useGlobalErrorHandler;
