/**
 * ContentPanel - Shared slide-out panel component
 * Provides common navigation, search, and markdown rendering logic
 * for HelpPanel and AdminPanel.
 */

import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, memo, forwardRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Search, LucideIcon } from 'lucide-react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { buildMenuStructure, findParentId, getAllLeafSections, isItemActive, MenuItem } from '../lib/menuUtils';
import log from '../lib/logger';
import type { ClusterHealth, ClusterHistoryPoint } from '../types';

// Module-level default to avoid new array reference on every render
const DEFAULT_PURIFY_ATTRS: string[] = ['target'];

// Configure marked for safe HTML output (module-level, runs once)
marked.setOptions({
  gfm: true,
  breaks: false,
});

// Configure DOMPurify to allow data attributes for widget placeholders
DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
  if (data.attrName.startsWith('data-widget-')) {
    data.forceKeepAttr = true;
  }
});

/** Single source of truth for the widget placeholder shape */
export interface ParsedWidget {
  id: string;
  name: string;
  props: Record<string, string>;
  fullMatch: string;
}

type IconEntry = LucideIcon | (() => React.ReactElement);

interface WidgetModule {
  widgetRegistry: Record<string, unknown>;
  parseWidgets: (html: string) => ParsedWidget[];
  replaceWidgetsWithPlaceholders: (html: string, widgets: ParsedWidget[]) => string;
}

interface SearchResult {
  sectionId: string;
  sectionTitle: string;
  snippet: string;
}

// --- MarkdownContent ---

interface MarkdownContentProps {
  html: string;
  onLinkClick: React.MouseEventHandler<HTMLDivElement>;
  purifyAddAttr?: string[];
}

/**
 * Memoized markdown content rendered via a forwarded ref.
 * Only re-renders when the html string changes - this is critical to prevent
 * portal targets from being destroyed on health/history updates.
 */
const MarkdownContentInner = forwardRef<HTMLDivElement | null, MarkdownContentProps>(
  function MarkdownContentInner({ html, onLinkClick, purifyAddAttr = ['target'] }, ref) {
    const sanitizedHtml = DOMPurify.sanitize(marked.parse(html || '') as string, {
      ADD_ATTR: purifyAddAttr,
    });

    return (
      <div
        ref={ref}
        dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
        onClick={onLinkClick}
      />
    );
  }
);

const MarkdownContentMemo = memo(MarkdownContentInner, (prev, next) => prev.html === next.html);

// Public wrapper that accepts the ref via the contentRef prop (avoids forwardRef in the public interface)
export interface MarkdownContentPublicProps {
  html: string;
  contentRef: React.RefObject<HTMLDivElement | null>;
  /** Optional: link clicks are handled by ContentPanel internally */
  onLinkClick?: React.MouseEventHandler<HTMLDivElement>;
}

function MarkdownContent({ html, contentRef, onLinkClick }: MarkdownContentPublicProps) {
  return (
    <MarkdownContentMemo
      ref={contentRef}
      html={html}
      onLinkClick={onLinkClick ?? (() => undefined)}
    />
  );
}

// --- WidgetPortals ---

interface MountPoint {
  widget: ParsedWidget;
  element: Element;
}

