/**
 * Help Routes
 * Serves markdown help content from /content/help/
 * Supports dynamic template syntax for embedding live data
 */

const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const { log } = require('../lib/logger');

const HELP_CONTENT_DIR = path.join(__dirname, '../content/help');

// StateManager will be injected via setStateManager()
let stateManager = null;

// Icons loaded from icons.json in help content folder
let icons = {};

/**
 * Load icons from icons.json
 * Called once at startup
 */
async function loadIcons() {
  try {
    const iconsPath = path.join(HELP_CONTENT_DIR, 'icons.json');
    const content = await fs.readFile(iconsPath, 'utf8');
    icons = JSON.parse(content);
    log.info('Loaded help icons', { count: Object.keys(icons).length });
  } catch (err) {
    log.warn('Failed to load help icons:', err.message);
    icons = {};
  }
}

// Load icons on module load
loadIcons();

/**
 * Set the state manager for accessing cluster health data
 * @param {StateManager} sm - State manager instance
 */
function setStateManager(sm) {
  stateManager = sm;
}

/**
 * Get value from nested object using dot notation path
 * @param {Object} obj - Object to traverse
 * @param {string} path - Dot notation path (e.g., 'gemini.cpus.percent')
 * @returns {*} Value at path or undefined
 */
function getNestedValue(obj, path) {
  return path.split('.').reduce((curr, key) => curr?.[key], obj);
}

/**
 * Process template expressions in content
 * Supports:
 * - Simple paths: {{gemini.cpus.percent}}
 * - Ternary expressions: {{gemini.online ? "🟢 Online" : "🔴 Offline"}}
 * - Icons: {{icon:rocket}} or {{icon:rocket:24}}
 *
 * @param {string} content - Markdown content with template expressions
 * @param {Object} data - Data context for substitutions
 * @returns {string} Processed content
 */
function processTemplates(content, data) {
  if (!content) return content;

  // Match {{...}} expressions
  return content.replace(/\{\{(.+?)\}\}/g, (match, expr) => {
    const trimmed = expr.trim();

    // Check for icon syntax: {{icon:name}} or {{icon:name:size}}
    const iconMatch = trimmed.match(/^icon:(\w+)(?::(\d+))?$/);
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
 * @returns {Object} Data context with paths like gemini.cpus.percent
 */
function buildTemplateContext() {
  if (!stateManager) return {};

  const clusterHealth = stateManager.getClusterHealth();
  const context = {};

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
 * @returns {Promise<Object>} Parsed index.json
 */
async function loadHelpIndex() {
  const indexPath = path.join(HELP_CONTENT_DIR, 'index.json');
  const content = await fs.readFile(indexPath, 'utf8');
  return JSON.parse(content);
}

/**
 * Load a markdown help section
 * @param {string} sectionId - Section ID (e.g., 'quick-start')
 * @returns {Promise<string>} Markdown content
 */
async function loadHelpSection(sectionId) {
  // Sanitize section ID to prevent path traversal
  const sanitized = sectionId.replace(/[^a-z0-9-]/gi, '');
  const filePath = path.join(HELP_CONTENT_DIR, `${sanitized}.md`);
  return fs.readFile(filePath, 'utf8');
}

/**
 * Search help content for a query string
 * @param {string} query - Search query
 * @returns {Promise<Array>} Array of matches with section, title, and snippet
 */
async function searchHelpContent(query) {
  const index = await loadHelpIndex();
  const results = [];
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
      log.warn(`Failed to search section ${section.id}:`, err.message);
    }
  }

  return results;
}

/**
 * GET /api/help
 * Returns the help index (sections list)
 */
router.get('/', async (req, res) => {
  try {
    const index = await loadHelpIndex();
    res.json(index);
  } catch (err) {
    log.error('Failed to load help index:', err);
    res.status(500).json({ error: 'Failed to load help index' });
  }
});

/**
 * GET /api/help/search
 * Search across all help content
 * Query param: q (search query)
 */
router.get('/search', async (req, res) => {
  const { q } = req.query;

  if (!q || q.length < 2) {
    return res.status(400).json({ error: 'Search query must be at least 2 characters' });
  }

  try {
    const results = await searchHelpContent(q);
    res.json({ query: q, results });
  } catch (err) {
    log.error('Help search failed:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

/**
 * GET /api/help/:section
 * Returns markdown content for a specific help section
 * Processes template expressions ({{...}}) with live cluster data
 */
router.get('/:section', async (req, res) => {
  const { section } = req.params;

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
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: `Help section '${section}' not found` });
    }
    log.error(`Failed to load help section ${section}:`, err);
    res.status(500).json({ error: 'Failed to load help section' });
  }
});

module.exports = router;
module.exports.setStateManager = setStateManager;
