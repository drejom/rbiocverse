# IDE Customizations

Global settings for VS Code and RStudio, applied automatically on session start.

## Browser Keyboard Shortcut Limitations

When running in a browser, some keyboard shortcuts are captured by the browser before reaching the IDE. This is a fundamental browser security limitation.

**Affected shortcuts:**

| Shortcut | Browser captures | IDE wants |
|----------|-----------------|-----------|
| `Ctrl+N` | New window | New file |
| `Ctrl+W` | Close tab | Close editor |
| `Ctrl+T` | New tab | Go to symbol |
| `Ctrl+Shift+N` | Incognito window | - |
| `Ctrl+Shift+T` | Reopen tab | - |

**Solutions (in order of effectiveness):**

1. **Install as PWA** - Click the install icon in Chrome's address bar. PWA mode gives the IDE more keyboard access.
2. **Use Command Palette** - `Ctrl+Shift+P` (or `F1`) works everywhere. Type any action.
3. **Use alternative bindings** - VS Code has alternatives like `Ctrl+K Ctrl+W` for close editor.
4. **Remap in VS Code** - Open Keyboard Shortcuts (`Ctrl+K Ctrl+S`) and remap conflicting shortcuts.

---

## VS Code

### Machine Settings

Written to `$HOME/.vscode-slurm/.vscode-server/data/Machine/settings.json` on every launch. User/workspace settings override these.

| Setting | Value | Purpose |
|---------|-------|---------|
| `r.rterm.linux` | `/usr/local/bin/radian` | Use radian as R terminal |
| `r.bracketedPaste` | `true` | Proper paste in radian |
| `r.plot.useHttpgd` | `true` | Interactive plots via httpgd |
| `r.session.levelOfObjectDetail` | `Detailed` | Show object details in workspace |
| `r.alwaysUseActiveTerminal` | `true` | Avoid spawning new terminals |
| `r.sessionWatcher` | `true` | Enable workspace viewer & debugging |
| `r.removeLeadingComments` | `true` | Clean code execution |
| `r.workspaceViewer.showObjectSize` | `true` | Memory awareness on HPC |
| `r.rmarkdown.chunkBackgroundColor` | `rgba(128,128,128,0.3)` | Visual aid for R Markdown |
| `terminal.integrated.fontFamily` | JetBrainsMono Nerd Font chain | Nerdfont with fallbacks |
| `terminal.integrated.fontSize` | `14` | Readable terminal |
| `terminal.integrated.suggest.enabled` | `true` | Terminal suggestions |
| `editor.fontFamily` | JetBrains Mono chain | Editor font with fallbacks |
| `editor.fontLigatures` | `true` | Enable font ligatures |
| `editor.fontSize` | `14` | Readable editor |
| `editor.bracketPairColorization.enabled` | `true` | Rainbow brackets |
| `editor.inlineSuggest.enabled` | `true` | Copilot support |
| `diffEditor.ignoreTrimWhitespace` | `false` | Better diffs |
| `files.autoSave` | `afterDelay` | Auto-save files |
| `files.autoSaveDelay` | `1000` | 1 second delay |
| `python.defaultInterpreterPath` | `/usr/local/bin/python3` | Container Python |

### Keybindings

Written to `$HOME/.vscode-slurm/user-data/User/keybindings.json` on **first run only** (preserves user customizations).

| Shortcut | Action | Context |
|----------|--------|---------|
| `Ctrl+Shift+,` | Insert `<-` (assignment) | Editor & Terminal |
| `Ctrl+Shift+M` | Insert `\|>` (pipe) | Editor & Terminal |
| `Ctrl+Shift+S` | `str()` at cursor | Editor |
| `Ctrl+Shift+H` | `head()` at cursor | Editor |
| `Ctrl+Shift+G` | `dplyr::glimpse()` at cursor | Editor |
| `Ctrl+Shift+W` | `setwd()` to file's directory | Editor |
| `Ctrl+Shift+L` | `devtools::load_all()` | Editor & Terminal |
| `Ctrl+Shift+T` | Trim trailing whitespace | Editor |
| `Ctrl+\`` | Toggle terminal/editor focus | Global |

### Environment Variables

Set via Singularity `--env`:

| Variable | Value | Purpose |
|----------|-------|---------|
| `TERM` | `xterm-256color` | Color terminal support |
| `R_LIBS_SITE` | Cluster-specific path | Shared R library location |

### Extension Bootstrap

Future: Pre-installed extensions from `/usr/local/share/vscode-extensions` in container image are copied to user's extensions dir on first run. See [vscode-rbioc#14](https://github.com/drejom/vscode-rbioc/issues/14).

---

## RStudio

### Preferences

Written to `$HOME/.rstudio-hpc/rstudio-prefs.json` on every launch.

| Setting | Value | Purpose |
|---------|-------|---------|
| `save_workspace` | `never` | Don't save .RData (HPC-friendly) |
| `load_workspace` | `false` | Don't load .RData on start |
| `restore_source_documents` | `false` | Fresh session each time |
| `always_save_history` | `true` | Keep command history |
| `restore_last_project` | `false` | Don't restore projects |
| `insert_native_pipe_operator` | `true` | Use `\|>` not `%>%` |
| `rainbow_parentheses` | `true` | Colorful bracket matching |
| `highlight_r_function_calls` | `true` | Syntax highlighting |
| `auto_append_newline` | `true` | Newline at end of files |
| `strip_trailing_whitespace` | `true` | Clean files on save |
| `terminal_shell` | `bash` | Use bash in terminal |
| `terminal_initial_directory` | `home` | Start in home dir |

### Environment Variables

Set via Singularity `--env`:

| Variable | Value | Purpose |
|----------|-------|---------|
| `TERM` | `xterm-256color` | Color terminal support |
| `R_LIBS_SITE` | Cluster-specific path | Shared R library location |

---

## Configuration Source

All settings defined in `manager/config/index.js`:

- `vscodeDefaults.settings` - VS Code Machine settings
- `vscodeDefaults.keybindings` - VS Code keybindings
- `rstudioDefaults` - RStudio preferences

## Customization

Users can override any setting:

- **VS Code**: Edit settings via `Ctrl+,` or workspace `.vscode/settings.json`
- **RStudio**: Tools → Global Options

Machine settings have lowest priority - user preferences always win.
