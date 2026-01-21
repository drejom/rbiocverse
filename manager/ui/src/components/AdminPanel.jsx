/**
 * AdminPanel - Slide-out admin panel (left side)
 * Provides user management, cluster status, and reports
 */

import React, { useState, useEffect, useCallback, useRef, memo } from 'react';
import { createPortal } from 'react-dom';
import { X, Search, LayoutDashboard, Server, Users, BarChart, Activity } from 'lucide-react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { useAuth } from '../contexts/AuthContext';
import { widgetRegistry, parseWidgets, replaceWidgetsWithPlaceholders } from './admin-widgets';
import { buildMenuStructure, findParentId, getAllLeafSections, isItemActive } from '../lib/menuUtils';

// Configure marked for safe HTML output
marked.setOptions({
  gfm: true,
  breaks: false,
});

// Configure DOMPurify to allow data attributes for widget placeholders
DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (data.attrName.startsWith('data-widget-')) {
    data.forceKeepAttr = true;
  }
});

// Icon mapping for sections
const iconMap = {
  'layout-dashboard': LayoutDashboard,
  server: Server,
  users: Users,
  'bar-chart': BarChart,
  activity: Activity,
};

/**
 * Memoized markdown content
 */
const MarkdownContent = memo(React.forwardRef(function MarkdownContent({ content, onLinkClick }, ref) {
  const sanitizedHtml = DOMPurify.sanitize(marked.parse(content || ''), {
    ADD_ATTR: ['target', 'data-widget-id', 'data-widget-name'],
  });

  return (
    <div
      ref={ref}
      dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
      onClick={onLinkClick}
    />
  );
}), (prev, next) => prev.content === next.content);

/**
 * Renders widgets into their placeholder elements using React portals
 */
function WidgetPortals({ widgets, containerRef, contentKey, health, history, partitions, onRefreshPartitions, isRefreshingPartitions }) {
  const [mountPoints, setMountPoints] = useState([]);
  const { getAuthHeader } = useAuth();

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (!containerRef.current || widgets.length === 0) {
        setMountPoints([]);
        return;
      }

      const points = widgets.map(widget => {
        const el = containerRef.current?.querySelector(`[data-widget-id="${widget.id}"]`);
        return el ? { widget, element: el } : null;
      }).filter(Boolean);

      setMountPoints(points);
    }, 0);

    return () => clearTimeout(timeoutId);
  }, [widgets, containerRef, contentKey]);

  return (
    <>
      {mountPoints.map(({ widget, element }) => {
        const Component = widgetRegistry[widget.name];
        if (!Component) {
          console.warn(`Unknown admin widget: ${widget.name}`);
          return null;
        }
        return createPortal(
          <Component
            key={widget.id}
            {...widget.props}
            health={health}
            history={history}
            partitions={partitions}
            onRefreshPartitions={onRefreshPartitions}
            isRefreshing={isRefreshingPartitions}
            getAuthHeader={getAuthHeader}
          />,
          element
        );
      })}
    </>
  );
}

