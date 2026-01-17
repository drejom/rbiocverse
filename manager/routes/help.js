/**
 * Help Routes
 * Serves markdown help content from /content/help/
 */

const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const { log } = require('../lib/logger');

const HELP_CONTENT_DIR = path.join(__dirname, '../content/help');

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

    const content = await loadHelpSection(section);
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
