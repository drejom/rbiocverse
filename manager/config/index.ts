/**
 * Configuration management
 * Centralizes all environment variables and cluster-specific settings
 */

// Type definitions for configuration objects

interface AppConfig {
  hpcUser: string;
  defaultHpc: string;
  defaultIde: string;
  defaultCpus: string;
  defaultMem: string;
  defaultTime: string;
  additionalPorts: number[];
  sessionIdleTimeout: number;
  adminEmail: string | null;
  jwtSecret: string | undefined;
  sessionExpiryDays: number;
}

interface VsCodeKeybinding {
  key: string;
  command: string;
  when: string;
  args?: string | { snippet?: string; text?: string };
}

interface VsCodeDefaults {
  settings: Record<string, unknown>;
  builtinExtensionsDir: string;
  keybindings: VsCodeKeybinding[];
}

interface RStudioDefaults {
  save_workspace: string;
  load_workspace: boolean;
  restore_source_documents: boolean;
  always_save_history: boolean;
  restore_last_project: boolean;
  insert_native_pipe_operator: boolean;
  rainbow_parentheses: boolean;
  highlight_r_function_calls: boolean;
  auto_append_newline: boolean;
  strip_trailing_whitespace: boolean;
  font_size_points: number;
  browser_fixed_width_fonts: string[];
  posix_terminal_shell: string;
  terminal_initial_directory: string;
}

interface JupyterLabDefaults {
  '@jupyterlab/terminal-extension:plugin': {
    fontFamily: string;
    fontSize: number;
    lineHeight: number;
    scrollback: number;
    theme: string;
  };
  '@jupyterlab/apputils-extension:themes': {
    'code-font-family': string;
    'code-font-size': string;
  };
  '@jupyterlab/notebook-extension:tracker': {
    codeCellConfig: {
      lineNumbers: boolean;
    };
  };
}

export interface IdeConfig {
  name: string;
  icon: string;
  port: number;
  jobName: string;
  proxyPath: string;
}

export interface GpuPartitionConfig {
  partition: string;
  gres: string;
  maxTime: string;
  mem: string;
}

interface PartitionLimits {
  maxCpus: number;
  maxMemMB: number;
  maxTime: string;
}

export interface ClusterPaths {
  singularityImage: string;
  rLibsSite: string;
  pythonEnv: string;
}

export interface ReleaseConfig {
  name: string;
  ides: string[];
  paths: Record<string, ClusterPaths>;
}

export interface ClusterConfig {
  host: string;
  partition: string;
  singularityBin: string;
  singularityImage: string;
  rLibsSite: string;
  bindPaths: string;
}

// Parse additional ports from comma-separated string (e.g., "5500,3000,5173")
// Returns default [5500,3838] if env var not set, empty array if set to empty string
// Default includes Live Server (5500) and Shiny (3838)
function parseAdditionalPorts(envValue: string | undefined, defaultValue = '5500,3838'): number[] {
  // If env var is explicitly set (even to empty string), use it
  if (envValue !== undefined) {
    if (envValue === '') return [];
    return envValue
      .split(',')
      .map(p => parseInt(p.trim()))
      .filter(p => !isNaN(p) && p > 0 && p < 65536);
  }
  // Default to Live Server port
  return parseAdditionalPorts(defaultValue);
}

