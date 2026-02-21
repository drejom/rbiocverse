---

## 2026-02-19 21:37: Create ports.ts port allocation module (ISSUE-104)

**Author**: Ralph (azure-claude-sonnet-4-6)
**Progress**: 0/16 stories complete

### What was done
- Created `manager/lib/ports.ts` with `allocateLocalPort()` (binds TCP server to port 0, reads OS-assigned port, closes server) and `PortRegistry` Map (sessionKey→localPort)
- Created `manager/test/unit/ports.test.js` with 7 unit tests covering port validity, bindability, uniqueness, and PortRegistry CRUD
- All 467 existing tests continue to pass; `tsc --noEmit` reports no errors

### Checklist updated
- ISSUE-104: `[x] Create \`manager/lib/ports.ts\` with \`allocateLocalPort()\` and \`PortRegistry\` Map`
