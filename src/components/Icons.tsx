import type { ReactNode, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

const base = (size: number, stroke: number, fill: string): SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill,
  stroke: 'currentColor',
  strokeWidth: stroke,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
});

const mk =
  (body: ReactNode, opts: { stroke?: number; fill?: string; viewBox?: string; strokeColor?: string } = {}) =>
  ({ size = 16, ...rest }: IconProps) => {
    const b = base(size, opts.stroke ?? 1.5, opts.fill ?? 'none');
    if (opts.viewBox) b.viewBox = opts.viewBox;
    if (opts.strokeColor !== undefined) b.stroke = opts.strokeColor;
    return (
      <svg {...b} {...rest}>
        {body}
      </svg>
    );
  };

export const Icons = {
  Workspaces: mk(
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>,
  ),
  Library: mk(
    <>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </>,
  ),
  Book: mk(
    <>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      <path d="M9 7h7M9 11h5" />
    </>,
  ),
  Import: mk(
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </>,
  ),
  Secure: mk(
    <>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </>,
  ),
  Settings: mk(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>,
  ),
  Help: mk(
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </>,
  ),
  ChevronDown: mk(<polyline points="6 9 12 15 18 9" />, { stroke: 2 }),
  ChevronRight: mk(<polyline points="9 6 15 12 9 18" />, { stroke: 2 }),
  Plus: mk(
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>,
    { stroke: 2 },
  ),
  X: mk(
    <>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </>,
    { stroke: 2 },
  ),
  Dot: mk(<circle cx="12" cy="12" r="4" />, { fill: 'currentColor' }),
  Play: mk(<polygon points="6 4 20 12 6 20 6 4" />, { fill: 'currentColor' }),
  Zap: mk(<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />),
  Search: mk(
    <>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </>,
  ),
  Moon: mk(<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />),
  Sun: mk(
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </>,
  ),
  /** Two link halves — reads as "share a URL" rather than the three-dot
   *  social-share glyph, which people associate with posting to a network. */
  Share: mk(
    <>
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </>,
  ),
  Copy: mk(
    <>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>,
  ),
  Save: mk(
    <>
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </>,
  ),
  Download: mk(
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </>,
  ),
  Flow: mk(
    <path d="M1 10.5A1.5 1.5 0 002.5 12h3.879a2.5 2.5 0 001.768-.732l4.586-4.586A2.5 2.5 0 0012.268 6 1.533 1.533 0 0013.5 4.5a1.5 1.5 0 10-1.5-1.5 1.533 1.533 0 01-1.5 1.232A2.5 2.5 0 009.768 5L5.182 9.586A2.5 2.5 0 003.5 10.5H2.5A1.5 1.5 0 011 10.5z" />,
    { viewBox: '0 0 16 16', fill: 'currentColor', strokeColor: 'none' },
  ),
  Trash: mk(
    <>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </>,
  ),
  Folder: mk(<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />),
  Terminal: mk(
    <>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </>,
  ),
  Command: mk(<path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z" />),
  Braces: mk(<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1M16 21h1a2 2 0 0 0 2-2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" />),
  Key: mk(<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />),
  Activity: mk(<polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />),
  List: mk(
    <>
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </>,
  ),
  Panel: mk(
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </>,
  ),
  // Two arrows facing each other inside a split frame — "compare" / diff icon.
  Compare: mk(
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="12" y1="3" x2="12" y2="21" />
      <polyline points="7 9 5 11 7 13" />
      <polyline points="17 9 19 11 17 13" />
    </>,
  ),
  // Coffee cup — the Java tester.
  Coffee: mk(
    <>
      <path d="M17 8h1a4 4 0 1 1 0 8h-1" />
      <path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z" />
      <line x1="6" y1="1" x2="6" y2="4" />
      <line x1="10" y1="1" x2="10" y2="4" />
      <line x1="14" y1="1" x2="14" y2="4" />
    </>,
  ),
  // Package box — the Module library (reusable .dwl modules).
  Package: mk(
    <>
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
      <path d="m7.5 4.27 9 5.15" />
    </>,
  ),
  // Document with `{ }` inside — the OpenAPI / Swagger spec reader.
  ApiSpec: mk(
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1" />
      <path d="M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1" />
    </>,
  ),
  Sparkle: mk(
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" />,
  ),
  AlignLeft: mk(
    <>
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="8" y1="12" x2="20" y2="12" />
      <line x1="8" y1="18" x2="16" y2="18" />
    </>,
  ),
  FileUp: mk(
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <polyline points="14 3 14 8 19 8" />
      <line x1="12" y1="18" x2="12" y2="12" />
      <polyline points="9.5 14.5 12 12 14.5 14.5" />
    </>,
  ),
  More: mk(
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>,
    { stroke: 2 },
  ),
  Smile: mk(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14a4.5 4.5 0 0 0 7 0" />
      <line x1="9" y1="9.5" x2="9.01" y2="9.5" />
      <line x1="15" y1="9.5" x2="15.01" y2="9.5" />
    </>,
  ),
  File: mk(
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </>,
  ),
  Map: mk(
    <>
      <rect x="2.5" y="4" width="6" height="4.5" rx="1" /><rect x="15.5" y="3" width="6" height="4.5" rx="1" /><rect x="15.5" y="16.5" width="6" height="4.5" rx="1" /><rect x="9" y="12" width="6" height="4.5" rx="1" />
      <path d="M8.5 6.2c3 0 4 -1 7 -1M8.5 6.2c2 0 1 8 3.5 8M15 14.2h0.5c1.5 0 1 4.5 0 4.5" />
    </>,
  ),
  // MuleSoft's Exchange logo (exchange-logo-filled from Anypoint's icon set), to point at Exchange, as other
  // community tools do. It's MuleSoft's: not covered by this project's licence (see NOTICE).
  Exchange: mk(
    <>
      <path d="M5.315 4.902a9.807 9.807 0 0 0-.96 1.045l5.258 5.257 1.59-1.591-4.666-4.666c-.336-.337-.876-.371-1.222-.045zm13.369 14.196c.345-.325.665-.674.96-1.045L14.38 12.79l-1.591 1.59 4.672 4.673c.336.337.876.371 1.222.044z" />
      <path d="M5.96 7.552L4.357 5.947A9.709 9.709 0 0 0 2.25 12c0 2.287.787 4.39 2.106 6.053l1.605-1.604A7.466 7.466 0 0 1 4.5 12c0-1.665.543-3.203 1.46-4.448zm12.075-.002l1.607-1.606a9.707 9.707 0 0 1 2.104 6.053 9.714 9.714 0 0 1-2.102 6.056l-1.609-1.607a7.466 7.466 0 0 0 1.461-4.449 7.466 7.466 0 0 0-1.46-4.448z" />
      <path d="M19.643 5.947a9.802 9.802 0 0 0-.959-1.045c-.346-.326-.886-.292-1.222.045L4.355 18.053c.295.371.615.72.96 1.044.346.327.886.293 1.222-.044L19.644 5.947z" />
    </>,
    { fill: 'currentColor', stroke: 0 },
  ),
  // MuleSoft's Design Center logo, from the same icon set, to point at Design Center (see NOTICE). Its three
  // shades become three opacities of the current colour.
  DesignCenter: mk(
    <>
      <path opacity={0.55} d="M12 21.75c5.385 0 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25H8.414a.938.938 0 0 0-.81.465l-.63 1.08a.469.469 0 0 0 .405.705H12a7.5 7.5 0 0 1 0 15H7.379a.469.469 0 0 0-.405.705l.63 1.08a.938.938 0 0 0 .81.465H12Z" />
      <path opacity={0.8} d="M5.837 6.75a.938.938 0 0 0-.811.467l-2.503 4.312a.938.938 0 0 0 0 .942l2.503 4.312a.938.938 0 0 0 .81.467h5.015a.937.937 0 0 0 .81-.467l.627-1.079a.469.469 0 0 0-.405-.704H6.825a.375.375 0 0 1-.325-.187l-1.517-2.625a.375.375 0 0 1 0-.376L6.5 9.187A.375.375 0 0 1 6.826 9h5.057a.469.469 0 0 0 .405-.704l-.626-1.08a.937.937 0 0 0-.811-.466H5.837Z" />
      <path d="M10.232 12.187a.375.375 0 0 1 0-.374l.863-1.5a.375.375 0 0 1 .325-.188h1.723c.134 0 .258.072.325.188l.862 1.5a.375.375 0 0 1 0 .374l-.862 1.5a.375.375 0 0 1-.325.188H11.42a.375.375 0 0 1-.325-.188l-.863-1.5Z" />
    </>,
    { fill: 'currentColor', stroke: 0 },
  ),
  Deps: mk(
    <>
      <circle cx="5" cy="5" r="2" /><circle cx="19" cy="5" r="2" /><circle cx="5" cy="19" r="2" /><circle cx="19" cy="19" r="2" /><circle cx="12" cy="12" r="2.5" />
      <path d="M6.5 6.5l3.7 3.7M17.5 6.5l-3.7 3.7M6.5 17.5l3.7-3.7M17.5 17.5l-3.7-3.7" />
    </>,
  ),
  Branch: mk(
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="7" r="2" />
      <path d="M6 7v10M18 9c0 5-6 4-11.5 8" />
    </>,
  ),
  Target: mk(
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
    </>,
  ),
  Lock: mk(
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>,
  ),
  Check: mk(<path d="M20 6 9 17l-5-5" />),
  Sliders: mk(
    <>
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="18" cy="18" r="2" />
    </>,
  ),
};

export type IconName = keyof typeof Icons;
