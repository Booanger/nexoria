/**
 * Parses the raw text from the event modal template.
 * Supported formats:
 * 
 * Category:
 * #Category Name
 * 
 * Simple slot:
 * Role Name
 * 
 * Detailed slot:
 * Role Name > Build / Gear descriptions
 * 
 * @param {string} text - Raw input text
 * @returns {Array<{id: string, name: string, build: string, category: string|null, userId: string|null, username: string|null}>}
 */
export function parseTemplate(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }

  const lines = text.split(/\r?\n/);
  const slots = [];
  let currentCategory = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Kategori kontrolü (örn: #Tanks)
    if (trimmed.startsWith('#')) {
      currentCategory = trimmed.substring(1).trim();
      continue;
    }

    let roleName = trimmed;
    let build = '';

    // Gelişmiş format kontrolü (örn: Mace > Cleric cowl - Armor of valor)
    if (trimmed.includes('>')) {
      const parts = trimmed.split('>');
      roleName = parts[0].trim();
      build = parts.slice(1).join('>').trim();
    }

    slots.push({
      id: Math.random().toString(36).substring(2, 11), // Unique slot ID
      name: roleName,
      build: build,
      category: currentCategory,
      userId: null,
      username: null
    });
  }

  return slots;
}

/**
 * Groups slots by their category.
 * @param {Array<object>} slots 
 * @returns {Record<string, Array<object>>}
 */
export function groupSlotsByCategory(slots) {
  const groups = {};
  for (const slot of slots) {
    const category = slot.category || 'Genel';
    if (!groups[category]) {
      groups[category] = [];
    }
    groups[category].push(slot);
  }
  return groups;
}

/**
 * Reconstructs raw template text from current slots.
 * @param {Array<object>} slots 
 * @returns {string}
 */
export function reconstructTemplate(slots) {
  if (!slots || slots.length === 0) return '';
  
  let text = '';
  let currentCategory = undefined;

  for (const slot of slots) {
    if (slot.category !== currentCategory) {
      currentCategory = slot.category;
      if (currentCategory) {
        text += `#${currentCategory}\n`;
      }
    }
    text += slot.name;
    if (slot.build) {
      text += ` > ${slot.build}`;
    }
    text += '\n';
  }

  return text.trim();
}
