import { memo } from "react";
import { providerName, type Provider } from "./ProviderLabels";

type LibraryIconProps = {
  provider: Provider;
  name: string;
  iconSvg?: string;
  defaultIconUrl?: string;
  compact?: boolean;
  title?: string;
};

export const LibraryIcon = memo(function LibraryIcon({
  provider,
  name,
  iconSvg,
  defaultIconUrl,
  compact = false,
  title,
}: LibraryIconProps) {
  const hasCustomIcon = Boolean(iconSvg);
  const fallback = provider === "feishu"
    ? "/icons/library/feishu.webp?v=1"
    : `/icons/library/${provider}.svg${provider === "dida365" ? "?v=2" : ""}`;
  const source = iconSvg
    ? iconSvg.startsWith("data:image/")
      ? iconSvg
      : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(iconSvg)}`
    : defaultIconUrl || fallback;

  return (
    <span className={`library-icon ${provider}${compact ? " compact" : ""}${hasCustomIcon ? " custom" : ""}`} title={title || `${name} · ${providerName(provider)}`}>
      <img
        src={source}
        alt=""
        aria-hidden="true"
        draggable={false}
        onContextMenu={(event) => event.preventDefault()}
        onError={(event) => {
          if (event.currentTarget.getAttribute("src") !== fallback) event.currentTarget.src = fallback;
        }}
      />
    </span>
  );
});
