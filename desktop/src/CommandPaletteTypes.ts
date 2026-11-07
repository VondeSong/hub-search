export type CommandCategory = "navigation" | "library" | "search" | "result" | "view";

export type CommandPaletteItem = {
  id: string;
  label: string;
  description: string;
  category: CommandCategory;
  keywords?: string[];
  shortcut?: string;
  disabled?: boolean;
  run: () => void | Promise<void>;
};

export type ShortcutHelpGroup = {
  title: string;
  items: Array<{ keys: string[]; label: string }>;
};

export type CommandPaletteMode = "commands" | "shortcuts";

function commandSearchText(item: CommandPaletteItem): string {
  return [item.label, item.description, ...(item.keywords ?? [])].join(" ").toLocaleLowerCase();
}

export function filterCommandItems(items: CommandPaletteItem[], query: string): CommandPaletteItem[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return items;
  return items
    .flatMap((item) => {
      const label = item.label.toLocaleLowerCase();
      const text = commandSearchText(item);
      if (!text.includes(needle)) return [];
      const score = label === needle ? 0 : label.startsWith(needle) ? 1 : label.includes(needle) ? 2 : 3;
      return [{ item, score }];
    })
    .sort((left, right) => left.score - right.score || Number(left.item.disabled) - Number(right.item.disabled))
    .map(({ item }) => item);
}