export interface WidgetPortalsProps {
  widgets: ParsedWidget[];
  health?: Record<string, ClusterHealth | null>;
  history?: Record<string, ClusterHistoryPoint[]>;
  extraProps?: Record<string, unknown>;
  widgetModule: WidgetModule;
  contentKey: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Renders widgets into their placeholder elements using React portals.
 * Uses a key-based approach to maintain stable references.
 */
function WidgetPortals({ widgets, health, history, extraProps, widgetModule, contentKey, containerRef }: WidgetPortalsProps) {
  const [mountPoints, setMountPoints] = useState<MountPoint[]>([]);

  // useLayoutEffect (not useEffect) so mount-points are established synchronously after
  // the DOM is committed but before paint — eliminates the visible empty-box flash that
  // occurred when useEffect + setTimeout(0) let one painted frame through with no portals.
  useLayoutEffect(() => {
    if (!containerRef.current || widgets.length === 0) {
      setMountPoints([]);
      return;
    }

    const points = widgets.map(widget => {
      const el = containerRef.current?.querySelector(`[data-widget-id="${widget.id}"]`);
      return el ? { widget, element: el } : null;
    }).filter((p): p is MountPoint => p !== null);

    setMountPoints(points);
  }, [widgets, containerRef, contentKey]);

  return (
    <>
      {mountPoints.map(({ widget, element }) => {
        const registry = widgetModule.widgetRegistry;
        const Component = registry[widget.name] as React.ComponentType<Record<string, unknown>> | undefined;
        if (!Component) {
          log.warn('Unknown widget', { name: widget.name });
          return null;
        }
        return createPortal(
          <Component
            {...widget.props}
            health={health}
            history={history}
            {...extraProps}
          />,
          element,
          widget.id
        );
      })}
    </>
  );
}

// --- ContentPanel ---

interface ContentPanelProps {
  panelClass: string;
  /** CSS class prefix for nav rows/items (e.g. "help" or "admin") */
  navClassPrefix: string;
  headerIcon: React.ReactNode;
  title: string;
  isOpen: boolean;
  onClose: () => void;
  health?: Record<string, ClusterHealth | null>;
  history?: Record<string, ClusterHistoryPoint[]>;
  menuEndpoint: string;
  contentEndpoint: (id: string) => string;
  searchEndpoint: string;
  defaultSection?: string;
  linkPattern: RegExp;
  iconMap: Record<string, IconEntry>;
  widgetModule: WidgetModule;
  getAuthHeader?: () => Record<string, string>;
  purifyAddAttr?: string[];
  extraWidgetProps?: Record<string, unknown>;
  renderContent?: (opts: {
    content: string;
    widgets: ParsedWidget[];
    activeSection: string;
    contentRef: React.RefObject<HTMLDivElement | null>;
    MarkdownContent: React.ComponentType<MarkdownContentPublicProps>;
    WidgetPortals: React.ComponentType<Omit<WidgetPortalsProps, 'widgetModule' | 'containerRef' | 'contentKey'>>;
  }) => React.ReactNode;
}

function ContentPanel({
  panelClass,
  navClassPrefix,
  headerIcon,
  title,
  isOpen,
  onClose,
  health = {},
  history = {},
  menuEndpoint,
  contentEndpoint,
  searchEndpoint,
  defaultSection = 'overview',
  linkPattern,
  iconMap,
  widgetModule,
  getAuthHeader,
  purifyAddAttr = DEFAULT_PURIFY_ATTRS,
  extraWidgetProps,
  renderContent,
}: ContentPanelProps) {
  const [menuStructure, setMenuStructure] = useState<MenuItem[]>([]);
  const [activeSection, setActiveSection] = useState(defaultSection);
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [widgets, setWidgets] = useState<ParsedWidget[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  // Refs let us read the latest value inside stable useCallback functions without
  // including them as deps (which would recreate the function every render/navigation
  // and cause React to treat BoundMarkdownContent / BoundWidgetPortals as new component
  // types, triggering unmount+remount and leaving empty widget boxes).
  const purifyAddAttrRef = useRef(purifyAddAttr);
  purifyAddAttrRef.current = purifyAddAttr;
  const activeSectionRef = useRef(activeSection);
  activeSectionRef.current = activeSection;
  const widgetModuleRef = useRef(widgetModule);
  widgetModuleRef.current = widgetModule;

  // Fetch menu structure when panel opens
  useEffect(() => {
    if (!isOpen) return;

    const headers = getAuthHeader ? getAuthHeader() : {};
    fetch(menuEndpoint, { headers })
      .then(res => {
        if (!res.ok) throw new Error('Failed to load menu');
        return res.json();
      })
      .then(data => {
        if (data.sections) {
          setMenuStructure(buildMenuStructure(data.sections));
        }
      })
      .catch(err => {
        log.error('Failed to load menu index', { error: err });
      });
  }, [isOpen, menuEndpoint, getAuthHeader]);

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

    const headers = getAuthHeader ? getAuthHeader() : {};
    fetch(contentEndpoint(activeSection), { headers })
      .then(res => {
        if (!res.ok) throw new Error('Failed to load content');
        return res.json();
      })
      .then(data => {
        const rawContent = data.content || '';
        const parsedWidgets = widgetModule.parseWidgets(rawContent);
        setWidgets(parsedWidgets);
        const processedContent = widgetModule.replaceWidgetsWithPlaceholders(rawContent, parsedWidgets);
        setContent(processedContent);
        setLoading(false);
      })
      .catch(err => {
        log.error('Failed to load section', { error: err });
        setContent('Failed to load content.');
        setWidgets([]);
        setLoading(false);
      });
  }, [activeSection, isOpen, contentEndpoint, getAuthHeader, widgetModule]);

