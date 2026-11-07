export const TAG_COLOR_PALETTE = [
  "#4C8FD4",
  "#7659D6",
  "#55AD78",
  "#EF8B49",
  "#E4B13E",
  "#48A7B5",
  "#D95C5C",
  "#858782",
] as const;

export type TagUserProperty = {
  color?: string;
  description?: string;
  parent?: string;
  aliases?: string[];
};

export type TagUserPropertyMap = Record<string, TagUserProperty>;

export function isTagColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

export function defaultTagColor(normalizedName: string): string {
  let hash = 0;
  for (const character of normalizedName) hash = ((hash * 31) + character.codePointAt(0)!) >>> 0;
  return TAG_COLOR_PALETTE[hash % TAG_COLOR_PALETTE.length];
}

export function resolveTagColor(properties: TagUserPropertyMap, normalizedName: string): string {
  const stored = properties[normalizedName]?.color;
  return isTagColor(stored) ? stored.toUpperCase() : defaultTagColor(normalizedName);
}

export function parseTagUserProperties(value: string | null): TagUserPropertyMap {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([tagId, raw]) => {
      if (!tagId.trim() || !raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const candidate = raw as Record<string, unknown>;
      const property: TagUserProperty = {};
      if (isTagColor(candidate.color)) property.color = candidate.color.toUpperCase();
      if (typeof candidate.description === "string" && candidate.description.trim()) {
        property.description = candidate.description.trim().slice(0, 240);
      }
      if (typeof candidate.parent === "string" && candidate.parent.trim()) {
        property.parent = candidate.parent.trim().slice(0, 120);
      }
      if (Array.isArray(candidate.aliases)) {
        const aliases = [...new Set(candidate.aliases
          .filter((alias): alias is string => typeof alias === "string" && Boolean(alias.trim()))
          .map((alias) => alias.trim().slice(0, 120)))].slice(0, 20);
        if (aliases.length) property.aliases = aliases;
      }
      return Object.keys(property).length ? [[tagId, property]] : [];
    }));
  } catch {
    return {};
  }
}
