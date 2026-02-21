/**
 * HelpPanel - Slide-out panel with markdown help content
 * Supports dynamic widgets embedded in markdown via :::widget WidgetName prop="value"::: syntax
 */

import React, { useState, useEffect, memo } from 'react';
import { HelpCircle, List, ChevronRight, LucideIcon, Rocket, Box, Wrench, Monitor } from 'lucide-react';
import { widgetRegistry, parseWidgets, replaceWidgetsWithPlaceholders } from './help-widgets';
import ContentPanel from './ContentPanel';
import type { ClusterHealth, ClusterHistoryPoint } from '../types';

type IconComponent = LucideIcon | (() => React.ReactElement);

// Icon mapping for sections (includes devicon entries)
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

const widgetModule = { widgetRegistry, parseWidgets, replaceWidgetsWithPlaceholders };

// Module-level constants — avoid new references on every render.
// See AdminPanel.tsx for detailed comments on why each one matters.
const PURIFY_ADD_ATTR = ['target'];
const helpContentEndpoint = (id: string) => `/api/help/${id}`;
const HELP_LINK_PATTERN = /^\/(?:api\/)?help\/(.+)$/;

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

interface HelpPanelProps {
  isOpen: boolean;
  onClose: () => void;
  health?: Record<string, ClusterHealth | null>;
  history?: Record<string, ClusterHistoryPoint[]>;
}

function HelpPanel({ isOpen, onClose, health, history }: HelpPanelProps) {
  return (
    <ContentPanel
      panelClass="help-panel"
      navClassPrefix="help"
      headerIcon={<HelpCircle size={20} style={{ marginRight: 8 }} />}
      title="Help"
      isOpen={isOpen}
      onClose={onClose}
      health={health}
      history={history}
      menuEndpoint="/api/help"
      contentEndpoint={helpContentEndpoint}
      searchEndpoint="/api/help/search"
      defaultSection="quick-start"
      linkPattern={HELP_LINK_PATTERN}
      iconMap={iconMap}
      widgetModule={widgetModule}
      purifyAddAttr={PURIFY_ADD_ATTR}
      renderContent={({ content, widgets, activeSection, contentRef, MarkdownContent, WidgetPortals }) => (
        <div className="help-content-wrapper">
          <FloatingToc containerRef={contentRef} contentKey={activeSection} />
          <MarkdownContent
            html={content}
            contentRef={contentRef}
          />
          <WidgetPortals
            widgets={widgets}
            health={health}
            history={history}
          />
        </div>
      )}
    />
  );
}

// Memoize to prevent re-renders from parent's useClusterStatus polling
export default memo(HelpPanel);
