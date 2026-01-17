# RStudio

RStudio Server settings optimized for HPC clusters.

## Keyboard Shortcuts

RStudio's standard shortcuts work, including:

| Shortcut | Action |
|----------|--------|
| `Ctrl+Enter` | Run selection/line |
| `Ctrl+Shift+M` | Insert `\|>` (native pipe) |
| `Alt+-` | Insert `<-` (assignment) |
| `Ctrl+Shift+K` | Knit document |
| `Ctrl+Shift+S` | Source file |
| `Ctrl+1` | Move to Source pane |
| `Ctrl+2` | Move to Console pane |

## Default Settings

Applied automatically on launch:

| Setting | Value | Purpose |
|---------|-------|---------|
| Save workspace | never | Don't save .RData (HPC-friendly) |
| Load workspace | false | Clean session each time |
| Restore source docs | false | Fresh start |
| Native pipe | enabled | Use `\|>` not `%>%` |
| Rainbow parentheses | enabled | Bracket matching |
| Strip trailing whitespace | true | Clean files |
| Auto-append newline | true | POSIX compliance |

## Why No .RData?

The defaults disable .RData saving/loading because:

1. **Reproducibility** - Sessions should be reproducible from source code
2. **Memory** - Large .RData files slow startup on HPC
3. **Portability** - Code should work without hidden state
4. **Best practice** - Matches R community recommendations

To save objects between sessions, use explicit serialization:

```r
saveRDS(my_data, "my_data.rds")
my_data <- readRDS("my_data.rds")
```

## Shiny Development

RStudio's Shiny support works out of the box. Launch Shiny apps normally and they'll open in the RStudio viewer.

For external access to Shiny apps, use the `/shiny/` proxy route after launching your app on port 3838.

## Terminal

Uses bash with colors enabled. Your cluster modules and environment are available.

## Customization

Override any setting via Tools → Global Options.

Settings are stored in `~/.rstudio-hpc/` and persist between sessions.
