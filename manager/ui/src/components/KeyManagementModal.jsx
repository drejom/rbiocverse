/**
 * KeyManagementModal - SSH key management interface
 *
 * Shows different UI based on whether user has a managed key:
 * - If publicKey exists: Show key with Copy/Download/Regenerate/Remove
 * - If no publicKey: Offer to generate a managed key
 */

import { useState, useCallback } from 'react';
import { Copy, Download, CheckCircle, RefreshCw, Key, XCircle, Trash2, Plus, Terminal, ChevronDown, ChevronUp } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

function KeyManagementModal({ isOpen, onClose }) {
  const { user, generateKey, removeKey, regenerateKey } = useAuth();
  const [copied, setCopied] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [showHelp, setShowHelp] = useState(false);
  const [password, setPassword] = useState('');
  const [showPasswordInput, setShowPasswordInput] = useState(null); // 'generate' or 'regenerate'

  // Generate one-liner for SSH key installation
  const oneLiner = user?.publicKey ? `echo "${user.publicKey}" >> ~/.ssh/authorized_keys` : '';

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

  // Download public key
  const downloadKey = useCallback(() => {
    if (!user?.publicKey) return;
    const blob = new Blob([user.publicKey], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'rbiocverse_id.pub';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [user?.publicKey]);

  // Handle generate key
  const handleGenerateKey = async () => {
    if (!showPasswordInput) {
      setShowPasswordInput('generate');
      setPassword('');
      setError(null);
      return;
    }

    if (!password) {
      setError('Password required');
      return;
    }

    setLoading(true);
    setError(null);

    const result = await generateKey(password);

    if (result.success) {
      setLoading(false);
      setPassword('');
      setShowPasswordInput(null);
      onClose(); // Close modal - user will see setup wizard
    } else {
      setError(result.error || 'Failed to generate key');
      setLoading(false);
    }
  };

  // Handle remove key
  const handleRemoveKey = async () => {
    if (!confirm('Remove your managed SSH key? You\'ll need working personal SSH keys to continue using rbiocverse.')) {
      return;
    }

    setLoading(true);
    setError(null);
    setTestResult(null);

    const result = await removeKey();

    if (result.success) {
      setLoading(false);
    } else {
      setError(result.error || 'Failed to remove key');
      setTestResult(result.sshTestResult);
      setLoading(false);
    }
  };

  // Handle key regeneration
  const handleRegenerate = async () => {
    if (!showPasswordInput) {
      if (!confirm('Regenerate your SSH key? You will need to install the new key on the clusters.')) {
        return;
      }
      setShowPasswordInput('regenerate');
      setPassword('');
      setError(null);
      return;
    }

    if (!password) {
      setError('Password required');
      return;
    }

    setLoading(true);
    setError(null);

    const result = await regenerateKey(password);

    if (result.success) {
      setLoading(false);
      setPassword('');
      setShowPasswordInput(null);
      onClose(); // Close modal - user will see setup wizard
    } else {
      setError(result.error || 'Failed to regenerate key');
      setLoading(false);
    }
  };

  // Cancel password input
  const cancelPasswordInput = () => {
    setShowPasswordInput(null);
    setPassword('');
    setError(null);
  };

  if (!isOpen) return null;

  const hasKey = !!user?.publicKey;

  return (
    <div className="loading-overlay" onClick={onClose} style={{ textAlign: 'center' }}>
      <div
        style={{
          display: 'inline-block',
          textAlign: 'left',
          background: 'var(--bg-panel)',
          borderRadius: '16px',
          padding: '24px',
          maxWidth: '90vw',
          maxHeight: '80vh',
          overflow: 'auto',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginBottom: '16px', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Key size={20} />
          SSH Key Management
        </h3>

        {hasKey ? (
          // Has managed key - show it with actions
          <>
            <p style={{ marginBottom: '16px', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
              Your managed SSH key for HPC cluster authentication:
            </p>

            <div
              style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '8px',
                padding: '12px',
                marginBottom: '16px',
                fontFamily: 'monospace',
                fontSize: '0.75rem',
                wordBreak: 'break-all',
                color: 'var(--text-secondary)',
                maxHeight: '100px',
                overflow: 'auto',
                width: 0,
                minWidth: '100%',
              }}
            >
              {user.publicKey}
            </div>

            <div className="key-actions">
              <button
                className={`key-btn ${copied === 'key' ? 'copied' : ''}`}
                onClick={() => copyToClipboard(user.publicKey, 'key')}
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

            {showPasswordInput === 'regenerate' && (
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                  Enter your password to encrypt the new key:
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Your COH password"
                  autoFocus
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    borderRadius: '8px',
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--bg-input)',
                    color: 'var(--text-primary)',
                    fontSize: '0.95rem',
                    boxSizing: 'border-box',
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && handleRegenerate()}
                />
              </div>
            )}

            <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
              {showPasswordInput === 'regenerate' && (
                <button
                  className="key-btn"
                  onClick={cancelPasswordInput}
                  style={{ flex: 1, justifyContent: 'center' }}
                >
                  Cancel
                </button>
              )}
              <button
                className="key-btn"
                onClick={handleRegenerate}
                disabled={loading}
                style={{ flex: 1, justifyContent: 'center' }}
              >
                {loading ? (
                  <span className="spinner" style={{ width: 16, height: 16 }} />
                ) : (
                  <>
                    <RefreshCw size={16} />
                    {showPasswordInput === 'regenerate' ? 'Confirm' : 'Regenerate'}
                  </>
                )}
              </button>
            </div>

            <button
              className="key-btn"
              onClick={() => setShowHelp(!showHelp)}
              style={{ width: '100%', justifyContent: 'center', marginBottom: '10px' }}
            >
              {showHelp ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              {showHelp ? 'Hide help' : 'Show installation help'}
            </button>

            {showHelp && (
              <div
                style={{
                  marginBottom: 10,
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

            <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '16px' }}>
              <button
                className="key-btn"
                onClick={handleRemoveKey}
                disabled={loading}
                style={{ width: '100%', justifyContent: 'center', color: 'var(--color-danger)' }}
              >
                {loading ? (
                  <>
                    <span className="spinner" style={{ width: 16, height: 16 }} />
                    Checking SSH...
                  </>
                ) : (
                  <>
                    <Trash2 size={16} />
                    Remove managed key
                  </>
                )}
              </button>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '8px', textAlign: 'center' }}>
                Only remove if you have personal SSH keys configured.
              </p>
            </div>
          </>
        ) : (
          // No managed key - offer to generate one
          <>
            <div
              style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '8px',
                padding: '16px',
                marginBottom: '20px',
              }}
            >
              <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '8px' }}>
                No managed key
              </div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', margin: 0 }}>
                Your SSH is working with your existing setup. You can optionally generate
                a managed key as a backup or for easier key rotation.
              </p>
            </div>

            {showPasswordInput === 'generate' && (
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                  Enter your password to encrypt the key:
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Your COH password"
                  autoFocus
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    borderRadius: '8px',
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--bg-input)',
                    color: 'var(--text-primary)',
                    fontSize: '0.95rem',
                    boxSizing: 'border-box',
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && handleGenerateKey()}
                />
              </div>
            )}

            <div style={{ display: 'flex', gap: '8px' }}>
              {showPasswordInput === 'generate' && (
                <button
                  className="key-btn"
                  onClick={cancelPasswordInput}
                  style={{ flex: 1, justifyContent: 'center' }}
                >
                  Cancel
                </button>
              )}
              <button
                className="key-btn"
                onClick={handleGenerateKey}
                disabled={loading}
                style={{ flex: 1, justifyContent: 'center' }}
              >
                {loading ? (
                  <>
                    <span className="spinner" style={{ width: 16, height: 16 }} />
                    Generating...
                  </>
                ) : (
                  <>
                    <Plus size={16} />
                    {showPasswordInput === 'generate' ? 'Confirm' : 'Generate managed key'}
                  </>
                )}
              </button>
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '8px', textAlign: 'center' }}>
              Creates a key that rbiocverse manages for you.
            </p>
          </>
        )}

        {/* Error display */}
        {error && (
          <div
            style={{
              marginTop: '16px',
              padding: '12px',
              background: 'var(--color-danger-bg)',
              borderRadius: '8px',
              color: 'var(--color-danger-text)',
              fontSize: '0.9rem',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: testResult ? '8px' : 0 }}>
              <XCircle size={16} />
              {error}
            </div>
            {testResult && (
              <div style={{ fontSize: '0.85rem', marginTop: '8px' }}>
                <div>Gemini: {testResult.gemini ? 'Connected' : `Failed - ${testResult.geminiError || 'Unknown'}`}</div>
                <div>Apollo: {testResult.apollo ? 'Connected' : `Failed - ${testResult.apolloError || 'Unknown'}`}</div>
              </div>
            )}
          </div>
        )}

        {/* Close button */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '20px' }}>
          <button
            className="key-btn"
            onClick={onClose}
            style={{ padding: '8px 24px' }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export default KeyManagementModal;
