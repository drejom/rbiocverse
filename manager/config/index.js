/**
 * Configuration management
 * Centralizes all environment variables and cluster-specific settings
 */

// Parse additional ports from comma-separated string (e.g., "5500,3000,5173")
// Returns default [5500] if env var not set, empty array if set to empty string
function parseAdditionalPorts(envValue, defaultValue = '5500') {
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

const config = {
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
};

// VS Code global defaults - written to Machine settings, user settings override
const vscodeDefaults = {
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
    'python.defaultInterpreterPath': '/usr/local/bin/python3',

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
const rstudioDefaults = {
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

// IDE definitions
// Icons from devicon.dev
const ides = {
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
const gpuConfig = {
  gemini: {
    a100: { partition: 'gpu-a100', gres: 'gpu:A100:1', maxTime: '4-00:00:00', mem: '256G' },
    v100: { partition: 'gpu-v100', gres: 'gpu:V100:1', maxTime: '8-00:00:00', mem: '96G' },
  },
  apollo: null,
};

// Shared Python environment (mirrors R_LIBS_SITE pattern)
const pythonEnv = {
  gemini: '/packages/singularity/shared_cache/rbioc/python/bioc-3.19',
  apollo: '/opt/singularity-images/rbioc/python/bioc-3.19',
};

const clusters = {
  gemini: {
    host: process.env.GEMINI_SSH_HOST || 'gemini-login2.coh.org',
    partition: 'compute',
    singularityBin: '/packages/easy-build/software/singularity/3.7.0/bin/singularity',
    singularityImage: '/packages/singularity/shared_cache/rbioc/vscode-rbioc_3.19.sif',
    rLibsSite: '/packages/singularity/shared_cache/rbioc/rlibs/bioc-3.19',
    // RStudio bind paths created in user space (see hpc.js buildRstudioWrap)
    bindPaths: '/packages,/scratch,/ref_genomes',
  },
  apollo: {
    host: process.env.APOLLO_SSH_HOST || 'ppxhpcacc01.coh.org',
    partition: 'fast,all',
    singularityBin: '/opt/singularity/3.7.0/bin/singularity',
    singularityImage: '/opt/singularity-images/rbioc/vscode-rbioc_3.19.sif',
    rLibsSite: '/opt/singularity-images/rbioc/rlibs/bioc-3.19',
    // RStudio bind paths created in user space (see hpc.js buildRstudioWrap)
    bindPaths: '/opt,/labs',
  },
};

module.exports = { config, clusters, ides, gpuConfig, pythonEnv, vscodeDefaults, rstudioDefaults };
