/**
 * HelpPanel - Slide-out panel with markdown help content
 * Supports dynamic widgets embedded in markdown via :::widget WidgetName prop="value"::: syntax
 */

import React, { useState, useEffect, useCallback, useRef, memo, forwardRef, MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { X, Search, Rocket, Box, Wrench, HelpCircle, Monitor, LucideIcon, List, ChevronRight } from 'lucide-react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { widgetRegistry, parseWidgets, replaceWidgetsWithPlaceholders, ParsedWidget } from './help-widgets';
import { buildMenuStructure, findParentId, getAllLeafSections, isItemActive, MenuItem } from '../lib/menuUtils';
import type { ClusterHealth, ClusterHistoryPoint } from '../types';

// Configure marked for safe HTML output
marked.setOptions({
  gfm: true,
  breaks: false,
});

// Configure DOMPurify to allow data attributes for widget placeholders
DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
  // Allow data-widget-* attributes for widget placeholders
  if (data.attrName.startsWith('data-widget-')) {
    data.forceKeepAttr = true;
  }
});

type IconComponent = LucideIcon | (() => React.ReactElement);

// Icon mapping for sections
const iconMap: Record<string, IconComponent> = {
  rocket: Rocket,
  box: Box,
  wrench: Wrench,
  question: HelpCircle,
  monitor: Monitor,
  'devicon-vscode': () => <i className="devicon-vscode-plain" style={{ fontSize: 14 }} />,
  'devicon-rstudio': () => <i className="devicon-rstudio-plain" style={{ fontSize: 14 }} />,
  'devicon-jupyter': () => <i className="devicon-jupyter-plain" style={{ fontSize: 14 }} />,
};

interface MarkdownContentProps {
  content: string;
  onLinkClick: (e: MouseEvent<HTMLDivElement>) => void;
}

/**
 * Memoized markdown content - only re-renders when content changes
 * This is critical: prevents portal targets from being destroyed on health/history updates
 * Uses forwardRef to properly pass the ref to the div element
 */
const MarkdownContent = memo(forwardRef<HTMLDivElement, MarkdownContentProps>(function MarkdownContent({ content, onLinkClick }, ref) {
  // Parse markdown and sanitize HTML to prevent XSS attacks
  const sanitizedHtml = DOMPurify.sanitize(marked.parse(content || '') as string, {
    ADD_ATTR: ['target'], // Allow target="_blank" for links
  });

  return (
    <div
      ref={ref}
      dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
      onClick={onLinkClick}
    />
  );
}), (prev, next) => prev.content === next.content);

interface TocItem {
  id: string;
  text: string;
}

interface FloatingTocProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  contentKey: string;
}

/**
 * Floating Table of Contents - extracts H2 headings from rendered markdown
 */
