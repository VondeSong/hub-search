import type { ComponentType } from "react";

export type MobileTabItem = {
  key: string;
  label: string;
  icon: ComponentType<{ size?: number; "aria-hidden"?: "true" }>;
  count?: number;
  countLabel?: string;
};

/** The library and flashcard routes share geometry, selection and touch feedback. */
export function MobileTabBar({ items, active, onSelect, label, className = "" }: {
  items: readonly MobileTabItem[];
  active: string;
  onSelect: (key: string) => void;
  label: string;
  className?: string;
}) {
  return <nav className={`mobile-primary-navigation mobile-tab-bar ${className}`} aria-label={label}>
    {items.map(({ key, label: itemLabel, icon: Icon, count, countLabel }) => <button
      type="button" key={key} aria-label={countLabel && count ? `${itemLabel}，${countLabel} ${count} 张` : itemLabel}
      aria-current={active === key ? "page" : undefined}
      onClick={() => onSelect(key)}
    >
      <span className="mobile-primary-icon"><Icon size={21} aria-hidden="true" />{Boolean(count && count > 0) && <small>{count! > 99 ? "99+" : count}</small>}</span>
      <span>{itemLabel}</span>
    </button>)}
  </nav>;
}
