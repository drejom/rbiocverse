/**
 * Help Routes
 * Serves markdown help content from /content/help/
 * Supports dynamic template syntax for embedding live data
 */

import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { log } from '../lib/logger';
import { errorDetails } from '../lib/errors';
import type { ClusterHealthState } from '../lib/state/types';

const fsPromises = fs.promises;
const router = express.Router();

// Helper to safely get string from req.params (Express types it as string | string[] but it's always string for route params)
const param = (req: Request, name: string): string => req.params[name] as string;

const HELP_CONTENT_DIR = path.join(__dirname, '../content/help');
const CONTENT_DIR = path.join(__dirname, '../content');

// StateManager type (simplified for this module)
interface StateManager {
  getClusterHealth(): Record<string, ClusterHealthState>;
}

// StateManager will be injected via setStateManager()
let stateManager: StateManager | null = null;

// Icons loaded from shared icons.json
let icons: Record<string, string> = {};

interface HelpSection {
  id: string;
  title: string;
  icon?: string;
}

interface HelpIndex {
  sections: HelpSection[];
}

interface SearchResult {
  sectionId: string;
  sectionTitle: string;
  snippet: string;
  matchIndex: number;
}

/**
 * Load icons from shared icons.json
 * Called once at startup
 */
async function loadIcons(): Promise<void> {
  try {
    const iconsPath = path.join(CONTENT_DIR, 'icons.json');
    const content = await fsPromises.readFile(iconsPath, 'utf8');
    icons = JSON.parse(content);
    log.info('Loaded help icons', { count: Object.keys(icons).length });
  } catch (err) {
    log.warn('Failed to load help icons:', errorDetails(err));
    icons = {};
  }
}

// Load icons on module load
loadIcons();

/**
 * Set the state manager for accessing cluster health data
 * @param sm - State manager instance
 */
function setStateManager(sm: StateManager): void {
  stateManager = sm;
}

/**
 * Get value from nested object using dot notation path
 * @param obj - Object to traverse
 * @param dotPath - Dot notation path (e.g., 'gemini.cpus.percent')
 * @returns Value at path or undefined
 */
