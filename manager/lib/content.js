/**
 * Content Manager - Shared content loading, caching, and search
 *
 * DRY implementation for help and admin content systems.
 * Provides caching and search functionality.
 */

const fs = require('fs').promises;
const path = require('path');
const { log } = require('./logger');

class ContentManager {
  /**
   * Create a content manager
   * @param {string} contentDir - Path to content directory
   * @param {Object} [options]
   * @param {number} [options.cacheTTL=300000] - Cache TTL in ms (default 5 min)
   * @param {boolean} [options.watchFiles=false] - Watch files for changes (dev mode)
   */
  constructor(contentDir, options = {}) {
    this.contentDir = contentDir;
    this.cacheTTL = options.cacheTTL ?? 300000; // 5 minutes default
    this.watchFiles = options.watchFiles ?? false;

    // Cache storage
    this.indexCache = null;
    this.indexCacheTime = 0;
    this.sectionCache = new Map();
    this.sectionCacheTime = new Map();

    // Icons cache (shared across content managers)
    this.icons = null;
    this.iconsPath = null;
  }

  /**
   * Set icons path for icon processing
   * @param {string} iconsPath - Path to icons.json
   */
  setIconsPath(iconsPath) {
    this.iconsPath = iconsPath;
  }

  /**
   * Load icons from JSON file
   */
  async loadIcons() {
    if (!this.iconsPath) return {};

    try {
      const content = await fs.readFile(this.iconsPath, 'utf8');
      this.icons = JSON.parse(content);
      return this.icons;
    } catch (err) {
      log.warn('Failed to load icons:', err.message);
      this.icons = {};
      return {};
    }
  }

  /**
   * Get icons (loads if not cached)
   */
  async getIcons() {
    if (this.icons === null) {
      await this.loadIcons();
    }
    return this.icons;
  }

  /**
   * Check if cache is valid
   * @param {number} cacheTime - When cache was set
   * @returns {boolean}
   */
  isCacheValid(cacheTime) {
    if (!cacheTime) return false;
    return (Date.now() - cacheTime) < this.cacheTTL;
  }

  /**
   * Load the content index
   * @returns {Promise<Object>} Parsed index.json
   */
  async loadIndex() {
    if (this.indexCache && this.isCacheValid(this.indexCacheTime)) {
      return this.indexCache;
    }

    const indexPath = path.join(this.contentDir, 'index.json');
    const content = await fs.readFile(indexPath, 'utf8');
    this.indexCache = JSON.parse(content);
    this.indexCacheTime = Date.now();

    return this.indexCache;
  }

  /**
   * Load a markdown section
   * @param {string} sectionId - Section ID
   * @returns {Promise<string>} Markdown content
   */
  async loadSection(sectionId) {
    // Sanitize to prevent path traversal
    const sanitized = sectionId.replace(/[^a-z0-9-]/gi, '');

    // Check cache
    if (this.sectionCache.has(sanitized) &&
        this.isCacheValid(this.sectionCacheTime.get(sanitized))) {
      return this.sectionCache.get(sanitized);
    }

    const filePath = path.join(this.contentDir, `${sanitized}.md`);
    const content = await fs.readFile(filePath, 'utf8');

    // Cache the content
    this.sectionCache.set(sanitized, content);
    this.sectionCacheTime.set(sanitized, Date.now());

    return content;
  }

  /**
   * Process icon expressions in content
   * Supports: {{icon:rocket}} or {{icon:rocket:24}}
   *
   * @param {string} content - Content with icon expressions
   * @returns {Promise<string>} Processed content
   */
  async processIcons(content) {
    if (!content) return content;

    const icons = await this.getIcons();

    return content.replace(/\{\{icon:([\w-]+)(?::(\d+))?\}\}/g, (match, iconName, sizeStr) => {
      const size = sizeStr || '20';
      const svg = icons[iconName];
      if (svg) {
        return svg.replace(/SIZE/g, size);
      }
      return `[icon:${iconName}]`; // Fallback for unknown icons
    });
  }

  /**
   * Search content for a query string
   * @param {string} query - Search query (min 2 chars)
   * @param {Object} [options]
   * @param {number} [options.maxMatchesPerSection=3] - Max matches per section
   * @param {number} [options.snippetRadius=50] - Characters around match
   * @returns {Promise<Array>} Search results
   */
  async search(query, options = {}) {
    const { maxMatchesPerSection = 3, snippetRadius = 50 } = options;

    if (!query || query.length < 2) {
      return [];
    }

    const index = await this.loadIndex();
    const results = [];
    const queryLower = query.toLowerCase();

    for (const section of index.sections) {
      try {
        const content = await this.loadSection(section.id);
        const contentLower = content.toLowerCase();
        let matchCount = 0;
        let searchIndex = 0;

        while (searchIndex !== -1 && matchCount < maxMatchesPerSection) {
          searchIndex = contentLower.indexOf(queryLower, searchIndex);

          if (searchIndex !== -1) {
            // Extract snippet around match
            const start = Math.max(0, searchIndex - snippetRadius);
            const end = Math.min(content.length, searchIndex + query.length + snippetRadius * 2);
            let snippet = content.slice(start, end);

            // Add ellipsis for truncation
            if (start > 0) snippet = '...' + snippet;
            if (end < content.length) snippet = snippet + '...';

            results.push({
              sectionId: section.id,
              sectionTitle: section.title,
              snippet: snippet.trim(),
              matchIndex: searchIndex - start + (start > 0 ? 3 : 0),
            });

            searchIndex += query.length;
            matchCount++;
          }
        }
      } catch (err) {
        log.warn(`Failed to search section ${section.id}:`, err.message);
      }
    }

    return results;
  }

  /**
   * Clear all caches
   * Useful for testing or when content files change
   */
  clearCache() {
    this.indexCache = null;
    this.indexCacheTime = 0;
    this.sectionCache.clear();
    this.sectionCacheTime.clear();
    this.icons = null;
  }

  /**
   * Get section info from index
   * @param {string} sectionId - Section ID
   * @returns {Promise<Object|null>} Section info or null
   */
  async getSectionInfo(sectionId) {
    const index = await this.loadIndex();
    return index.sections.find(s => s.id === sectionId) || null;
  }
}

module.exports = ContentManager;
