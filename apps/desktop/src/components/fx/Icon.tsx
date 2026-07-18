/* ─────────────────────────────────────────────────────────────────────────
   Custom geometric icon set — 24×24 grid, 1.5px strokes, square joints.
   No icon library: the shell draws its own instrument glyphs, the way the
   TUI draws its own chrome. Keep every glyph engineered, never playful.
   ───────────────────────────────────────────────────────────────────────── */

import type { JSX } from "react";

const paths: Record<string, JSX.Element> = {
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  arrowUp: <path d="M12 19V5M5 12l7-7 7 7" />,
  arrowRight: <path d="M5 12h14M13 5l7 7-7 7" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  chevronDown: <path d="M6 9.5l6 6 6-6" />,
  chevronRight: <path d="M9.5 6l6 6-6 6" />,
  gear: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1" />
    </>
  ),
  folder: <path d="M3.5 6.5v11a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-7.5l-2-3h-3.5a2 2 0 0 0-2 2z" />,
  mic: (
    <>
      <rect x="9" y="2.5" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3.5" />
    </>
  ),
  clip: <path d="M20.5 11.5l-7.8 7.8a5 5 0 0 1-7-7l8-8a3.3 3.3 0 0 1 4.7 4.7l-8 8a1.6 1.6 0 0 1-2.3-2.3l7.2-7.2" />,
  file: (
    <>
      <path d="M6 2.5h8l4.5 4.5V20a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 20V4A1.5 1.5 0 0 1 6 2.5z" />
      <path d="M14 2.5V7h4.5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.2" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.8" />
      <path d="M3.2 12h17.6M12 3.2c2.8 2.4 4.2 5.4 4.2 8.8s-1.4 6.4-4.2 8.8c-2.8-2.4-4.2-5.4-4.2-8.8S9.2 5.6 12 3.2z" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4.5" width="18" height="15" />
      <path d="M7 9l3.2 3L7 15M12.5 15H17" />
    </>
  ),
  bolt: <path d="M13 2.5L4.5 13.5H11l-1 8 8.5-11H12l1-8z" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.8" />
      <path d="M12 7v5.2l3.4 2" />
    </>
  ),
  edit: (
    <>
      <path d="M4.5 19.5h3.8L19 8.8a2.05 2.05 0 0 0-2.9-2.9L5.4 16.6l-.9 2.9z" />
      <path d="M13.8 8.2l2.9 2.9" />
    </>
  ),
  trash: (
    <path d="M4.5 6.5h15M9.5 6.5v-2h5v2M6.5 6.5l.9 13.2a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-13.2M10 10.5v6M14 10.5v6" />
  ),
  home: <path d="M3.5 11.5L12 3.5l8.5 8M5.5 9.8V20a1 1 0 0 0 1 1h3.8v-5.5h3.4V21h3.8a1 1 0 0 0 1-1V9.8" />,
  panelRight: (
    <>
      <rect x="3" y="4.5" width="18" height="15" />
      <path d="M14.8 4.5v15" />
    </>
  ),
  command: (
    <path d="M9 9h6v6H9zM9 9H7.2A2.2 2.2 0 1 1 9 6.8V9zM15 9h1.8A2.2 2.2 0 1 0 15 6.8V9zM9 15H7.2A2.2 2.2 0 1 0 9 17.2V15zM15 15h1.8a2.2 2.2 0 1 1-2.2 2.2V15z" />
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11.5" height="11.5" />
      <path d="M5.5 15h-1v-11.5h11.5v1" />
    </>
  ),
  play: <path d="M8 5.2l11 6.8-11 6.8V5.2z" />,
  branch: (
    <>
      <circle cx="6.5" cy="6" r="2.4" />
      <circle cx="6.5" cy="18" r="2.4" />
      <circle cx="17.5" cy="8" r="2.4" />
      <path d="M6.5 8.4v7.2M17.5 10.4c0 4.2-6.5 3.2-9 5.4" />
    </>
  ),
  refresh: (
    <>
      <path d="M20.5 12a8.5 8.5 0 1 1-2.5-6" />
      <path d="M20.5 3.5v5h-5" />
    </>
  ),
  square: <rect x="5" y="5" width="14" height="14" />,
  layers: <path d="M12 3.5l9 5-9 5-9-5 9-5zM4.2 12.7L12 17l7.8-4.3M4.2 16.7L12 21l7.8-4.3" />,
  dot: <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />,
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="3" strokeLinecap="round" />,
  pin: <path d="M8 3.5h8l-1.5 5 3 3H6.5l3-3-1.5-5zM12 11.5v9" />,
  archive: (
    <>
      <rect x="4" y="7" width="16" height="13" />
      <path d="M3 3.5h18V7H3zM9 11h6" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 21a7.5 7.5 0 0 1 15 0" />
    </>
  ),
  external: <path d="M13 4h7v7M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  alert: (
    <>
      <path d="M12 3L2.8 20h18.4L12 3z" />
      <path d="M12 9v5M12 17.5h.01" strokeLinecap="round" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
    </>
  ),
  moon: <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5z" />,
};

export interface IconProps {
  name: keyof typeof paths;
  size?: number;
  strokeWidth?: number;
  className?: string;
}

export function Icon({ name, size = 16, strokeWidth = 1.5, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="square"
      strokeLinejoin="miter"
      className={className}
      aria-hidden
    >
      {paths[name]}
    </svg>
  );
}
