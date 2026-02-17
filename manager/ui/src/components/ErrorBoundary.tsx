/**
 * ErrorBoundary - Catches React rendering errors and reports to backend
 *
 * Wraps components to catch errors during rendering, lifecycle methods,
 * and constructors. Reports errors to backend ErrorLogger for admin visibility.
 */

import { Component, ErrorInfo, ReactNode } from 'react';
import log from '../lib/logger';

interface ErrorBoundaryProps {
  children: ReactNode;
  name?: string;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Report to backend via logger
    log.error('React component error', {
      action: 'render',
      component: this.props.name || 'unknown',
      error,
      componentStack: errorInfo.componentStack,
    });
  }

  render(): ReactNode {
    if (this.state.hasError) {
      // Render fallback UI
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="error-boundary-fallback">
          <h3>Something went wrong</h3>
          <p>This section encountered an error. Please try refreshing the page.</p>
          {import.meta.env.DEV && this.state.error && (
            <details>
              <summary>Error details</summary>
              <pre>{String(this.state.error)}</pre>
            </details>
          )}
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="btn btn-secondary"
          >
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
