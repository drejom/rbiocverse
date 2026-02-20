/**
 * Content Manager - Shared content loading, caching, and search
 *
 * DRY implementation for help and admin content systems.
 * Provides caching and search functionality.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { log } from './logger';
import { errorDetails } from './errors';

interface SectionInfo {
  id: string;
  title: string;
  icon?: string;
  parent?: string;
}

interface ContentIndex {
  sections: SectionInfo[];
}

interface SearchResult {
  sectionId: string;
  sectionTitle: string;
  snippet: string;
  matchIndex: number;
}

interface ContentManagerOptions {
  cacheTTL?: number;
}

interface SearchOptions {
  maxMatchesPerSection?: number;
  snippetRadius?: number;
}

class ContentManager {
  private contentDir: string;
  private cacheTTL: number;

  // Cache storage
  private indexCache: ContentIndex | null = null;
  private indexCacheTime: number = 0;
  private sectionCache: Map<string, string> = new Map();
  private sectionCacheTime: Map<string, number> = new Map();

  // Icons cache
  private icons: Record<string, string> | null = null;
  private iconsPath: string | null = null;

  /**
   * Create a content manager
   * @param contentDir - Path to content directory
   * @param options - Configuration options
   */
  constructor(contentDir: string, options: ContentManagerOptions = {}) {
    this.contentDir = contentDir;
    this.cacheTTL = options.cacheTTL ?? 300000; // 5 minutes default
  }

  /**
   * Set icons path for icon processing
   * @param iconsPath - Path to icons.json
   */
  setIconsPath(iconsPath: string): void {
    this.iconsPath = iconsPath;
  }

  /**
   * Load icons from JSON file
   */
  async loadIcons(): Promise<Record<string, string>> {
    if (!this.iconsPath) return {};

    try {
      const content = await fs.readFile(this.iconsPath, 'utf8');
      this.icons = JSON.parse(content);
      return this.icons!;
    } catch (err) {
      log.warn('Failed to load icons:', errorDetails(err));
      this.icons = {};
      return {};
    }
  }

  /**
   * Get icons (loads if not cached)
   */
  async getIcons(): Promise<Record<string, string>> {
    if (this.icons === null) {
      await this.loadIcons();
    }
    return this.icons!;
  }

  /**
   * Check if cache is valid
   * @param cacheTime - When cache was set
   */
  isCacheValid(cacheTime: number): boolean {
    if (!cacheTime) return false;
    return (Date.now() - cacheTime) < this.cacheTTL;
  }

  /**
   * Load the content index
   */
  async loadIndex(): Promise<ContentIndex> {
    if (this.indexCache && this.isCacheValid(this.indexCacheTime)) {
      return this.indexCache;
    }

    const indexPath = path.join(this.contentDir, 'index.json');
    const content = await fs.readFile(indexPath, 'utf8');
    this.indexCache = JSON.parse(content);
    this.indexCacheTime = Date.now();

    return this.indexCache!;
  }

  /**
   * Load a markdown section
   * @param sectionId - Section ID
   */
  async loadSection(sectionId: string): Promise<string> {
    // Sanitize to prevent path traversal
    const sanitized = sectionId.replace(/[^a-z0-9-]/gi, '');

    // Check cache
    if (this.sectionCache.has(sanitized) &&
        this.isCacheValid(this.sectionCacheTime.get(sanitized) || 0)) {
      return this.sectionCache.get(sanitized)!;
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
   * @param content - Content with icon expressions
   */
  async processIcons(content: string): Promise<string> {
    if (!content) return content;

    const icons = await this.getIcons();

    return content.replace(/\{\{icon:([\w-]+)(?::(\d+))?\}\}/g, (_match, iconName: string, sizeStr?: string) => {
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
   * @param query - Search query (min 2 chars)
   * @param options - Search options
   */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const { maxMatchesPerSection = 3, snippetRadius = 50 } = options;

    if (!query || query.length < 2) {
      return [];
    }

    const index = await this.loadIndex();
    const results: SearchResult[] = [];
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
        log.warn(`Failed to search section ${section.id}:`, errorDetails(err));
      }
    }

    return results;
  }

  /**
   * Clear all caches
   * Useful for testing or when content files change
   */
  clearCache(): void {
    this.indexCache = null;
    this.indexCacheTime = 0;
    this.sectionCache.clear();
    this.sectionCacheTime.clear();
    this.icons = null;
  }

  /**
   * Get section info from index
   * @param sectionId - Section ID
   */
  async getSectionInfo(sectionId: string): Promise<SectionInfo | null> {
    const index = await this.loadIndex();
    return index.sections.find(s => s.id === sectionId) || null;
  }
}

export type { SectionInfo, ContentIndex };

export default ContentManager;

// CommonJS compatibility for existing require() calls
module.exports = ContentManager;
