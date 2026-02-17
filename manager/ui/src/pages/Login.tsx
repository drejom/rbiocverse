/**
 * Login Page - Split design with IDE icons and cluster health
 */

import { useState, FormEvent, KeyboardEvent } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import ClusterHealthCard from '../components/ClusterHealthCard';
import ThemeToggle from '../components/ThemeToggle';
import type { ClusterHealth, ClusterHistoryPoint } from '../types';

interface LoginProps {
  clusterHealth?: {
    gemini?: ClusterHealth | null;
    apollo?: ClusterHealth | null;
  };
  clusterHistory?: {
    gemini?: ClusterHistoryPoint[];
    apollo?: ClusterHistoryPoint[];
  };
}

function Login({ clusterHealth = {}, clusterHistory = {} }: LoginProps) {
  const { login, error, loading, clearError } = useAuth();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    clearError();
    await login(username, password, rememberMe);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key === 'Enter' && !loading && username && password) {
      e.preventDefault();
      clearError();
      login(username, password, rememberMe);
    }
  };

  return (
    <div className="login-page">
      {/* Left side - Cluster health and IDE icons */}
      <div className="login-left">
        <div className="login-left-spacer" />
        <div className="login-left-content">
          <div className="login-clusters">
            <ClusterHealthCard
              name="Gemini"
              health={clusterHealth.gemini || null}
              history={clusterHistory.gemini}
            />
            <ClusterHealthCard
              name="Apollo"
              health={clusterHealth.apollo || null}
              history={clusterHistory.apollo}
            />
          </div>

          <div className="ide-icons">
            <div className="ide-icon">
              <i className="devicon-vscode-plain" />
              <span>VS Code</span>
            </div>
            <div className="ide-icon">
              <i className="devicon-rstudio-plain" />
              <span>RStudio</span>
            </div>
            <div className="ide-icon">
              <i className="devicon-jupyter-plain" />
              <span>JupyterLab</span>
            </div>
          </div>
        </div>
        <div className="login-left-spacer" />
      </div>

      {/* Right side - Login form */}
      <div className="login-right">
        <div className="login-form-container">
          {/* Logo */}
          <div className="login-logo">
            <div className="login-logo-icon">
              <img src="/icons/icon.svg" alt="rbiocverse" width={28} height={28} />
            </div>
            <span className="login-logo-text">rbiocverse</span>
            <div style={{ marginLeft: 'auto' }}>
              <ThemeToggle />
            </div>
          </div>

          {/* Ecosystem logos - Bioconductor & scverse */}
          <div className="ecosystem-logos">
            <a
              href="https://bioconductor.org"
              target="_blank"
              rel="noopener noreferrer"
              className="ecosystem-logo"
              title="Bioconductor - R packages for genomics"
            >
              <img src="/images/bioconductor-full-dark.svg" alt="Bioconductor" className="logo-dark" />
              <img src="/images/bioconductor-full-light.svg" alt="Bioconductor" className="logo-light" />
            </a>
            <a
              href="https://scverse.org"
              target="_blank"
              rel="noopener noreferrer"
              className="ecosystem-logo"
              title="scverse - Python tools for single-cell analysis"
            >
              <img src="/images/scverse-full-dark.svg" alt="scverse" className="logo-dark" />
              <img src="/images/scverse-full-light.svg" alt="scverse" className="logo-light" />
            </a>
          </div>

          {/* Form */}
          <form className="login-form" onSubmit={handleSubmit} onKeyDown={handleKeyDown}>
            {error && <div className="login-error">{error}</div>}

            <div className="form-group">
              <label htmlFor="username">Username</label>
              <input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Enter your COH username"
                autoComplete="username"
                autoFocus
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="password">Password</label>
              <div style={{ position: 'relative' }}>
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  autoComplete="current-password"
                  required
                  style={{ paddingRight: '44px' }}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  style={{
                    position: 'absolute',
                    right: '12px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none',
                    border: 'none',
                    padding: '4px',
                    cursor: 'pointer',
                    color: 'var(--text-muted)',
                  }}
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            <div className="checkbox-group">
              <input
                id="rememberMe"
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
              />
              <label htmlFor="rememberMe">
                Remember me for 14 days
              </label>
            </div>

            <button
              type="submit"
              className="login-btn"
              disabled={loading || !username || !password}
            >
              {loading ? (
                <>
                  <span className="spinner" style={{ width: 16, height: 16 }} />
                  Signing in...
                </>
              ) : (
                'Sign in'
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

export default Login;
