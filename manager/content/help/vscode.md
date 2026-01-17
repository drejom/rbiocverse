# VS Code

VS Code settings and customizations for R/Python development.

## Keyboard Shortcuts

### R Development

Pre-configured for R development:

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+,` | Insert `<-` (assignment) |
| `Ctrl+Shift+M` | Insert `\|>` (pipe) |
| `Ctrl+Shift+S` | `str()` on selection |
| `Ctrl+Shift+H` | `head()` on selection |
| `Ctrl+Shift+G` | `dplyr::glimpse()` on selection |
| `Ctrl+Shift+W` | `setwd()` to file's directory |
| `Ctrl+Shift+L` | `devtools::load_all()` |
| `Ctrl+\`` | Toggle terminal/editor focus |

### Browser Limitations

Some shortcuts are captured by the browser:

| Shortcut | Browser Action | VS Code Action |
|----------|---------------|----------------|
| `Ctrl+N` | New window | New file |
| `Ctrl+W` | Close tab | Close editor |
| `Ctrl+T` | New tab | Go to symbol |

**Solutions:**

1. **Install as PWA** (recommended) - Unlocks most shortcuts
2. **Use Command Palette** - `Ctrl+Shift+P` or `F1` works everywhere
3. **Use alternatives** - `Ctrl+K Ctrl+W` closes editor, `Ctrl+O` opens files
4. **Remap shortcuts** - `Ctrl+K Ctrl+S` opens keyboard settings

## Default Settings

Applied automatically on launch (user settings override these):

| Setting | Value | Purpose |
|---------|-------|---------|
| R terminal | radian | Enhanced R REPL |
| Auto-save | afterDelay (1s) | Prevent data loss |
| Bracket colorization | enabled | Rainbow brackets |
| Font | JetBrains Mono | Ligatures and Nerdfont icons |
| httpgd plots | enabled | Interactive R plots |
| Session watcher | enabled | Workspace viewer & debugging |

## R Extension Features

### Interactive Plots

The httpgd plot viewer is enabled by default. Plots open in VS Code's built-in viewer with zoom, pan, and export.

### Workspace Viewer

See all R objects in your environment with sizes - helpful for memory management on HPC.

### Terminal

Uses **radian** - an enhanced R terminal with:
- Syntax highlighting
- Multiline editing
- Auto-completion

## Python Setup

Default interpreter is set to `/usr/local/bin/python3` (container Python).

For virtual environments, select your interpreter via `Ctrl+Shift+P` → "Python: Select Interpreter".

## Customization

Override any setting:

- **GUI**: `Ctrl+,` opens settings
- **Workspace**: Create `.vscode/settings.json` in your project
- **User**: Settings stored in `~/.vscode-slurm/`

Machine settings (applied by rbiocverse) have lowest priority - your preferences always win.
