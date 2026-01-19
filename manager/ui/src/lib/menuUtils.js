/**
 * Shared utility for building hierarchical menu structures from flat JSON data.
 * Items with a `parent` field become children of the specified parent.
 */

/**
 * Build a hierarchical menu structure from a flat array of sections.
 * @param {Array} sections - Flat array with optional `parent` field
 * @returns {Array} Hierarchical array with nested `children` arrays
 */
export function buildMenuStructure(sections) {
  const map = new Map();
  const roots = [];

  // First pass: create map entries with empty children arrays
  sections.forEach(s => map.set(s.id, { ...s, children: [] }));

  // Second pass: build hierarchy
  sections.forEach(s => {
    const item = map.get(s.id);
    if (s.parent && map.has(s.parent)) {
      map.get(s.parent).children.push(item);
    } else if (!s.parent) {
      roots.push(item);
    }
  });

  // Clean up: remove empty children arrays
  map.forEach(item => {
    if (item.children.length === 0) delete item.children;
    delete item.parent; // Remove parent field from output
  });

  return roots;
}

/**
 * Find the parent ID for a given section ID in the menu structure.
 * @param {Array} menuStructure - Hierarchical menu structure
 * @param {string} sectionId - Section ID to find parent for
 * @returns {string|null} Parent ID or null if not found or no parent
 */
export function findParentId(menuStructure, sectionId) {
  for (const item of menuStructure) {
    if (item.children) {
      if (item.children.some(child => child.id === sectionId)) {
        return item.id;
      }
    }
  }
  return null;
}

/**
 * Get all leaf sections (sections without children) from the menu structure.
 * @param {Array} menuStructure - Hierarchical menu structure
 * @returns {Array} Flat array of leaf sections
 */
export function getAllLeafSections(menuStructure) {
  const sections = [];
  menuStructure.forEach(item => {
    if (item.children) {
      sections.push(...item.children);
    } else {
      sections.push(item);
    }
  });
  return sections;
}

/**
 * Check if a section ID belongs to a parent item or its children.
 * @param {Object} parentItem - Parent menu item
 * @param {string} sectionId - Section ID to check
 * @returns {boolean} True if sectionId is the parent or one of its children
 */
export function isItemActive(parentItem, sectionId) {
  if (parentItem.children) {
    return parentItem.children.some(child => child.id === sectionId);
  }
  return parentItem.id === sectionId;
}
