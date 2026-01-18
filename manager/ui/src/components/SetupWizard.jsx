/**
 * SetupWizard - First-login SSH key setup and connection testing
 *
 * Flow:
 * 1. Auto-test connections on mount
 * 2. If BOTH clusters connect AND no managed key → auto-complete (user's SSH works)
 * 3. If BOTH clusters connect AND has managed key → show message that existing keys work,
 *    but they should install the managed key if they want to use it
 * 4. If any fail → show SSH key setup instructions
 *
 * Note: Requires BOTH clusters to pass for setup completion.
 */

import { useState, useCallback, useEffect } from 'react';
import { Copy, Download, CheckCircle, XCircle, Key, Terminal, ChevronDown, ChevronUp } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

function SetupWizard({ publicKey, onComplete }) {
  const { completeSetup } = useAuth();
  const [copied, setCopied] = useState(null);
  const [tests, setTests] = useState({
    gemini: { status: 'idle', error: null },
    apollo: { status: 'idle', error: null },
  });
  const [showHelp, setShowHelp] = useState(false);
  // Skip auto-test if ?skipAutoTest=1 in URL (for debugging)
  const skipAutoTest = new URLSearchParams(window.location.search).has('skipAutoTest');
  const [initialTestDone, setInitialTestDone] = useState(skipAutoTest);
  const [autoCompleting] = useState(false);
  // Track if SSH passed but user has a managed key to install
  const [existingKeysWork, setExistingKeysWork] = useState(false);

  // Generate one-liner for SSH key installation
  const oneLiner = publicKey ? `echo "${publicKey}" >> ~/.ssh/authorized_keys` : '';

  // Test connection to a cluster
  const testConnection = useCallback(async (cluster) => {
    setTests(prev => ({
      ...prev,
      [cluster]: { status: 'testing', error: null },
    }));

    try {
      const res = await fetch(`/api/auth/test-connection/${cluster}`, {
        method: 'POST',
      });

      const data = await res.json();

      if (data.success) {
        setTests(prev => ({
          ...prev,
          [cluster]: { status: 'success', error: null },
        }));
        return true;
      } else {
        setTests(prev => ({
          ...prev,
          [cluster]: { status: 'error', error: data.error || 'Connection failed' },
        }));
        return false;
      }
    } catch (err) {
      setTests(prev => ({
        ...prev,
        [cluster]: { status: 'error', error: 'Network error. Please try again.' },
      }));
      return false;
    }
  }, []);

  // Auto-test both clusters on mount
  useEffect(() => {
    if (initialTestDone) return;

    const runInitialTests = async () => {
      // Test both in parallel
      setTests({
        gemini: { status: 'testing', error: null },
        apollo: { status: 'testing', error: null },
      });

      const [geminiOk, apolloOk] = await Promise.all([
        testConnection('gemini'),
        testConnection('apollo'),
      ]);

      setInitialTestDone(true);

      // BOTH must succeed
      if (geminiOk && apolloOk) {
        // SSH works - show success message (don't auto-complete)
        // User can choose to continue or generate managed key
        setExistingKeysWork(true);
      }
    };

    runInitialTests();
  }, [initialTestDone, testConnection]);

  // Copy to clipboard
  const copyToClipboard = useCallback(async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  }, []);

  // Download public key as file
  const downloadKey = useCallback(() => {
    const blob = new Blob([publicKey], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'rbiocverse_id.pub';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [publicKey]);

  // Check if BOTH connections succeeded (required for setup completion)
  const bothConnected = tests.gemini.status === 'success' && tests.apollo.status === 'success';
  const anyFailed = tests.gemini.status === 'error' || tests.apollo.status === 'error';
  const needsKeySetup = initialTestDone && !bothConnected;

  // Handle completion
  const handleComplete = async () => {
    const success = await completeSetup();
    if (success && onComplete) {
      onComplete();
    }
  };

  // Show loading state during initial tests
  if (!initialTestDone || autoCompleting) {
    return (
      <div className="setup-wizard">
        <h1>Welcome to rbiocverse</h1>
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <div className="spinner" style={{ width: 40, height: 40, margin: '0 auto 16px' }} />
          <p style={{ color: 'var(--text-secondary)' }}>
            {autoCompleting ? 'Setting up your account...' : 'Checking cluster connections...'}
          </p>
        </div>
      </div>
    );
  }

  // If tests passed and no managed key, this component won't render (auto-complete redirects)
  // Show key setup if tests failed OR if user has a managed key to install
  return (
    <div className="setup-wizard">
      <h1>Welcome to rbiocverse</h1>

      {/* Message when existing SSH works */}
      {existingKeysWork && (
        <div
          style={{
            background: 'var(--color-success-bg, rgba(34, 197, 94, 0.1))',
            border: '1px solid var(--color-success, #22c55e)',
            borderRadius: 8,
            padding: 16,
            marginBottom: 20,
            display: 'flex',
            gap: 12,
            alignItems: 'flex-start',
          }}
        >
          <CheckCircle size={20} style={{ color: 'var(--color-success, #22c55e)', flexShrink: 0, marginTop: 2 }} />
          <div>
            <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
              Your SSH keys are working
            </div>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', margin: 0 }}>
              {publicKey
                ? 'You can continue with your current setup, or install the managed key below if you want rbiocverse to manage your SSH access.'
                : 'You can continue with your current setup. You can also generate a managed key later from the user menu if needed.'}
            </p>
          </div>
        </div>
      )}

      {needsKeySetup && !existingKeysWork ? (
        <p className="setup-wizard-intro">
          {anyFailed
            ? "We couldn't connect to both HPC clusters. You'll need to install your SSH key before you can launch IDE sessions. This is a one-time setup."
            : 'Almost there! Test your connections to continue.'}
        </p>
      ) : null}

      {/* SSH Key Section - show if we have a managed key to display */}
      {publicKey && (
        <div className="setup-section">
          <h3>
            <Key size={18} style={{ marginRight: 8, verticalAlign: -3 }} />
            Install your SSH key
          </h3>
          <p>
            Copy your public key to the cluster's <code>~/.ssh/authorized_keys</code> file.
            Use one of the methods below:
          </p>

          <div className="key-actions">
            <button
              className={`key-btn ${copied === 'key' ? 'copied' : ''}`}
              onClick={() => copyToClipboard(publicKey, 'key')}
            >
              {copied === 'key' ? (
                <>
                  <CheckCircle size={16} />
                  Copied!
                </>
              ) : (
                <>
                  <Copy size={16} />
                  Copy Key
                </>
              )}
            </button>

            <button
              className={`key-btn ${copied === 'oneliner' ? 'copied' : ''}`}
              onClick={() => copyToClipboard(oneLiner, 'oneliner')}
            >
              {copied === 'oneliner' ? (
                <>
                  <CheckCircle size={16} />
                  Copied!
                </>
              ) : (
                <>
                  <Terminal size={16} />
                  Copy One-Liner
                </>
              )}
            </button>

            <button className="key-btn" onClick={downloadKey}>
              <Download size={16} />
              Download .pub
            </button>
          </div>

          <button
            className="key-btn"
            onClick={() => setShowHelp(!showHelp)}
            style={{ width: '100%', justifyContent: 'center' }}
          >
            {showHelp ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            {showHelp ? 'Hide help' : 'Show installation help'}
          </button>

          {showHelp && (
            <div
              style={{
                marginTop: 16,
                padding: 16,
                background: 'var(--bg-input)',
                borderRadius: 8,
                fontSize: '0.9rem',
                color: 'var(--text-secondary)',
              }}
            >
              <p style={{ marginBottom: 12 }}>
                <strong>Option A: One-liner</strong> (easiest)
              </p>
              <ol style={{ marginLeft: 20, marginBottom: 16 }}>
                <li>SSH into Gemini or Apollo from your terminal</li>
                <li>Run the one-liner command</li>
                <li>Done!</li>
              </ol>

              <p style={{ marginBottom: 12 }}>
                <strong>Option B: Manual</strong>
              </p>
              <ol style={{ marginLeft: 20 }}>
                <li>Copy the public key</li>
                <li>SSH into the cluster</li>
                <li>Open <code>~/.ssh/authorized_keys</code> in a text editor</li>
                <li>Paste the key on a new line</li>
                <li>Save and exit</li>
              </ol>
            </div>
          )}
        </div>
      )}

      {/* Test Connection Section */}
      <div className="setup-section">
        <h3>
          <Terminal size={18} style={{ marginRight: 8, verticalAlign: -3 }} />
          {needsKeySetup ? 'Test connection after installing key' : 'Connection Status'}
        </h3>

        {['gemini', 'apollo'].map(cluster => (
          <div className="connection-test" key={cluster}>
            <span className="connection-test-name">
              {cluster.charAt(0).toUpperCase() + cluster.slice(1)}
            </span>

            {tests[cluster].status === 'idle' && (
              <button
                className="connection-test-btn"
                onClick={() => testConnection(cluster)}
              >
                Test Connection
              </button>
            )}

            {tests[cluster].status === 'testing' && (
              <span className="connection-test-status">
                <span className="spinner" style={{ width: 16, height: 16 }} />
                Testing...
              </span>
            )}

            {tests[cluster].status === 'success' && (
              <span className="connection-test-status success">
                <CheckCircle size={16} />
                Connected!
              </span>
            )}

            {tests[cluster].status === 'error' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="connection-test-status error">
                  <XCircle size={16} />
                  Failed
                </span>
                <button
                  className="connection-test-btn"
                  onClick={() => testConnection(cluster)}
                  style={{ padding: '6px 12px', fontSize: '0.8rem' }}
                >
                  Retry
                </button>
              </div>
            )}
          </div>
        ))}

        {/* Show error details */}
        {anyFailed && (tests.gemini.error || tests.apollo.error) && (
          <div
            style={{
              marginTop: 12,
              padding: 12,
              background: 'var(--color-danger-bg)',
              borderRadius: 8,
              fontSize: '0.85rem',
              color: 'var(--color-danger-text)',
            }}
          >
            {tests.gemini.error && <p>Gemini: {tests.gemini.error}</p>}
            {tests.apollo.error && <p>Apollo: {tests.apollo.error}</p>}
          </div>
        )}
      </div>

      {/* Continue button */}
      <button
        className="login-btn"
        onClick={handleComplete}
        disabled={!bothConnected}
        style={{ marginTop: 20 }}
      >
        {bothConnected ? 'Continue to Launcher' : 'Connect to both clusters to continue'}
      </button>
    </div>
  );
}

export default SetupWizard;
