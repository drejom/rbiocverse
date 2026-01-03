# Shell Escaping for RStudio rsession.sh

## Goal
Generate `rsession.sh` on HPC with content:
```bash
#!/bin/sh
exec /usr/lib/rstudio-server/bin/rsession "$@"
```

## Tests (2026-01-01)

### Test 1: printf %b with single quotes does NOT interpret \012
```bash
ssh gemini-login1.coh.org "printf '%b' 'line1\012line2' > /tmp/t1.txt && cat /tmp/t1.txt"
```
**Result:** `line1\012line2` (literal, no newline)

### Test 2: printf %b with double quotes DOES interpret \012
```bash
ssh gemini-login1.coh.org 'printf "%b" "line1\012line2" > /tmp/t2.txt && cat /tmp/t2.txt'
```
**Result:** WORKS - newlines interpreted
```
line1
line2
```

### Test 3: echo -e approach
```bash
ssh gemini-login1.coh.org "echo -e 'line1\nline2' > /tmp/t3.txt && cat /tmp/t3.txt"
```
**Result:** (need to test)

### Test 5: printf double quotes with $@ - THE SOLUTION
```bash
ssh gemini-login1.coh.org 'printf "%b" "#!/bin/sh\012exec rsession \"\$@\"\012" > /tmp/t5.txt && cat /tmp/t5.txt'
```
**Result:** WORKS!
```
#!/bin/sh
exec rsession "$@"
```

### Test 6: Through double-quoted SSH (what hpc.js uses) - FAILED
```bash
ssh gemini-login1.coh.org "printf \"%b\" \"#!/bin/sh\012exec rsession \\\"\\\$@\\\"\012\" > /tmp/t6.txt"
```
**Result:** FAILS - nested quotes break the command

### Test 7: Base64 encoding - THE SOLUTION
```javascript
const script = `#!/bin/sh
exec /usr/lib/rstudio-server/bin/rsession "$@"
`;
const b64 = Buffer.from(script).toString('base64');
const cmd = `echo '${b64}' | base64 -d > /tmp/rsession.sh`;
```
**Result:** WORKS! Base64 has no special characters, no escaping needed.

Tested with `/tmp/test-rsession-escaping.js`:
```
✅ SUCCESS: "$@" is present!
```

## Solution

Use **base64 encoding** to avoid ALL escaping issues:
1. Build script content as plain JS string (no escaping needed)
2. Base64 encode it
3. Decode on remote with `base64 -d`

No nested quotes, no backslash chains, no shell expansion problems.

---

## Important: Shell Variables in Template Literals (2026-01-02)

### Problem
When using JS template literals with base64 encoding, `\$` in the source produces `\$` in the output - the backslash is preserved!

```javascript
// WRONG - produces literal \$HOME in output
const script = `LOG=\\$HOME/test`;  // JS string: "LOG=\$HOME/test"
// Base64 decode: "LOG=\$HOME/test" (backslash preserved!)
```

### Solution
Use a variable to inject the `$` character:

```javascript
// CORRECT - produces $HOME in output
const dollar = '$';
const script = `LOG=${dollar}HOME/test`;  // JS string: "LOG=$HOME/test"
// Base64 decode: "LOG=$HOME/test" (clean!)
```

### Why This Works
- Template literals interpret `${...}` as substitution
- `${dollar}` substitutes the literal `$` character
- Base64 encoding preserves it exactly
- Result: clean shell script with proper `$` variables

### Also: Use $HOME not ~
Inside singularity containers, `~` may not expand correctly. Use `$HOME` which is an environment variable that resolves reliably.

---

## Two Escaping Contexts (2026-01-02)

There are TWO different escaping contexts in hpc.js. Using the wrong pattern causes failures!

### Context 1: INLINE Commands (setup array, singularity args)

These go through: `ssh host "sbatch --wrap='...'"`

The SSH double-quotes consume one level of backslash escaping:
- JS `'\\$HOME'` → string `\$HOME` → SSH sends `$HOME` → compute node expands ✓
- JS `'\\$(whoami)'` → string `\$(whoami)` → SSH sends `$(whoami)` → compute node expands ✓

**Pattern:** Use `'\\$'` or `` `\\$` `` (both work identically)

```javascript
// INLINE context - use \\$ escaping
const workdir = '\\$HOME/.rstudio-slurm/workdir';
const serverUser = `--server-user=\\$(whoami)`;
```

Tested 2026-01-02:
```bash
ssh gemini "sbatch --wrap='echo USER=\$(whoami) > \$HOME/test.txt' ..."
# Result: USER=domeally ✓
```

### Context 2: BASE64-Encoded Scripts (rsessionScript, config files)

These are base64-encoded in JS, decoded on compute node:
- JS `${dollar}HOME` → string `$HOME` → base64 preserves → decode gives `$HOME` ✓

**Pattern:** Use `const dollar = '$';` then `${dollar}HOME`

```javascript
// BASE64 context - use ${dollar} pattern
const dollar = '$';
const rsessionScript = `#!/bin/sh
export R_LIBS_USER=${dollar}HOME/R/bioc-3.19
exec /usr/lib/rstudio-server/bin/rsession "${dollar}@"
`;
const rsessionBase64 = Buffer.from(rsessionScript).toString('base64');
```

### WARNING: Don't Mix Them Up!

| Context | Wrong | Right |
|---------|-------|-------|
| INLINE | `${dollar}HOME` (expands locally!) | `'\\$HOME'` |
| BASE64 | `'\\$HOME'` (backslash preserved!) | `${dollar}HOME` |

### Quick Reference

| Context | JS Pattern | String Value | After SSH/Decode |
|---------|-----------|--------------|------------------|
| INLINE | `'\\$HOME'` | `\$HOME` | `$HOME` |
| BASE64 | `${dollar}HOME` | `$HOME` | `$HOME` |
