/**
 * Widget registry for help documentation
 * Maps widget names to React components
 */
import { ClusterHealth } from './ClusterHealth';

export const widgetRegistry = {
  ClusterHealth,
};

/**
 * Parse widget props from string format
 * Example: 'cluster="gemini"' -> { cluster: 'gemini' }
 */
export function parseWidgetProps(propsString) {
  const props = {};
  if (!propsString) return props;

  // Match prop="value" or prop='value' patterns
  const propRegex = /(\w+)=["']([^"']+)["']/g;
  let match;
  while ((match = propRegex.exec(propsString)) !== null) {
    props[match[1]] = match[2];
  }

  return props;
}

/**
 * Parse widget syntax from markdown content
 * Syntax: :::widget WidgetName prop="value":::
 * Returns array of { id, name, props, placeholder } objects
 */
export function parseWidgets(content) {
  const widgets = [];
  const widgetRegex = /:::widget\s+(\w+)([^:]*?):::/g;
  let match;
  let idCounter = 0;

  while ((match = widgetRegex.exec(content)) !== null) {
    const [fullMatch, name, propsStr] = match;
    const id = `help-widget-${idCounter++}`;
    widgets.push({
      id,
      name,
      props: parseWidgetProps(propsStr.trim()),
      fullMatch,
    });
  }

  return widgets;
}

/**
 * Replace widget syntax with placeholder divs for React mounting
 */
export function replaceWidgetsWithPlaceholders(content, widgets) {
  let result = content;
  for (const widget of widgets) {
    result = result.replace(
      widget.fullMatch,
      `<div data-widget-id="${widget.id}" data-widget-name="${widget.name}"></div>`
    );
  }
  return result;
}
