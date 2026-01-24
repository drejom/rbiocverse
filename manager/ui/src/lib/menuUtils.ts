/**
 * Shared utility for building hierarchical menu structures from flat JSON data.
 * Items with a `parent` field become children of the specified parent.
 */

export interface MenuSection {
  id: string;
  parent?: string;
  title?: string;
  icon?: string;
  [key: string]: unknown;
}

export interface MenuItem extends Omit<MenuSection, 'parent'> {
  children?: MenuItem[];
}

/**
 * Build a hierarchical menu structure from a flat array of sections.
 */
export function buildMenuStructure(sections: MenuSection[]): MenuItem[] {
  const map = new Map<string, MenuItem>();
  const roots: MenuItem[] = [];

  // First pass: create map entries with empty children arrays
  sections.forEach(s => {
    const item: MenuItem = { ...s, children: [] };
    delete (item as { parent?: string }).parent;
    map.set(s.id, item);
  });

  // Second pass: build hierarchy
  sections.forEach(s => {
    const item = map.get(s.id)!;
    if (s.parent && map.has(s.parent)) {
      map.get(s.parent)!.children!.push(item);
    } else if (!s.parent) {
      roots.push(item);
    }
  });

  // Clean up: remove empty children arrays
  map.forEach(item => {
    if (item.children && item.children.length === 0) {
      delete item.children;
    }
  });

  return roots;
}

/**
 * Find the parent ID for a given section ID in the menu structure.
 */
export function findParentId(menuStructure: MenuItem[], sectionId: string): string | null {
  for (const item of menuStructure) {
    if (item.children) {
      if (item.children.some(child => child.id === sectionId)) {
        return item.id as string;
      }
    }
  }
  return null;
}

/**
 * Get all leaf sections (sections without children) from the menu structure.
 */
export function getAllLeafSections(menuStructure: MenuItem[]): MenuItem[] {
  const sections: MenuItem[] = [];
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
 */
export function isItemActive(parentItem: MenuItem, sectionId: string): boolean {
  if (parentItem.children) {
    return parentItem.children.some(child => child.id === sectionId);
  }
  return parentItem.id === sectionId;
}