const config: AppConfig = {
  hpcUser: process.env.HPC_SSH_USER || 'domeally',
  defaultHpc: process.env.DEFAULT_HPC || 'gemini',
  defaultIde: process.env.DEFAULT_IDE || 'vscode',
  defaultCpus: process.env.DEFAULT_CPUS || '2',
  defaultMem: process.env.DEFAULT_MEM || '40G',
  defaultTime: process.env.DEFAULT_TIME || '12:00:00',
  // Additional ports to forward through SSH tunnel (e.g., Live Server: 5500, React: 3000)
  additionalPorts: parseAdditionalPorts(process.env.ADDITIONAL_PORTS),
  // Session idle timeout in minutes (0 = disabled). Cancels SLURM job after inactivity.
  // Activity is tracked via proxy data events (HTTP requests, WebSocket messages).
  // The trailing || 0 handles NaN from invalid non-numeric values (e.g., "abc")
  sessionIdleTimeout: parseInt(process.env.SESSION_IDLE_TIMEOUT || '0', 10) || 0,
  // Admin email for error notifications (optional)
  adminEmail: process.env.ADMIN_EMAIL || null,
  // JWT secret for session tokens (required in production)
  jwtSecret: process.env.JWT_SECRET,
  // Session token expiry in days
  sessionExpiryDays: parseInt(process.env.SESSION_EXPIRY_DAYS || '14', 10),
};

// Fail fast: JWT_SECRET is required for authentication in production
// Skip check in test mode to allow unit tests to run
if (process.env.NODE_ENV !== 'test') {
  if (!config.jwtSecret) {
    console.error('FATAL: JWT_SECRET environment variable is required for authentication.');
    console.error('Set JWT_SECRET in your environment or Dokploy UI before starting the server.');
    process.exit(1);
  }

  // Validate JWT_SECRET quality - weak secrets allow token forgery
  if (config.jwtSecret.length < 32) {
    console.error('FATAL: JWT_SECRET must be at least 32 characters for security.');
    console.error('Generate a strong secret with: openssl rand -base64 48');
    process.exit(1);
  }
}

// VS Code global defaults - written to Machine settings, user settings override
const vscodeDefaults: VsCodeDefaults = {
  // Machine settings (lowest priority - user/workspace settings override)
  settings: {
    // R + radian terminal
    'r.rterm.linux': '/usr/local/bin/radian',
    'r.bracketedPaste': true,
    'r.plot.useHttpgd': true,
    'r.session.levelOfObjectDetail': 'Detailed',
    'r.alwaysUseActiveTerminal': true,
    'r.sessionWatcher': true,
    'r.removeLeadingComments': true,
    'r.workspaceViewer.showObjectSize': true,
    'r.rmarkdown.chunkBackgroundColor': 'rgba(128, 128, 128, 0.3)',

    // Terminal with nerdfont fallback chain (user has FiraCode Nerd Font locally)
    'terminal.integrated.fontFamily': "'FiraCode Nerd Font', 'JetBrainsMono Nerd Font', 'Hack Nerd Font', 'DejaVu Sans Mono', monospace",
    'terminal.integrated.fontSize': 14,
    'terminal.integrated.suggest.enabled': true,

    // Editor
    'editor.fontFamily': "'JetBrains Mono', 'Fira Code', 'DejaVu Sans Mono', monospace",
    'editor.fontLigatures': true,
    'editor.fontSize': 14,
    'editor.bracketPairColorization.enabled': true,
    'editor.inlineSuggest.enabled': true,
    'diffEditor.ignoreTrimWhitespace': false,

    // General HPC-friendly settings
    'files.autoSave': 'afterDelay',
    'files.autoSaveDelay': 1000,
    'python.defaultInterpreterPath': '/usr/bin/python3',

    // Live Server - disable auto-browser open (use HPC menu button instead)
    // Browser would try to open localhost:5500 which doesn't work through proxy
    'liveServer.settings.NoBrowser': true,

  },

  // Pre-installed extensions baked into Singularity image (see github.com/drejom/vscode-rbioc#14)
  // Copied to user's extensions dir on first run if not present
  // Use /usr/local/share (not /opt) to avoid conflicts with Apollo's /opt bind mount
  builtinExtensionsDir: '/usr/local/share/vscode-extensions',

  // Keybindings for R development - bootstrapped to user dir on first run
  // Only written if keybindings.json doesn't exist (preserves user customizations)
  keybindings: [
    // Assignment operator <-
    {
      key: 'ctrl+shift+,',
      command: 'editor.action.insertSnippet',
      when: 'editorTextFocus',
      args: { snippet: '<-$0' },
    },
    {
      key: 'ctrl+shift+,',
      command: 'workbench.action.terminal.sendSequence',
      when: 'terminalFocus',
      args: { text: '<-' },
    },
    // Pipe operator |>
    {
      key: 'ctrl+shift+m',
      command: 'editor.action.insertSnippet',
      when: 'editorTextFocus',
      args: { snippet: '|>$0' },
    },
    {
      key: 'ctrl+shift+m',
      command: 'workbench.action.terminal.sendSequence',
      when: 'terminalFocus',
      args: { text: '|>' },
    },
    // str() of object at cursor
    {
      key: 'ctrl+shift+s',
      command: 'r.runCommandWithSelectionOrWord',
      when: 'editorTextFocus',
      args: 'str($$)',
    },
    // head() of object at cursor
    {
      key: 'ctrl+shift+h',
      command: 'r.runCommandWithSelectionOrWord',
      when: 'editorTextFocus',
      args: 'head($$)',
    },
    // glimpse() of object at cursor
    {
      key: 'ctrl+shift+g',
      command: 'r.runCommandWithSelectionOrWord',
      when: 'editorTextFocus',
      args: 'dplyr::glimpse($$)',
    },
    // setwd() to currently open file's directory
    {
      key: 'ctrl+shift+w',
      command: 'r.runCommandWithEditorPath',
      when: 'editorTextFocus',
      args: "setwd(dirname('$$'))",
    },
    // devtools::load_all()
    {
      key: 'ctrl+shift+l',
      command: 'workbench.action.terminal.sendSequence',
      when: 'editorTextFocus || terminalFocus',
      args: { text: "devtools::load_all('.')\n" },
    },
    // Trim trailing whitespace
    {
      key: 'ctrl+shift+t',
      command: 'editor.action.trimTrailingWhitespace',
      when: 'editorTextFocus',
    },
    // Toggle between terminal and editor
    {
      key: 'ctrl+`',
      command: 'workbench.action.terminal.focus',
      when: '!terminalFocus',
    },
    {
      key: 'ctrl+`',
      command: 'workbench.action.focusActiveEditorGroup',
      when: 'terminalFocus',
    },
  ],
};