function AdminPanel({ isOpen, onClose, health = {}, history = {} }) {
  const [menuStructure, setMenuStructure] = useState([]);
  const [activeSection, setActiveSection] = useState('overview');
  const [expandedGroup, setExpandedGroup] = useState(null);
  const [content, setContent] = useState('');
  const [widgets, setWidgets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [partitions, setPartitions] = useState({});
  const [isRefreshingPartitions, setIsRefreshingPartitions] = useState(false);
  const contentRef = useRef(null);
  const { getAuthHeader } = useAuth();

  // Fetch partition data
  const fetchPartitions = useCallback(async () => {
    try {
      const res = await fetch('/api/stats/partitions');
      const data = await res.json();
      setPartitions(data.partitions || {});
    } catch (err) {
      console.error('Failed to fetch partitions:', err);
    }
  }, []);

  // Refresh partitions (admin action)
  const handleRefreshPartitions = useCallback(async () => {
    setIsRefreshingPartitions(true);
    try {
      const res = await fetch('/api/admin/partitions/refresh', {
        method: 'POST',
        headers: getAuthHeader(),
      });
      const data = await res.json();
      setPartitions(data.partitions || {});
    } catch (err) {
      console.error('Failed to refresh partitions:', err);
    } finally {
      setIsRefreshingPartitions(false);
    }
  }, [getAuthHeader]);

  // Fetch partitions when panel opens
  useEffect(() => {
    if (isOpen) {
      fetchPartitions();
    }
  }, [isOpen, fetchPartitions]);

  // Fetch menu structure on mount
  useEffect(() => {
    fetch('/api/admin/index', {
      headers: getAuthHeader(),
    })
      .then(res => res.json())
      .then(data => {
        if (data.sections) {
          setMenuStructure(buildMenuStructure(data.sections));
        }
      })
      .catch(err => {
        console.error('Failed to load admin index:', err);
      });
  }, [getAuthHeader]);

  // Handle ESC key to close
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e) => {
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

    fetch(`/api/admin/content/${activeSection}`, {
      headers: getAuthHeader(),
    })
      .then(res => {
        if (!res.ok) throw new Error('Failed to load content');
        return res.json();
      })
      .then(data => {
        const rawContent = data.content || '';
        const parsedWidgets = parseWidgets(rawContent);
        setWidgets(parsedWidgets);
        const processedContent = replaceWidgetsWithPlaceholders(rawContent, parsedWidgets);
        setContent(processedContent);
        setLoading(false);
      })
      .catch(err => {
        console.error('Failed to load admin section:', err);
        setContent('Failed to load content.');
        setWidgets([]);
        setLoading(false);
      });
  }, [activeSection, isOpen, getAuthHeader]);

  // Search
  const handleSearch = useCallback(async () => {
    if (searchQuery.length < 2) {
      setSearchResults(null);
      return;
    }

    try {
      const res = await fetch(`/api/admin/search?q=${encodeURIComponent(searchQuery)}`, {
        headers: getAuthHeader(),
      });
      const data = await res.json();
      setSearchResults(data.results || []);
    } catch (err) {
      console.error('Search failed:', err);
    }
  }, [searchQuery, getAuthHeader]);

  useEffect(() => {
    if (searchQuery.length < 2) {
      setSearchResults(null);
      return;
    }
    const timer = setTimeout(handleSearch, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, handleSearch]);

  const getIcon = (iconName) => {
    const Icon = iconMap[iconName];
    if (!Icon) return null;
    return <Icon size={14} />;
  };

  // Handle top-level item click
  const handleTopLevelClick = (item) => {
    if (item.children) {
      // Toggle expansion, select first child if expanding
      if (expandedGroup === item.id) {
        setExpandedGroup(null);
      } else {
        setExpandedGroup(item.id);
        setActiveSection(item.children[0].id);
      }
    } else {
      // Direct section - select it and collapse any expanded group
      setExpandedGroup(null);
      setActiveSection(item.id);
    }
    setSearchQuery('');
  };

  // Check if a top-level item is "active"
  const isTopLevelActive = (item) => isItemActive(item, activeSection);

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
      <div className={`admin-panel ${isOpen ? 'open' : ''}`}>
        {/* Header */}
        <div className="admin-panel-header">
          <div className="admin-panel-header-left">
            <LayoutDashboard size={20} style={{ marginRight: 8 }} />
            <span className="admin-panel-title">Admin Panel</span>
          </div>
          <div className="admin-panel-header-right">
            <div className="admin-panel-search-inline">
              <Search size={14} />
              <input
                type="text"
                placeholder="Search..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <button className="admin-panel-close" onClick={onClose} title="Close (Esc)">
              <span style={{ fontSize: '0.7rem', opacity: 0.6, marginRight: 4 }}>Esc</span>
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Navigation - Top Row */}
        <div className="admin-panel-nav">
          <div className="admin-nav-row">
            {menuStructure.map(item => (
              <button
                key={item.id}
                className={`admin-nav-item ${isTopLevelActive(item) ? 'active' : ''}`}
                onClick={() => handleTopLevelClick(item)}
              >
                {getIcon(item.icon)}
                <span>{item.title}</span>
              </button>
            ))}
          </div>

          {/* Second Row - Children of expanded group */}
          {expandedChildren.length > 0 && (
            <div className="admin-nav-row admin-nav-row-children">
              {expandedChildren.map(child => (
                <button
                  key={child.id}
                  className={`admin-nav-item ${activeSection === child.id ? 'active' : ''}`}
                  onClick={() => {
                    setActiveSection(child.id);
                    setSearchQuery('');
                  }}
                >
                  {getIcon(child.icon)}
                  <span>{child.title}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Content */}
        <div className="admin-panel-content">
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
            <>
              <MarkdownContent
                ref={contentRef}
                content={content}
                onLinkClick={(e) => {
                  const link = e.target.closest('a');
                  if (link) {
                    const href = link.getAttribute('href');
                    const allSections = getAllSections();

                    // Match /admin/section or /api/admin/content/section formats
                    const adminMatch = href?.match(/^\/(?:api\/)?admin(?:\/content)?\/(.+)$/);
                    if (adminMatch) {
                      e.preventDefault();
                      const sectionId = adminMatch[1];
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
              <WidgetPortals
                widgets={widgets}
                containerRef={contentRef}
                contentKey={activeSection}
                health={health}
                history={history}
                partitions={partitions}
                onRefreshPartitions={handleRefreshPartitions}
                isRefreshingPartitions={isRefreshingPartitions}
              />
            </>
          )}
        </div>
      </div>
    </>
  );
}

export default memo(AdminPanel);
