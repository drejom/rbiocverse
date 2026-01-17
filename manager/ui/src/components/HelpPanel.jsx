/**
 * HelpPanel - Slide-out panel with markdown help content
 * Supports dynamic widgets embedded in markdown via :::widget WidgetName prop="value"::: syntax
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Search, Rocket, Box, Wrench, HelpCircle, Monitor } from 'lucide-react';
import { marked } from 'marked';
import { widgetRegistry, parseWidgets, replaceWidgetsWithPlaceholders, parseWidgetProps } from './help-widgets';

// Configure marked for safe HTML output
marked.setOptions({
  gfm: true,
  breaks: false,
});

// Icon mapping for sections
const iconMap = {
  rocket: Rocket,
  box: Box,
  wrench: Wrench,
  question: HelpCircle,
  monitor: Monitor,
  'devicon-vscode': () => <i className="devicon-vscode-plain" style={{ fontSize: 14 }} />,
  'devicon-rstudio': () => <i className="devicon-rstudio-plain" style={{ fontSize: 14 }} />,
  'devicon-jupyter': () => <i className="devicon-jupyter-plain" style={{ fontSize: 14 }} />,
};

// Menu structure - top level items, some with children
const menuStructure = [
  { id: 'quick-start', title: 'Quick Start', icon: 'rocket' },
  { id: 'environment', title: 'Environment', icon: 'box' },
  {
    id: 'ides',
    title: 'IDEs',
    icon: 'monitor',
    children: [
      { id: 'vscode', title: 'VS Code', icon: 'devicon-vscode' },
      { id: 'rstudio', title: 'RStudio', icon: 'devicon-rstudio' },
      { id: 'jupyterlab', title: 'JupyterLab', icon: 'devicon-jupyter' },
    ]
  },
  {
    id: 'support',
    title: 'Support',
    icon: 'question',
    children: [
      { id: 'troubleshooting', title: 'Troubleshooting', icon: 'wrench' },
      { id: 'faq', title: 'FAQ', icon: 'question' },
    ]
  },
];

/**
 * Renders widgets into their placeholder elements using React portals
 */
function WidgetPortals({ widgets, containerRef }) {
  const [mountPoints, setMountPoints] = useState([]);

  useEffect(() => {
    if (!containerRef.current || widgets.length === 0) {
      setMountPoints([]);
      return;
    }

    // Find all widget placeholder elements
    const points = widgets.map(widget => {
      const el = containerRef.current.querySelector(`[data-widget-id="${widget.id}"]`);
      return el ? { widget, element: el } : null;
    }).filter(Boolean);

    setMountPoints(points);
  }, [widgets, containerRef]);

  return (
    <>
      {mountPoints.map(({ widget, element }) => {
        const Component = widgetRegistry[widget.name];
        if (!Component) {
          console.warn(`Unknown help widget: ${widget.name}`);
          return null;
        }
        return createPortal(
          <Component key={widget.id} {...widget.props} />,
          element
        );
      })}
    </>
  );
}

function HelpPanel({ isOpen, onClose }) {
  const [activeSection, setActiveSection] = useState('quick-start');
  const [expandedGroup, setExpandedGroup] = useState(null); // Only one group expanded at a time
  const [content, setContent] = useState('');
  const [widgets, setWidgets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const contentRef = useRef(null);

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

  const getIcon = (iconName) => {
    const Icon = iconMap[iconName];
    if (!Icon) return null;
    if (iconName.startsWith('devicon-')) {
      return Icon();
    }
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

  // Check if a top-level item is "active" (either it's selected, or one of its children is)
  const isTopLevelActive = (item) => {
    if (item.children) {
      return item.children.some(child => child.id === activeSection);
    }
    return item.id === activeSection;
  };

  // Get expanded group's children
  const expandedChildren = expandedGroup
    ? menuStructure.find(m => m.id === expandedGroup)?.children || []
    : [];

  // Get all leaf sections for link interception
  const getAllSections = () => {
    const sections = [];
    menuStructure.forEach(item => {
      if (item.children) {
        sections.push(...item.children);
      } else {
        sections.push(item);
      }
    });
    return sections;
  };

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
            <button className="help-panel-close" onClick={onClose}>
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Navigation - Top Row */}
        <div className="help-panel-nav">
          <div className="help-nav-row">
            {menuStructure.map(item => (
              <button
                key={item.id}
                className={`help-nav-item ${isTopLevelActive(item) ? 'active' : ''}`}
                onClick={() => handleTopLevelClick(item)}
              >
                {getIcon(item.icon)}
                <span>{item.title}</span>
              </button>
            ))}
          </div>

          {/* Second Row - Children of expanded group */}
          {expandedChildren.length > 0 && (
            <div className="help-nav-row help-nav-row-children">
              {expandedChildren.map(child => (
                <button
                  key={child.id}
                  className={`help-nav-item ${activeSection === child.id ? 'active' : ''}`}
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
                      const parent = menuStructure.find(m =>
                        m.children?.some(c => c.id === result.sectionId)
                      );
                      if (parent) setExpandedGroup(parent.id);
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
              <div
                ref={contentRef}
                dangerouslySetInnerHTML={{ __html: marked.parse(content || '') }}
                onClick={(e) => {
                  const link = e.target.closest('a');
                  if (link) {
                    const href = link.getAttribute('href');
                    const allSections = getAllSections();

                    // Match /help/section or /api/help/section formats
                    const helpMatch = href?.match(/^\/(?:api\/)?help\/(.+)$/);
                    if (helpMatch) {
                      e.preventDefault();
                      const sectionId = helpMatch[1];
                      setActiveSection(sectionId);
                      const parent = menuStructure.find(m =>
                        m.children?.some(c => c.id === sectionId)
                      );
                      if (parent) setExpandedGroup(parent.id);
                    } else if (href?.startsWith('#')) {
                      e.preventDefault();
                      const sectionId = href.slice(1);
                      if (allSections.find(s => s.id === sectionId)) {
                        setActiveSection(sectionId);
                        const parent = menuStructure.find(m =>
                          m.children?.some(c => c.id === sectionId)
                        );
                        if (parent) setExpandedGroup(parent.id);
                      }
                    }
                  }
                }}
              />
              <WidgetPortals widgets={widgets} containerRef={contentRef} />
            </>
          )}
        </div>
      </div>
    </>
  );
}

export default HelpPanel;