// RStudio global defaults - written to rstudio-prefs.json
// Font settings: browser_fixed_width_fonts tells RStudio which local fonts to try
// User needs FiraCode Nerd Font installed locally for nerd font glyphs
const rstudioDefaults: RStudioDefaults = {
  // Workspace behavior (HPC-friendly - no large .RData files)
  save_workspace: 'never',
  load_workspace: false,
  restore_source_documents: false,
  always_save_history: true,
  restore_last_project: false,

  // Editor preferences
  insert_native_pipe_operator: true,
  rainbow_parentheses: true,
  highlight_r_function_calls: true,
  auto_append_newline: true,
  strip_trailing_whitespace: true,

  // Font settings (rendered by browser from local fonts)
  font_size_points: 14,
  browser_fixed_width_fonts: [
    'FiraCode Nerd Font',
    'JetBrainsMono Nerd Font',
    'Hack Nerd Font',
    'Fira Code',
    'Source Code Pro',
    'Consolas',
    'Monaco',
    'monospace',
  ],

  // Terminal
  posix_terminal_shell: 'bash',
  terminal_initial_directory: 'home',
};

// JupyterLab global defaults - written to overrides.json
// Settings in $JUPYTER_DATA_DIR/lab/settings/overrides.json
// Font settings rendered by browser from local fonts (user needs Nerd Font installed)
const jupyterlabDefaults: JupyterLabDefaults = {
  // Terminal settings - Nerd Font fallback chain for starship/powerline icons
  '@jupyterlab/terminal-extension:plugin': {
    fontFamily: "'FiraCode Nerd Font', 'JetBrainsMono Nerd Font', 'Hack Nerd Font', 'Fira Code', monospace",
    fontSize: 14,
    lineHeight: 1.2,
    scrollback: 10000,
    theme: 'inherit',
  },
  // Code editor font via CSS variables
  '@jupyterlab/apputils-extension:themes': {
    'code-font-family': "'JetBrains Mono', 'Fira Code', 'DejaVu Sans Mono', monospace",
    'code-font-size': '14px',
  },
  // Notebook settings
  '@jupyterlab/notebook-extension:tracker': {
    codeCellConfig: {
      lineNumbers: true,
    },
  },
};

