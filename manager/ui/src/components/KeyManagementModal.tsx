/**
 * KeyManagementModal - SSH key management interface
 *
 * Shows different UI based on whether user has a key:
 * - If publicKey exists: Show key with Copy/Download/Regenerate
 * - If no publicKey: Prompt to generate a key
 */

import { useState, useCallback, useRef, useEffect, ChangeEvent, MouseEvent, DragEvent } from 'react';
import { Copy, Download, CheckCircle, Key, XCircle, Plus, Terminal, ChevronDown, ChevronUp, Upload, FileKey } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import log from '../lib/logger';

interface KeyManagementModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type KeyMode = 'current' | 'generate' | 'import';

function KeyManagementModal({ isOpen, onClose }: KeyManagementModalProps) {
  const { user, generateKey, regenerateKey, importKey } = useAuth();
  const [copied, setCopied] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [privateKeyPem, setPrivateKeyPem] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Default to 'current' if user has a key, otherwise 'generate'
  const [keyMode, setKeyMode] = useState<KeyMode>(() => user?.publicKey ? 'current' : 'generate');

  // Clear sensitive data when modal closes and reset mode
  useEffect(() => {
    if (!isOpen) {
      setPrivateKeyPem('');
      setError(null);
      setIsDragging(false);
      // Reset to current key view if user has one, otherwise generate
      setKeyMode(user?.publicKey ? 'current' : 'generate');
    }
  }, [isOpen, user?.publicKey]);

  // Generate one-liner for SSH key installation
  const oneLiner = user?.publicKey ? `echo "${user.publicKey}" >> ~/.ssh/authorized_keys` : '';

  // Copy to clipboard
  const copyToClipboard = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    } catch (err) {
      log.error('Copy failed', { error: err });
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

  // Handle generate key (no password needed - server-side encryption)
  const handleGenerateKey = async () => {
    setLoading(true);
    setError(null);

    const result = await generateKey();

    if (result.success) {
      setLoading(false);
      onClose(); // Close modal - user will see setup wizard
    } else {
      setError(result.error || 'Failed to generate key');
      setLoading(false);
    }
  };

  // Handle key regeneration (no password needed - server-side encryption)
  const handleRegenerate = async () => {
    if (!confirm('Regenerate your SSH key? You will need to install the new key on the clusters.')) {
      return;
    }

    setLoading(true);
    setError(null);

    const result = await regenerateKey();

    if (result.success) {
      setLoading(false);
      onClose(); // Close modal - user will see setup wizard
    } else {
      setError(result.error || 'Failed to regenerate key');
      setLoading(false);
    }
  };

  // Handle import key
  const handleImportKey = async () => {
    if (!privateKeyPem.trim()) {
      setError('Please paste your private key or upload a file');
      return;
    }

    setLoading(true);
    setError(null);

    const result = await importKey(privateKeyPem.trim());

    if (result.success) {
      setLoading(false);
      setPrivateKeyPem('');
      onClose(); // Close modal - key is now enrolled
    } else {
      setError(result.error || 'Failed to import key');
      setLoading(false);
    }
  };

  // Handle file selection for import
  const handleFileSelect = async (file: File) => {
    if (file.size > 10000) {
      setError('File too large (max 10KB)');
      return;
    }

    try {
      const text = await file.text();
      setPrivateKeyPem(text);
      setError(null);
    } catch {
      setError('Failed to read file');
    }
  };

  // Handle file input change
  const handleFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFileSelect(file);
    }
    // Clear the input value so selecting the same file again will trigger onChange
    e.target.value = '';
  };

  // Handle drag and drop
  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      handleFileSelect(file);
    }
  };

  // Stop propagation on modal content click
  const handleContentClick = (e: MouseEvent) => {
    e.stopPropagation();
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
        onClick={handleContentClick}
      >
        <h3 style={{ marginBottom: '16px', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Key size={20} />
          SSH Key Management
        </h3>

        {/* Tab buttons - always show all options */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
          {hasKey && (
            <button
              className={`key-btn ${keyMode === 'current' ? 'active' : ''}`}
              onClick={() => { setKeyMode('current'); setError(null); }}
              style={{
                flex: 1,
                justifyContent: 'center',
                background: keyMode === 'current' ? 'var(--color-accent)' : 'var(--bg-card)',
                color: keyMode === 'current' ? 'white' : 'var(--text-secondary)',
              }}
            >
              <Key size={16} />
              Current Key
            </button>
          )}
          <button
            className={`key-btn ${keyMode === 'generate' ? 'active' : ''}`}
            onClick={() => { setKeyMode('generate'); setError(null); setPrivateKeyPem(''); }}
            style={{
              flex: 1,
              justifyContent: 'center',
              background: keyMode === 'generate' ? 'var(--color-accent)' : 'var(--bg-card)',
              color: keyMode === 'generate' ? 'white' : 'var(--text-secondary)',
            }}
          >
            <Plus size={16} />
            Generate New
          </button>
          <button
            className={`key-btn ${keyMode === 'import' ? 'active' : ''}`}
            onClick={() => { setKeyMode('import'); setError(null); }}
            style={{
              flex: 1,
              justifyContent: 'center',
              background: keyMode === 'import' ? 'var(--color-accent)' : 'var(--bg-card)',
              color: keyMode === 'import' ? 'white' : 'var(--text-secondary)',
            }}
          >
            <FileKey size={16} />
            Import Existing
          </button>
        </div>

        {/* Current Key tab */}
        {keyMode === 'current' && hasKey && (
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
              {user!.publicKey}
            </div>

            <div className="key-actions">
              <button
                className={`key-btn ${copied === 'key' ? 'copied' : ''}`}
                onClick={() => copyToClipboard(user!.publicKey!, 'key')}
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
          </>
        )}

        {/* Generate New tab */}
        {keyMode === 'generate' && (
          <>
            <div
              style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '8px',
                padding: '16px',
                marginBottom: '16px',
              }}
            >
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', margin: 0 }}>
                Generate a new Ed25519 SSH key. You'll need to install the public key on both HPC clusters.
                {hasKey && ' This will replace your current key.'}
              </p>
            </div>

            <button
              className="key-btn"
              onClick={hasKey ? handleRegenerate : handleGenerateKey}
              disabled={loading}
              style={{ width: '100%', justifyContent: 'center' }}
            >
              {loading ? (
                <>
                  <span className="spinner" style={{ width: 16, height: 16 }} />
                  Generating...
                </>
              ) : (
                <>
                  <Plus size={16} />
                  {hasKey ? 'Regenerate Key' : 'Generate Key'}
                </>
              )}
            </button>
          </>
        )}

        {/* Import Existing tab */}
        {keyMode === 'import' && (
          <>
            <div
              style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '8px',
                padding: '16px',
                marginBottom: '16px',
              }}
            >
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', margin: 0, marginBottom: '8px' }}>
                Import a private key that's already authorized on both clusters (Ed25519, RSA, or ECDSA).
                SSH connection will be tested before accepting.
                {hasKey && ' This will replace your current key.'}
              </p>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: 0 }}>
                <strong>Tip:</strong> Your key is typically at <code style={{ background: 'var(--bg-input)', padding: '1px 4px', borderRadius: '3px' }}>~/.ssh/id_ed25519</code> or <code style={{ background: 'var(--bg-input)', padding: '1px 4px', borderRadius: '3px' }}>~/.ssh/id_rsa</code>.
                On Mac, press <kbd style={{ background: 'var(--bg-input)', padding: '1px 4px', borderRadius: '3px', fontFamily: 'inherit' }}>⌘⇧G</kbd> in the file picker to navigate to hidden folders.
              </p>
            </div>

            {/* File drop zone / textarea */}
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              style={{
                border: `2px dashed ${isDragging ? 'var(--color-accent)' : 'var(--border-subtle)'}`,
                borderRadius: '8px',
                padding: '16px',
                marginBottom: '16px',
                background: isDragging ? 'var(--color-accent-bg)' : 'var(--bg-card)',
                transition: 'all 0.2s',
              }}
            >
              <textarea
                value={privateKeyPem}
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setPrivateKeyPem(e.target.value)}
                placeholder="Paste your private key here (-----BEGIN OPENSSH PRIVATE KEY-----...)"
                style={{
                  width: '100%',
                  minHeight: '120px',
                  padding: '10px 12px',
                  borderRadius: '4px',
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--bg-input)',
                  color: 'var(--text-primary)',
                  fontFamily: 'monospace',
                  fontSize: '0.8rem',
                  resize: 'vertical',
                  boxSizing: 'border-box',
                }}
              />
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', marginTop: '12px' }}>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>or</span>
                <button
                  className="key-btn"
                  onClick={() => fileInputRef.current?.click()}
                  style={{ padding: '6px 12px' }}
                >
                  <Upload size={14} />
                  Browse file
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pem,.key,application/x-pem-file,application/octet-stream"
                  onChange={handleFileInputChange}
                  style={{ display: 'none' }}
                />
              </div>
            </div>

            <button
              className="key-btn"
              onClick={handleImportKey}
              disabled={loading || !privateKeyPem.trim()}
              style={{ width: '100%', justifyContent: 'center' }}
            >
              {loading ? (
                <>
                  <span className="spinner" style={{ width: 16, height: 16 }} />
                  Validating & Importing...
                </>
              ) : (
                <>
                  <FileKey size={16} />
                  Import Key
                </>
              )}
            </button>
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <XCircle size={16} />
              {error}
            </div>
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
