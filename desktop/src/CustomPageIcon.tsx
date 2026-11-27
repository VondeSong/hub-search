import { forwardRef, type SVGProps } from "react";

export const CUSTOM_PAGE_ICON_PATH =
  "M9.17 8.508h5.67a.51.51 0 0 0 .376-.152.504.504 0 0 0 .151-.37c0-.14-.05-.258-.151-.356a.518.518 0 0 0-.376-.147H9.17a.53.53 0 0 0-.386.147.478.478 0 0 0-.151.356.521.521 0 0 0 .537.522Zm0 2.59h5.67a.516.516 0 0 0 .527-.531c0-.14-.05-.258-.151-.356a.518.518 0 0 0-.376-.147H9.17a.53.53 0 0 0-.386.147.478.478 0 0 0-.151.356.516.516 0 0 0 .537.531Zm0 2.582h2.654c.15 0 .275-.05.376-.147a.478.478 0 0 0 .151-.356.505.505 0 0 0-.15-.37.51.51 0 0 0-.377-.152H9.17a.521.521 0 0 0-.537.522c0 .139.05.258.151.356.101.098.23.147.386.147Zm-3.67 3.9c0 .81.203 1.416.61 1.817.407.402 1.02.603 1.84.603h8.09c.82 0 1.435-.2 1.845-.603.41-.401.615-1.007.615-1.817V6.42c0-.804-.205-1.408-.615-1.813C17.475 4.202 16.86 4 16.04 4H7.95c-.82 0-1.433.202-1.84.607-.407.405-.61 1.01-.61 1.813v11.16Zm1.405-.019V6.44c0-.342.095-.606.283-.793.19-.186.469-.28.84-.28h7.944c.365 0 .641.094.83.28.189.187.283.451.283.793V17.56c0 .342-.095.606-.283.793-.189.186-.465.28-.83.28H8.028c-.371 0-.65-.094-.84-.28-.188-.187-.283-.451-.283-.793Z";

export type CustomPageIconProps = Omit<SVGProps<SVGSVGElement>, "children"> & {
  size?: number | string;
  strokeWidth?: number | string;
  absoluteStrokeWidth?: boolean;
};

/**
 * Unified custom SVG page icon matching the prototype's `replaceCustomPageIcons`
 * (Apple SF Symbols doc.text silhouette, viewBox 2.5 2 19 20, currentColor fill).
 */
export const CustomPageIcon = forwardRef<SVGSVGElement, CustomPageIconProps>(
  function CustomPageIcon(
    { size = 16, strokeWidth: _strokeWidth, absoluteStrokeWidth: _absoluteStrokeWidth, ...props },
    ref,
  ) {
    return (
      <svg
        ref={ref}
        width={size}
        height={size}
        viewBox="2.5 2 19 20"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        {...props}
      >
        <path d={CUSTOM_PAGE_ICON_PATH} fill="currentColor" />
      </svg>
    );
  },
);