// IDE definitions
// Icons from devicon.dev
const ides: Record<string, IdeConfig> = {
  vscode: {
    name: 'VS Code',
    icon: 'devicon-vscode-plain',
    port: 8000,
    jobName: 'hpc-vscode',
    proxyPath: '/code/',
  },
  rstudio: {
    name: 'RStudio',
    icon: 'devicon-rstudio-plain',
    port: 8787,
    jobName: 'hpc-rstudio',
    proxyPath: '/rstudio/',
  },
  jupyter: {
    name: 'JupyterLab',
    icon: 'devicon-jupyter-plain',
    port: 8888,
    jobName: 'hpc-jupyter',
    proxyPath: '/jupyter/',
  },
};

// GPU partitions (Gemini only - A100 and V100 available)
// Apollo has no GPU support
const gpuConfig: Record<string, Record<string, GpuPartitionConfig> | null> = {
  gemini: {
    a100: { partition: 'gpu-a100', gres: 'gpu:A100:1', maxTime: '4-00:00:00', mem: '256G' },
    v100: { partition: 'gpu-v100', gres: 'gpu:V100:1', maxTime: '8-00:00:00', mem: '96G' },
  },
  apollo: null,
};

// Partition resource limits (from scontrol show partition)
// Used for input validation - prevents submitting jobs that exceed queue limits
// Memory in MB (MaxMemPerNode), time in SLURM format, UNLIMITED = no limit
const partitionLimits: Record<string, Record<string, PartitionLimits>> = {
  gemini: {
    compute: {
      maxCpus: 44,            // MaxCPUsPerNode=44
      maxMemMB: 640000,       // MaxMemPerNode=640000 (~625G)
      maxTime: '14-00:00:00', // MaxTime=14-00:00:00
    },
    'gpu-a100': {
      maxCpus: 34,            // MaxCPUsPerNode=34
      maxMemMB: 384000,       // MaxMemPerNode=384000 (~375G)
      maxTime: '4-00:00:00',  // MaxTime=4-00:00:00
    },
    'gpu-v100': {
      maxCpus: 128,           // MaxCPUsPerNode=UNLIMITED (use reasonable default)
      maxMemMB: 96000,        // ~96G (node has 96G)
      maxTime: '8-00:00:00',  // MaxTime=8-00:00:00
    },
  },
  apollo: {
    // Apollo uses "fast,all" - SLURM picks first available
    // fast: MaxTime=12:00:00, all: MaxTime=14-00:00:00
    // Use the more permissive 'all' limits since jobs may land there
    'fast,all': {
      maxCpus: 128,           // MaxCPUsPerNode=UNLIMITED
      maxMemMB: 512000,       // MaxMemPerNode=UNLIMITED (~500G reasonable limit)
      maxTime: '14-00:00:00', // MaxTime=14-00:00:00 (all partition)
    },
  },
};

// Bioconductor release configurations
// Each release specifies which IDEs are available and paths per cluster

// Cluster base paths for Singularity images and libraries
const clusterBasePaths: Record<string, string> = {
  gemini: '/packages/singularity/shared_cache/rbioc',
  apollo: '/opt/singularity-images/rbioc',
};

