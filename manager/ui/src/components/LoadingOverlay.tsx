/**
 * Loading overlay component
 * Shows launch progress with SSE streaming
 * Includes SSH error detection with option to set up keys
 *
 * Reads modal state from SessionStateContext (set by useLaunch).
 */
import { ArrowLeft, X, Key } from 'lucide-react';
import { useSessionState } from '../contexts/SessionStateContext';

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
  onBack: () => void;
  onCancel: () => void;
  onSetupKeys?: () => void;
}

export function LoadingOverlay({
  onBack,
  onCancel,
  onSetupKeys,
}: LoadingOverlayProps) {
  const { launchModal } = useSessionState();

  // Read all state from context
  if (!launchModal?.active) return null;

  const {
    header,
    message,
    progress,
    step,
    error,
    pending,
    indeterminate,
    isSshError,
  } = launchModal;

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
