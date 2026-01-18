# Help System

The built-in help panel provides contextual documentation with live cluster data.

## For Users

### Opening Help

Click the **?** icon in the top-right corner or press `?` key (when not focused on an input).

### Navigation

- **Top tabs**: Quick Start, Environment, IDEs, Support
- **Sub-tabs**: Appear when expanding IDEs or Support sections
- **Search**: Type to search across all help content
- **Links**: Click internal links to navigate between sections

### Live Data

Help content includes real-time cluster information:
- Current CPU, memory, and node utilization
- Online/offline status indicators
- Live health bars matching the main launcher display

---

## For Developers

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Help Panel (React)                    │
│  ┌─────────────────────────────────────────────────────┐│
│  │ 1. Fetch /api/help/:section                         ││
│  │ 2. Server processes {{templates}} with live data    ││
│  │ 3. Server returns processed markdown                ││
│  │ 4. Frontend parses :::widget::: syntax              ││
│  │ 5. Markdown rendered, widgets mounted via portals   ││
│  └─────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

### Template Syntax (Server-side)

Templates are processed by `routes/help.js` before returning content.

**Simple values:**
```markdown
CPU Usage: {{gemini.cpus.percent}}%
Memory: {{apollo.memory.percent}}%
```

**Ternary expressions:**
```markdown
Status: {{gemini.online ? "🟢 Online" : "🔴 Offline"}}
```

**Icons:**
```markdown
# {{icon:rocket}} Quick Start
# {{icon:vscode}} VS Code
```

Icons are configured in `content/help/icons.json`. Supports Lucide SVG icons and devicons.

**Available data paths:**
```
{cluster}.online              # boolean
{cluster}.cpus.percent        # number (0-100)
{cluster}.cpus.used           # number
{cluster}.cpus.total          # number
{cluster}.memory.percent      # number
{cluster}.nodes.percent       # number
{cluster}.gpus.percent        # number (Gemini only)
{cluster}.runningJobs         # number
{cluster}.pendingJobs         # number
```

Where `{cluster}` is `gemini` or `apollo`.

### Widget Syntax (Client-side)

Widgets embed React components in help content.

**Syntax:**
```markdown
:::widget ComponentName prop="value":::
```

**Example:**
```markdown
## Live Health

:::widget ClusterHealth cluster="gemini":::
:::widget ClusterHealth cluster="apollo":::
```

### Adding New Widgets

1. Create component in `ui/src/components/help-widgets/`
2. Register in `help-widgets/index.js`:

```javascript
// help-widgets/MyWidget.jsx
export function MyWidget({ someProp }) {
  return <div>Widget content for {someProp}</div>;
}

// help-widgets/index.js
import { MyWidget } from './MyWidget';

export const widgetRegistry = {
  ClusterHealth,
  MyWidget,  // Add here
};
```

3. Use in markdown:
```markdown
:::widget MyWidget someProp="value":::
```

### Files

| File | Purpose |
|------|---------|
| `routes/help.js` | API endpoint, template processing |
| `ui/src/components/HelpPanel.jsx` | React panel, widget mounting |
| `ui/src/components/help-widgets/` | Widget components |
| `content/help/*.md` | Markdown content files |
| `content/help/index.json` | Section manifest |
| `content/help/icons.json` | Icon SVG definitions |

### Adding Help Content

1. Create `content/help/my-section.md`
2. Add to `content/help/index.json`:
```json
{
  "sections": [
    { "id": "my-section", "title": "My Section", "icon": "wrench" }
  ]
}
```
3. Update `HelpPanel.jsx` menu structure if needed

### Testing

```bash
# Unit tests for template processing
npm test -- --grep "Help Template"

# Playwright tests
cd ui && npx playwright test help-panel.spec.js
```

### API

**GET /api/help** - Returns section index
```json
{
  "sections": [
    { "id": "quick-start", "title": "Quick Start", "icon": "rocket" }
  ]
}
```

**GET /api/help/:section** - Returns processed markdown
```json
{
  "id": "quick-start",
  "title": "Quick Start",
  "icon": "rocket",
  "content": "# Quick Start\n\nCPU: 72%..."
}
```

**GET /api/help/search?q=query** - Search across content
```json
{
  "query": "launch",
  "results": [
    { "sectionId": "quick-start", "sectionTitle": "Quick Start", "snippet": "..." }
  ]
}
```
