/**
 * Loading overlay component
 * Shows launch progress with SSE streaming
 */
import { ArrowLeft, X } from 'lucide-react';

const STEP_ESTIMATES = {
  connecting: 10,
  submitting: 40,
  submitted: 45,
  waiting: 70,
  starting: 75,
  establishing: 100,
};

export function LoadingOverlay({
  visible,
  header,
  message,
  progress,
  step,
  error,
  pending,
  indeterminate,
  onBack,
  onCancel,
}) {
  if (!visible) return null;

  const fillWidth = `${progress || 0}%`;
  const estimateWidth = `${Math.min(100, STEP_ESTIMATES[step] || progress + 5)}%`;

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
          {error && <div className="progress-error">{error}</div>}
        </div>

        <div className="launch-actions">
          <button className="btn btn-secondary" onClick={onBack}>
            <ArrowLeft className="icon-sm" /> Back to Menu
          </button>
          <button className="btn btn-cancel" onClick={onCancel}>
            <X className="icon-sm" /> Stop
          </button>
        </div>
      </div>
    </div>
  );
}

export default LoadingOverlay;
