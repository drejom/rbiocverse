/**
 * Loading overlay component
 * Shows launch progress with SSE streaming
 * Includes SSH error detection with option to set up keys
 */
import { ArrowLeft, X, Key } from 'lucide-react';

interface StepEstimates {
  [key: string]: number;
}

const STEP_ESTIMATES: StepEstimates = {
  connecting: 10,
  submitting: 40,
  submitted: 45,
  waiting: 70,
  starting: 75,
  establishing: 100,
  pending: 100,  // Job queued, transitioning to pending card
};

interface LoadingOverlayProps {
  visible: boolean;
  header?: string;
  message?: string;
  progress?: number;
  step?: string;
  error?: string | null;
  pending?: boolean;
  indeterminate?: boolean;
  isSshError?: boolean;
  onBack: () => void;
  onCancel: () => void;
  onSetupKeys?: () => void;
}

export function LoadingOverlay({
  visible,
  header,
  message,
  progress,
  step,
  error,
  pending,
  indeterminate,
  isSshError,
  onBack,
  onCancel,
  onSetupKeys,
}: LoadingOverlayProps) {
  if (!visible) return null;

  const fillWidth = `${progress || 0}%`;
  const estimateWidth = `${Math.min(100, (step && STEP_ESTIMATES[step]) || (progress || 0) + 5)}%`;

  const fillClass = [
    'progress-bar-fill',
    pending && 'pending',
    indeterminate && 'indeterminate',
    error && 'error',
  ].filter(Boolean).join(' ');

  const estimateClass = [
    'progress-bar-estimate',
    pending && 'pending',
  ].filter(Boolean).join(' ');

  return (
    <div className="loading-overlay">
      <div className="loading-content">
        <div className="progress-container">
          <div className="progress-header">{header || 'Starting...'}</div>
          <div className="progress-step">{message || 'Connecting...'}</div>
          <div className="progress-bar">
            <div className={estimateClass} style={{ width: estimateWidth }} />
            <div className={fillClass} style={{ width: fillWidth }} />
          </div>
          {error && (
            <div className="progress-error">
              {error}
              {isSshError && (
                <p style={{ fontSize: '0.85rem', marginTop: '8px', opacity: 0.8 }}>
                  This may be an SSH key issue. Try setting up your keys.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="launch-actions">
          {isSshError && onSetupKeys && (
            <button className="btn btn-primary" onClick={onSetupKeys}>
              <Key className="icon-sm" /> Set up SSH Keys
            </button>
          )}
          <button className="btn btn-secondary" onClick={onBack}>
            <ArrowLeft className="icon-sm" /> Back to Menu
          </button>
          {!isSshError && (
            <button className="btn btn-cancel" onClick={onCancel}>
              <X className="icon-sm" /> Stop
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default LoadingOverlay;
