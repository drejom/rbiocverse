/**
 * ErrorBoundary - Catches React rendering errors and reports to backend
 *
 * Wraps components to catch errors during rendering, lifecycle methods,
 * and constructors. Reports errors to backend ErrorLogger for admin visibility.
 */

import React from 'react';
import log from '../lib/logger';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    // Report to backend via logger
    log.error('React component error', {
      action: 'render',
      component: this.props.name || 'unknown',
      error,
      componentStack: errorInfo.componentStack,
    });
  }

  render() {
    if (this.state.hasError) {
      // Render fallback UI
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="error-boundary-fallback">
          <h3>Something went wrong</h3>
          <p>This section encountered an error. Please try refreshing the page.</p>
          {process.env.NODE_ENV !== 'production' && this.state.error && (
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