// Helper to generate paths for a given release version and clusters
// Usage: createReleasePaths('3.22') for all clusters
//        createReleasePaths('3.18', ['apollo']) for Apollo-only
function createReleasePaths(version: string, supportedClusters: string[] = ['gemini', 'apollo']): Record<string, ClusterPaths> {
  const paths: Record<string, ClusterPaths> = {};
  for (const cluster of supportedClusters) {
    const basePath = clusterBasePaths[cluster];
    if (basePath) {
      paths[cluster] = {
        singularityImage: `${basePath}/vscode-rbioc_${version}.sif`,
        rLibsSite: `${basePath}/rlibs/bioc-${version}`,
        pythonEnv: `${basePath}/python/bioc-${version}`,
      };
    }
  }
  return paths;
}

const releases: Record<string, ReleaseConfig> = {
  '3.22': {
    name: 'Bioconductor 3.22',
    ides: ['vscode', 'rstudio', 'jupyter'],
    paths: createReleasePaths('3.22'),
  },
  '3.19': {
    name: 'Bioconductor 3.19',
    ides: ['vscode', 'rstudio'],
    paths: createReleasePaths('3.19'),
  },
  '3.18': {
    name: 'Bioconductor 3.18',
    ides: ['vscode', 'rstudio'],
    paths: createReleasePaths('3.18'),
  },
  '3.17': {
    name: 'Bioconductor 3.17',
    ides: ['rstudio'],  // VS Code not supported in 3.17
    paths: createReleasePaths('3.17'),
  },
};

const defaultReleaseVersion = '3.22';

// Cluster configurations (non-release-specific settings)
// Note: singularityImage and rLibsSite use default release for backward compat
// New code should use getReleasePaths() for release-specific paths
const clusters: Record<string, ClusterConfig> = {
  gemini: {
    host: process.env.GEMINI_SSH_HOST || 'gemini-login2.coh.org',
    partition: 'compute',
    singularityBin: '/packages/easy-build/software/singularity/3.7.0/bin/singularity',
    // Legacy paths (default release) - use getReleasePaths for release-aware code
    singularityImage: releases[defaultReleaseVersion].paths.gemini.singularityImage,
    rLibsSite: releases[defaultReleaseVersion].paths.gemini.rLibsSite,
    // RStudio bind paths created in user space (see hpc.js buildRstudioWrap)
    bindPaths: '/packages,/scratch,/ref_genomes',
  },
  apollo: {
    host: process.env.APOLLO_SSH_HOST || 'ppxhpcacc01.coh.org',
    partition: 'fast,all',
    singularityBin: '/opt/singularity/3.7.0/bin/singularity',
    // Legacy paths (default release) - use getReleasePaths for release-aware code
    singularityImage: releases[defaultReleaseVersion].paths.apollo.singularityImage,
    rLibsSite: releases[defaultReleaseVersion].paths.apollo.rLibsSite,
    // RStudio bind paths created in user space (see hpc.js buildRstudioWrap)
    bindPaths: '/opt,/labs',
  },
};

// Helper to get release-specific paths for a cluster
function getReleasePaths(clusterName: string, releaseVersion: string = defaultReleaseVersion): ClusterPaths {
  const releaseConfig = releases[releaseVersion];
  if (!releaseConfig) {
    throw new Error(`Unknown release: ${releaseVersion}`);
  }
  const paths = releaseConfig.paths[clusterName];
  if (!paths) {
    throw new Error(`Release ${releaseVersion} is not available on cluster ${clusterName}`);
  }
  return paths;
}

// Legacy pythonEnv export (deprecated - use getReleasePaths instead)
// Kept for backward compatibility with existing hpc.js code
const pythonEnv: Record<string, string> = {
  gemini: releases[defaultReleaseVersion].paths.gemini.pythonEnv,
  apollo: releases[defaultReleaseVersion].paths.apollo.pythonEnv,
};

export {
  config,
  clusters,
  ides,
  gpuConfig,
  partitionLimits,
  releases,
  defaultReleaseVersion,
  getReleasePaths,
  pythonEnv,  // Deprecated - use getReleasePaths
  vscodeDefaults,
  rstudioDefaults,
  jupyterlabDefaults,
};

// Also export types that other modules need
export type { AppConfig, PartitionLimits };