  // Search
  const handleSearch = useCallback(async () => {
    if (searchQuery.length < 2) {
      setSearchResults(null);
      return;
    }

    try {
      const headers = getAuthHeader ? getAuthHeader() : {};
      const res = await fetch(`${searchEndpoint}?q=${encodeURIComponent(searchQuery)}`, { headers });
      if (!res.ok) throw new Error(`Search failed: ${res.status}`);
      const data = await res.json();
      setSearchResults(data.results || []);
    } catch (err) {
      log.error('Search failed', { error: err });
    }
  }, [searchQuery, searchEndpoint, getAuthHeader]);

  useEffect(() => {
    if (searchQuery.length < 2) {
      setSearchResults(null);
      return;
    }
    const timer = setTimeout(handleSearch, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, handleSearch]);

  const getIcon = (iconName: string | undefined): React.ReactNode => {
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
  const handleTopLevelClick = useCallback((item: MenuItem) => {
    if (item.children) {
      if (expandedGroup === item.id) {
        setExpandedGroup(null);
      } else {
        setExpandedGroup(item.id as string);
        setActiveSection(item.children[0].id as string);
      }
    } else {
      setExpandedGroup(null);
      setActiveSection(item.id as string);
    }
    setSearchQuery('');
  }, [expandedGroup]);

  const isTopLevelActive = (item: MenuItem) => isItemActive(item, activeSection);

  const expandedChildren = expandedGroup
    ? menuStructure.find(m => m.id === expandedGroup)?.children || []
    : [];

  // Build the link click handler for the markdown content
  const handleLinkClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const link = target.closest('a');
    if (link) {
      const href = link.getAttribute('href');
      const allSections = getAllLeafSections(menuStructure);

      const patternMatch = href?.match(linkPattern);
      if (patternMatch) {
        e.preventDefault();
        const sectionId = patternMatch[1];
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
  }, [linkPattern, menuStructure]);

  // MarkdownContent wrapper with purifyAddAttr and handleLinkClick bound from ContentPanel scope.
  // purifyAddAttr is read via ref so it never appears in deps — this keeps BoundMarkdownContent
  // as a stable function reference across polls, preventing unmount/remount flashes.
  const BoundMarkdownContent = useCallback(
    ({ html, contentRef: ref }: MarkdownContentPublicProps) => (
      <MarkdownContentMemo
        ref={ref}
        html={html}
        onLinkClick={handleLinkClick}
        purifyAddAttr={purifyAddAttrRef.current}
      />
    ),
    [handleLinkClick]
  );

  // BoundWidgetPortals is used as a JSX component type (<BoundWidgetPortals .../>).
  // If its reference changes, React treats it as a NEW component, unmounting the old
  // WidgetPortals instance (clearing mountPoints state) and mounting a fresh one.
  // Before paint the portals are gone → user sees empty border boxes.
  //
  // Fix: read widgetModule and activeSection via refs so they never appear as deps.
  // BoundWidgetPortals is now created once (empty deps []) and is permanently stable.
  // WidgetPortals still receives the correct contentKey via activeSectionRef.current,
  // and its own useLayoutEffect re-runs whenever contentKey or widgets changes.
  const BoundWidgetPortals = useCallback(
    ({ widgets: w, health: h, history: hist, extraProps: ep }: Omit<WidgetPortalsProps, 'widgetModule' | 'containerRef' | 'contentKey'>) => (
      <WidgetPortals
        widgets={w}
        health={h}
        history={hist}
        extraProps={ep}
        widgetModule={widgetModuleRef.current}
        contentKey={activeSectionRef.current}
        containerRef={contentRef}
      />
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const defaultContentArea = (
    <>
      <BoundMarkdownContent
        html={content}
        contentRef={contentRef}
      />
      <BoundWidgetPortals
        widgets={widgets}
        health={health}
        history={history}
        extraProps={extraWidgetProps}
      />
    </>
  );

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
      <div className={`${panelClass} ${isOpen ? 'open' : ''}`}>
        {/* Header */}
        <div className={`${panelClass}-header`}>
          <div className={`${panelClass}-header-left`}>
            {headerIcon}
            <span className={`${panelClass}-title`}>{title}</span>
          </div>
          <div className={`${panelClass}-header-right`}>
            <div className={`${panelClass}-search-inline`}>
              <Search size={14} />
              <input
                type="text"
                placeholder="Search..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <button className={`${panelClass}-close`} onClick={onClose} title="Close (Esc)">
              <span style={{ fontSize: '0.7rem', opacity: 0.6, marginRight: 4 }}>Esc</span>
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Navigation - Top Row */}
        <div className={`${panelClass}-nav`}>
          <div className={`${navClassPrefix}-nav-row`}>
            {menuStructure.map(item => (
              <button
                key={item.id as string}
                className={`${navClassPrefix}-nav-item ${isTopLevelActive(item) ? 'active' : ''}`}
                onClick={() => handleTopLevelClick(item)}
              >
                {getIcon(item.icon as string | undefined)}
                <span>{item.title as string}</span>
              </button>
            ))}
          </div>

          {/* Second Row - Children of expanded group */}
          {expandedChildren.length > 0 && (
            <div className={`${navClassPrefix}-nav-row ${navClassPrefix}-nav-row-children`}>
              {expandedChildren.map(child => (
                <button
                  key={child.id as string}
                  className={`${navClassPrefix}-nav-item ${activeSection === child.id ? 'active' : ''}`}
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
        <div className={`${panelClass}-content`}>
          {searchResults !== null ? (
            searchResults.length === 0 ? (
              <p style={{ color: 'var(--text-muted)' }}>
                No results found for &quot;{searchQuery}&quot;
              </p>
            ) : (
              <div>
                <p style={{ marginBottom: 16, color: 'var(--text-muted)' }}>
                  {searchResults.length} result(s) for &quot;{searchQuery}&quot;
                </p>
                {searchResults.map((result, i) => (
                  <div
                    key={`${result.sectionId}-${i}`}
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
          ) : (loading && !content) ? (
            // Only show the full-replacement spinner on initial load (content is empty).
            // On subsequent navigations content still holds the previous section's html,
            // so we fall through to render it — old content stays visible while the new
            // section fetches, then swaps in place. This prevents the title-flash caused
            // by blank spinner → new content on every page change.
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
              <div className="spinner" style={{ marginBottom: 12 }} />
              <p>Loading...</p>
            </div>
          ) : (
            renderContent
              ? renderContent({
                  content,
                  widgets,
                  activeSection,
                  contentRef,
                  MarkdownContent: BoundMarkdownContent,
                  WidgetPortals: BoundWidgetPortals,
                })
              : defaultContentArea
          )}
        </div>
      </div>
    </>
  );
}

export default memo(ContentPanel);
export type { ContentPanelProps, WidgetModule };
export { MarkdownContent, WidgetPortals };
