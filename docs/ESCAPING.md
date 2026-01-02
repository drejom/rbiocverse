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