function FloatingToc({ containerRef, contentKey }: FloatingTocProps) {
  const [items, setItems] = useState<TocItem[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const tocListId = `help-toc-list-${contentKey}`;

  // Extract H2 headings when content changes
  useEffect(() => {
    const extractHeadings = () => {
      if (!containerRef.current) return;
      const headings = containerRef.current.querySelectorAll('h2');
      const tocItems: TocItem[] = [];

      headings.forEach((heading, index) => {
        // Generate a scoped ID if not present (include contentKey to avoid collisions)
        let id = heading.id;
        if (!id) {
          id = `toc-${contentKey}-heading-${index}`;
          heading.id = id;
        }
        tocItems.push({
          id,
          text: heading.textContent || `Section ${index + 1}`,
        });
      });

      setItems(tocItems);
      setActiveId(tocItems[0]?.id || null);
    };

    // Delay to ensure content is rendered
    const timeout = setTimeout(extractHeadings, 100);
    return () => clearTimeout(timeout);
  }, [containerRef, contentKey]);

  // Track scroll position to highlight current section
  useEffect(() => {
    if (items.length === 0) return;

    const handleScroll = () => {
      const container = containerRef.current?.closest('.help-panel-content');
      if (!container) return;

      const scrollTop = container.scrollTop;
      let currentId = items[0]?.id;

      for (const item of items) {
        // Use scoped lookup within containerRef
        const element = containerRef.current?.querySelector(`#${CSS.escape(item.id)}`);
        if (element) {
          const offsetTop = (element as HTMLElement).offsetTop - 100;
          if (scrollTop >= offsetTop) {
            currentId = item.id;
          }
        }
      }

      setActiveId(currentId);
    };

    const container = containerRef.current?.closest('.help-panel-content');
    container?.addEventListener('scroll', handleScroll);
    return () => container?.removeEventListener('scroll', handleScroll);
  }, [items, containerRef]);

  // Scroll to heading
  const scrollTo = (id: string) => {
    const element = containerRef.current?.querySelector(`#${CSS.escape(id)}`);
    const container = containerRef.current?.closest('.help-panel-content');
    if (element && container) {
      const offsetTop = (element as HTMLElement).offsetTop - 20;
      container.scrollTo({ top: offsetTop, behavior: 'smooth' });
    }
  };

  // Don't render if no headings
  if (items.length === 0) return null;

  return (
    <div className={`help-toc ${isOpen ? 'open' : ''}`}>
      <button
        className="help-toc-toggle"
        onClick={() => setIsOpen(!isOpen)}
        title={isOpen ? 'Hide table of contents' : 'Show table of contents'}
        aria-expanded={isOpen}
        aria-controls={tocListId}
      >
        <List size={16} />
        <span className="help-toc-label">TOC</span>
        <ChevronRight size={14} className={`help-toc-chevron ${isOpen ? 'open' : ''}`} />
      </button>

      {isOpen && (
        <nav id={tocListId} className="help-toc-list" aria-label="Table of contents">
          {items.map((item) => (
            <button
              key={item.id}
              className={`help-toc-item ${activeId === item.id ? 'active' : ''}`}
              onClick={() => scrollTo(item.id)}
            >
              {item.text}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}

interface MountPoint {
  widget: ParsedWidget;
  element: Element;
}

interface WidgetPortalsProps {
  widgets: ParsedWidget[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  contentKey: string;
  health: Record<string, ClusterHealth | null>;
  history: Record<string, ClusterHistoryPoint[]>;
}

/**
 * Renders widgets into their placeholder elements using React portals
 * Uses a key-based approach to maintain stable references
 */
function WidgetPortals({ widgets, containerRef, contentKey, health, history }: WidgetPortalsProps) {
  const [mountPoints, setMountPoints] = useState<MountPoint[]>([]);

  useEffect(() => {
    // Use setTimeout(0) to ensure we run after React has fully committed
    // and the ref is definitely set
    const timeoutId = setTimeout(() => {
      if (!containerRef.current || widgets.length === 0) {
        setMountPoints([]);
        return;
      }

      const points = widgets.map(widget => {
        const el = containerRef.current?.querySelector(`[data-widget-id="${widget.id}"]`);
        return el ? { widget, element: el } : null;
      }).filter((p): p is MountPoint => p !== null);

      setMountPoints(points);
    }, 0);

    return () => clearTimeout(timeoutId);
  }, [widgets, containerRef, contentKey]);

  return (
    <>
      {mountPoints.map(({ widget, element }) => {
        const Component = widgetRegistry[widget.name];
        if (!Component) {
          console.warn(`Unknown help widget: ${widget.name}`);
          return null;
        }
        return createPortal(
          <Component key={widget.id} {...widget.props} health={health} history={history} />,
          element
        );
      })}
    </>
  );
}

interface SearchResult {
  sectionId: string;
  sectionTitle: string;
  snippet: string;
}

interface HelpPanelProps {
  isOpen: boolean;
  onClose: () => void;
  health?: Record<string, ClusterHealth | null>;
  history?: Record<string, ClusterHistoryPoint[]>;
}

function HelpPanel({ isOpen, onClose, health = {}, history = {} }: HelpPanelProps) {
  const [menuStructure, setMenuStructure] = useState<MenuItem[]>([]);
  const [activeSection, setActiveSection] = useState('quick-start');
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null); // Only one group expanded at a time
  const [content, setContent] = useState('');
  const [widgets, setWidgets] = useState<ParsedWidget[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Fetch menu structure on mount
  useEffect(() => {
    fetch('/api/help')
      .then(res => res.json())
      .then(data => {
        if (data.sections) {
          setMenuStructure(buildMenuStructure(data.sections));
        }
      })
      .catch(err => {
        console.error('Failed to load help index:', err);
      });
  }, []);

  // Handle ESC key to close
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Load section content
  useEffect(() => {
    if (!activeSection || !isOpen) return;

    setLoading(true);
    setSearchResults(null);
    setWidgets([]);

    fetch(`/api/help/${activeSection}`)
      .then(res => res.json())
      .then(data => {
        const rawContent = data.content || '';
        // Parse widgets from content
        const parsedWidgets = parseWidgets(rawContent);
        setWidgets(parsedWidgets);
        // Replace widget syntax with placeholder divs
        const processedContent = replaceWidgetsWithPlaceholders(rawContent, parsedWidgets);
        setContent(processedContent);
        setLoading(false);
      })
      .catch(err => {
        console.error('Failed to load help section:', err);
        setContent('Failed to load content.');
        setWidgets([]);
        setLoading(false);
      });
  }, [activeSection, isOpen]);

  // Search
  const handleSearch = useCallback(async () => {
    if (searchQuery.length < 2) {
      setSearchResults(null);
      return;
    }

    try {
      const res = await fetch(`/api/help/search?q=${encodeURIComponent(searchQuery)}`);
      const data = await res.json();
      setSearchResults(data.results || []);
    } catch (err) {
      console.error('Search failed:', err);
    }
  }, [searchQuery]);

  useEffect(() => {
    if (searchQuery.length < 2) {
      setSearchResults(null);
      return;
    }
    const timer = setTimeout(handleSearch, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, handleSearch]);

  const getIcon = (iconName: string | undefined) => {
    if (!iconName) return null;
    const Icon = iconMap[iconName];
    if (!Icon) return null;
    if (iconName.startsWith('devicon-')) {
      return (Icon as () => React.ReactElement)();
    }
    const LucideIconComponent = Icon as LucideIcon;
    return <LucideIconComponent size={14} />;
  };

  // Handle top-level item click
  const handleTopLevelClick = (item: MenuItem) => {
    if (item.children) {
      // Toggle expansion, select first child if expanding
      if (expandedGroup === item.id) {
        setExpandedGroup(null);
      } else {
        setExpandedGroup(item.id as string);
        setActiveSection(item.children[0].id as string);
      }
    } else {
      // Direct section - select it and collapse any expanded group
      setExpandedGroup(null);
      setActiveSection(item.id as string);
    }
    setSearchQuery('');
  };

  // Check if a top-level item is "active" (either it's selected, or one of its children is)
  const isTopLevelActive = (item: MenuItem) => isItemActive(item, activeSection);

  // Get expanded group's children
  const expandedChildren = expandedGroup
    ? menuStructure.find(m => m.id === expandedGroup)?.children || []
    : [];

  // Get all leaf sections for link interception
  const getAllSections = () => getAllLeafSections(menuStructure);

  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.3)',
            zIndex: 199,
          }}
          onClick={onClose}
        />
      )}

      {/* Panel */}
      <div className={`help-panel ${isOpen ? 'open' : ''}`}>
        {/* Header */}
        <div className="help-panel-header">
          <div className="help-panel-header-left">
            <HelpCircle size={20} style={{ marginRight: 8 }} />
            <span className="help-panel-title">Help</span>
          </div>
          <div className="help-panel-header-right">
            <div className="help-panel-search-inline">
              <Search size={14} />
              <input
                type="text"
                placeholder="Search..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <button className="help-panel-close" onClick={onClose} title="Close (Esc)">
              <span style={{ fontSize: '0.7rem', opacity: 0.6, marginRight: 4 }}>Esc</span>
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Navigation - Top Row */}
        <div className="help-panel-nav">
          <div className="help-nav-row">
            {menuStructure.map(item => (
              <button
                key={item.id as string}
                className={`help-nav-item ${isTopLevelActive(item) ? 'active' : ''}`}
                onClick={() => handleTopLevelClick(item)}
              >
                {getIcon(item.icon as string | undefined)}
                <span>{item.title as string}</span>
              </button>
            ))}
          </div>

          {/* Second Row - Children of expanded group */}
          {expandedChildren.length > 0 && (
            <div className="help-nav-row help-nav-row-children">
              {expandedChildren.map(child => (
                <button
                  key={child.id as string}
                  className={`help-nav-item ${activeSection === child.id ? 'active' : ''}`}
                  onClick={() => {
                    setActiveSection(child.id as string);
                    setSearchQuery('');
                  }}
                >
                  {getIcon(child.icon as string | undefined)}
                  <span>{child.title as string}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Content */}
        <div className="help-panel-content">
          {searchResults !== null ? (
            searchResults.length === 0 ? (
              <p style={{ color: 'var(--text-muted)' }}>
                No results found for "{searchQuery}"
              </p>
            ) : (
              <div>
                <p style={{ marginBottom: 16, color: 'var(--text-muted)' }}>
                  {searchResults.length} result(s) for "{searchQuery}"
                </p>
                {searchResults.map((result, i) => (
                  <div
                    key={i}
                    style={{
                      padding: 12,
                      marginBottom: 8,
                      background: 'var(--bg-card)',
                      borderRadius: 8,
                      cursor: 'pointer',
                    }}
                    onClick={() => {
                      setActiveSection(result.sectionId);
                      setSearchQuery('');
                      // Expand the parent group if needed
                      const parentId = findParentId(menuStructure, result.sectionId);
                      if (parentId) setExpandedGroup(parentId);
                    }}
                  >
                    <div style={{ fontWeight: 500, marginBottom: 4 }}>
                      {result.sectionTitle}
                    </div>
                    <div
                      style={{
                        fontSize: '0.85rem',
                        color: 'var(--text-secondary)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {result.snippet}
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : loading ? (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
              <div className="spinner" style={{ marginBottom: 12 }} />
              <p>Loading...</p>
            </div>
          ) : (
            <div className="help-content-wrapper">
              <FloatingToc containerRef={contentRef} contentKey={activeSection} />
              <MarkdownContent
                ref={contentRef}
                content={content}
                onLinkClick={(e) => {
                  const target = e.target as HTMLElement;
                  const link = target.closest('a');
                  if (link) {
                    const href = link.getAttribute('href');
                    const allSections = getAllSections();

                    // Match /help/section or /api/help/section formats
                    const helpMatch = href?.match(/^\/(?:api\/)?help\/(.+)$/);
                    if (helpMatch) {
                      e.preventDefault();
                      const sectionId = helpMatch[1];
                      setActiveSection(sectionId);
                      const parentId = findParentId(menuStructure, sectionId);
                      if (parentId) setExpandedGroup(parentId);
                    } else if (href?.startsWith('#')) {
                      e.preventDefault();
                      const sectionId = href.slice(1);
                      if (allSections.find(s => s.id === sectionId)) {
                        setActiveSection(sectionId);
                        const parentId = findParentId(menuStructure, sectionId);
                        if (parentId) setExpandedGroup(parentId);
                      }
                    }
                  }
                }}
              />
              <WidgetPortals widgets={widgets} containerRef={contentRef} contentKey={activeSection} health={health} history={history} />
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// Memoize to prevent re-renders from parent's useClusterStatus polling
export default memo(HelpPanel);