function getNestedValue(obj: Record<string, unknown>, dotPath: string): unknown {
  return dotPath.split('.').reduce((curr: unknown, key: string) => {
    if (curr && typeof curr === 'object' && key in curr) {
      return (curr as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

/**
 * Process template expressions in content
 * Supports:
 * - Simple paths: {{gemini.cpus.percent}}
 * - Ternary expressions: {{gemini.online ? "🟢 Online" : "🔴 Offline"}}
 * - Icons: {{icon:rocket}} or {{icon:rocket:24}}
 *
 * @param content - Markdown content with template expressions
 * @param data - Data context for substitutions
 * @returns Processed content
 */
function processTemplates(content: string, data: Record<string, unknown>): string {
  if (!content) return content;

  // Match {{...}} expressions
  return content.replace(/\{\{(.+?)\}\}/g, (match, expr) => {
    const trimmed = (expr as string).trim();

    // Check for icon syntax: {{icon:name}} or {{icon:name:size}}
    // Allow hyphens in icon names (e.g., help-circle, check-circle)
    const iconMatch = trimmed.match(/^icon:([\w-]+)(?::(\d+))?$/);
    if (iconMatch) {
      const [, iconName, sizeStr] = iconMatch;
      const size = sizeStr || '20';
      const svg = icons[iconName];
      if (svg) {
        return svg.replace(/SIZE/g, size);
      }
      return `[icon:${iconName}]`; // Fallback for unknown icons
    }

    // Check for ternary expression: condition ? "trueVal" : "falseVal"
    const ternaryMatch = trimmed.match(/^(.+?)\s*\?\s*["'](.+?)["']\s*:\s*["'](.+?)["']$/);
    if (ternaryMatch) {
      const [, condition, trueVal, falseVal] = ternaryMatch;
      const conditionValue = getNestedValue(data, condition.trim());
      return conditionValue ? trueVal : falseVal;
    }

    // Simple path substitution
    if (!data) return match;
    const value = getNestedValue(data, trimmed);
    if (value === undefined || value === null) {
      return '-'; // Graceful fallback for missing data
    }
    return String(value);
  });
}

/**
 * Build data context for template processing
 * Flattens cluster health data into a template-friendly format
 * @returns Data context with paths like gemini.cpus.percent
 */
function buildTemplateContext(): Record<string, unknown> {
  if (!stateManager) return {};

  const clusterHealth = stateManager.getClusterHealth();
  const context: Record<string, unknown> = {};

  for (const [cluster, health] of Object.entries(clusterHealth)) {
    if (!health?.current) continue;

    const current = health.current;
    context[cluster] = {
      online: current.online ?? false,
      cpus: current.cpus || {},
      memory: current.memory || {},
      nodes: current.nodes || {},
      gpus: current.gpus || {},
      runningJobs: current.runningJobs ?? 0,
      pendingJobs: current.pendingJobs ?? 0,
    };
  }

  return context;
}

/**
 * Load the help index manifest
 * @returns Parsed index.json
 */
async function loadHelpIndex(): Promise<HelpIndex> {
  const indexPath = path.join(HELP_CONTENT_DIR, 'index.json');
  const content = await fsPromises.readFile(indexPath, 'utf8');
  return JSON.parse(content);
}

/**
 * Load a markdown help section
 * @param sectionId - Section ID (e.g., 'quick-start')
 * @returns Markdown content
 */
async function loadHelpSection(sectionId: string): Promise<string> {
  // Sanitize section ID to prevent path traversal
  const sanitized = sectionId.replace(/[^a-z0-9-]/gi, '');
  const filePath = path.join(HELP_CONTENT_DIR, `${sanitized}.md`);
  return fsPromises.readFile(filePath, 'utf8');
}

/**
 * Search help content for a query string
 * @param query - Search query
 * @returns Array of matches with section, title, and snippet
 */
async function searchHelpContent(query: string): Promise<SearchResult[]> {
  const index = await loadHelpIndex();
  const results: SearchResult[] = [];
  const queryLower = query.toLowerCase();

  for (const section of index.sections) {
    try {
      const content = await loadHelpSection(section.id);
      const contentLower = content.toLowerCase();

      // Find all matches
      let searchIndex = 0;
      while (searchIndex !== -1) {
        searchIndex = contentLower.indexOf(queryLower, searchIndex);
        if (searchIndex !== -1) {
          // Extract snippet around match
          const start = Math.max(0, searchIndex - 50);
          const end = Math.min(content.length, searchIndex + query.length + 100);
          let snippet = content.slice(start, end);

          // Clean up snippet
          if (start > 0) snippet = '...' + snippet;
          if (end < content.length) snippet = snippet + '...';

          // Highlight match
          const matchStart = searchIndex - start + (start > 0 ? 3 : 0);

          results.push({
            sectionId: section.id,
            sectionTitle: section.title,
            snippet: snippet.trim(),
            matchIndex: matchStart,
          });

          searchIndex += query.length;

          // Limit matches per section
          if (results.filter(r => r.sectionId === section.id).length >= 3) {
            break;
          }
        }
      }
    } catch (err) {
      // Skip sections that can't be loaded
      log.warn(`Failed to search section ${section.id}:`, errorDetails(err));
    }
  }

  return results;
}

/**
 * GET /api/help
 * Returns the help index (sections list)
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const index = await loadHelpIndex();
    res.json(index);
  } catch (err) {
    log.error('Failed to load help index:', err instanceof Error ? { error: err.message, stack: err.stack } : { detail: String(err) });
    res.status(500).json({ error: 'Failed to load help index' });
  }
});

/**
 * GET /api/help/search
 * Search across all help content
 * Query param: q (search query)
 */
router.get('/search', async (req: Request, res: Response) => {
  const { q } = req.query;

  if (!q || (q as string).length < 2) {
    return res.status(400).json({ error: 'Search query must be at least 2 characters' });
  }

  try {
    const results = await searchHelpContent(q as string);
    res.json({ query: q, results });
  } catch (err) {
    log.error('Help search failed:', err instanceof Error ? { error: err.message, stack: err.stack } : { detail: String(err) });
    res.status(500).json({ error: 'Search failed' });
  }
});

/**
 * GET /api/help/:section
 * Returns markdown content for a specific help section
 * Processes template expressions ({{...}}) with live cluster data
 */
router.get('/:section', async (req: Request, res: Response) => {
  const section = param(req, 'section');

  try {
    // Verify section exists in index
    const index = await loadHelpIndex();
    const sectionInfo = index.sections.find(s => s.id === section);

    if (!sectionInfo) {
      return res.status(404).json({ error: `Help section '${section}' not found` });
    }

    let content = await loadHelpSection(section);

    // Process templates with live cluster data
    const templateContext = buildTemplateContext();
    content = processTemplates(content, templateContext);

    res.json({
      id: sectionInfo.id,
      title: sectionInfo.title,
      icon: sectionInfo.icon,
      content,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return res.status(404).json({ error: `Help section '${section}' not found` });
    }
    log.error(`Failed to load help section ${section}:`, err instanceof Error ? { error: err.message, stack: err.stack } : { detail: String(err) });
    res.status(500).json({ error: 'Failed to load help section' });
  }
});

export default router;
export { setStateManager };

// CommonJS compatibility for existing require() calls
module.exports = router;
module.exports.setStateManager = setStateManager;
