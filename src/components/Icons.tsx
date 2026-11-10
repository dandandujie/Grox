import {
  siCloudflare, siDiscord, siFigma, siGithub, siGmail, siGoogledocs, siGoogledrive,
  siGooglecalendar, siGooglesheets, siGoogle, siLinear, siNotion, siPostgresql,
  siSentry, siSpotify, siStripe, siTelegram, siVercel, siX, siZapier, siAnthropic,
} from "simple-icons";
import { Cpu } from "lucide-react";
import { cn } from "@/lib/cn";

type IconData = { path: string; hex: string; title?: string };

const APP_ICONS: Record<string, IconData> = {
  github: siGithub,
  gmail: siGmail,
  "google-calendar": siGooglecalendar,
  "google-sheets": siGooglesheets,
  "google-docs": siGoogledocs,
  "google-drive": siGoogledrive,
  notion: siNotion,
  linear: siLinear,
  sentry: siSentry,
  figma: siFigma,
  stripe: siStripe,
  spotify: siSpotify,
  x: siX,
  discord: siDiscord,
  telegram: siTelegram,
  postgres: siPostgresql,
  vercel: siVercel,
  cloudflare: siCloudflare,
  zapier: siZapier,
} as Record<string, IconData>;

function SlackMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#E01E5A" d="M5.1 15.1a2.1 2.1 0 1 1-2.1-2.1h2.1v2.1Zm1.1 0a2.1 2.1 0 0 1 4.2 0v5.2a2.1 2.1 0 1 1-4.2 0v-5.2Z" />
      <path fill="#36C5F0" d="M8.3 5.2a2.1 2.1 0 1 1 2.1-2.1v2.1H8.3Zm0 1.1a2.1 2.1 0 0 1 0 4.2H3.1a2.1 2.1 0 0 1 0-4.2h5.2Z" />
      <path fill="#2EB67D" d="M18.9 8.3a2.1 2.1 0 1 1 2.1 2.1h-2.1V8.3Zm-1.1 0a2.1 2.1 0 0 1-4.2 0V3.1a2.1 2.1 0 1 1 4.2 0v5.2Z" />
      <path fill="#ECB22E" d="M15.7 18.9a2.1 2.1 0 1 1-2.1 2.1v-2.1h2.1Zm0-1.1a2.1 2.1 0 0 1 0-4.2h5.2a2.1 2.1 0 0 1 0 4.2h-5.2Z" />
    </svg>
  );
}

function GoogleGlyph({ kind, size, className }: { kind: string; size: number; className?: string }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", className, "aria-hidden": true } as const;
  if (kind === "gmail") {
    return (
      <svg {...common}>
        <rect x="2" y="5" width="20" height="14" rx="2" fill="#f6f7f8" />
        <path fill="#4285F4" d="M2 6.5 4.6 5H6v13.4H3.2A1.2 1.2 0 0 1 2 17.2V6.5Z" />
        <path fill="#34A853" d="M22 6.5 19.4 5H18v13.4h2.8c.66 0 1.2-.54 1.2-1.2V6.5Z" />
        <path fill="#EA4335" d="m3 6 9 6.8L21 6v2.2l-9 6.8-9-6.8V6Z" />
        <path fill="#FBBC04" d="m3 18 7-5.3v5.3H3Z" />
      </svg>
    );
  }
  if (kind === "google-calendar") {
    return (
      <svg {...common}>
        <rect x="2.5" y="3" width="19" height="18.5" rx="3" fill="#4285F4" />
        <rect x="5" y="6.5" width="14" height="12.5" rx="1.4" fill="#fff" opacity="0.96" />
        <text x="12" y="16.2" textAnchor="middle" fontSize="8.6" fontWeight="650" fill="#1a73e8">31</text>
        <rect x="2.5" y="3" width="19" height="3.4" rx="1.7" fill="#1967D2" />
      </svg>
    );
  }
  if (kind === "google-sheets") {
    return (
      <svg {...common}>
        <path fill="#0F9D58" d="M5 2h9l5 5v15H5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" />
        <path fill="#0B8043" d="M14 2l5 5h-5V2Z" />
        <path fill="#fff" d="M7.4 9.2h9.2v1.4H7.4zM7.4 12h9.2v1.4H7.4zM7.4 14.8h9.2v1.4H7.4zM10.8 9.2h1.4v7H10.8zM14.2 9.2h1.4v7h-1.4z" />
      </svg>
    );
  }
  if (kind === "google-docs") {
    return (
      <svg {...common}>
        <path fill="#4285F4" d="M5 2h9l5 5v15H5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" />
        <path fill="#1967D2" d="M14 2l5 5h-5V2Z" />
        <path fill="#fff" d="M7.6 9.4h8.8v1.3H7.6zM7.6 12.1h8.8v1.3H7.6zM7.6 14.8h6v1.3h-6z" />
      </svg>
    );
  }
  if (kind === "google-drive") {
    return (
      <svg {...common}>
        <path fill="#FBBC04" d="M8.4 2.5h7.2l6.9 12h-7.2l-6.9-12Z" />
        <path fill="#34A853" d="M8.4 2.5 1.5 14.5 5 20.5l6.9-12-3.5-6Z" />
        <path fill="#4285F4" d="M5 20.5h14l3.5-6H8.5l-3.5 6Z" />
      </svg>
    );
  }
  return null;
}

export function BrandIcon({ slug, size = 22, className }: { slug: string; size?: number; className?: string }) {
  const google = GoogleGlyph({ kind: slug, size, className });
  if (google) return google;
  if (slug === "slack") return <span className={className}><SlackMark size={size} /></span>;
  if (slug === "openai") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
        <g fill="none" stroke="#10a37f" strokeWidth={1.6} strokeLinecap="round">
          <path d="M12 3.4c2 0 3.7 1 4.6 2.5m-9.2 0C6.7 7.2 6.6 9.3 7.5 11M4.7 15c-1-1.7-.6-3.8.7-5.1m2.1 9.7c-1.7-1-2.5-3.1-2-5m4.9 6.3c1.6 1 3.8.7 5.1-.6m-3.4-9.9c1.7-1 3.9-.5 5.1.9m-9.4 2.4 4.3 2.5 4.4-2.5m-8.7 2.5v5l4.3 2.5 4.4-2.5v-5" />
        </g>
      </svg>
    );
  }
  const icon = APP_ICONS[slug];
  if (!icon) {
    return (
      <span className={cn("app-icon-fallback", className)} style={{ width: size, height: size }}>
        {slug.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} role="img" aria-label={icon.title ?? slug}>
      <path d={icon.path} fill={"#" + icon.hex} />
    </svg>
  );
}

export function ProviderMark({ provider, size = 18, className }: { provider: string; size?: number; className?: string }) {
  switch (provider) {
    case "grok":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
          <path fill="currentColor" d="M18.9 2h3.3l-7.2 8.2L23.4 22h-6.6l-5.2-6.8L5.7 22H2.4l7.7-8.8L1.9 2h6.7l4.7 6.2L18.9 2Zm-1.2 17.9h1.8L6.5 3.9H4.6l13.1 16Z" />
        </svg>
      );
    case "claude":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
          <g fill="#d97757">
            <path d="M11.2 2h1.6l.3 7.2 6.3-3.4.8 1.4-6.2 3.7 6.2 3.7-.8 1.4-6.3-3.4-.3 7.2h-1.6l-.3-7.2-6.3 3.4-.8-1.4 6.2-3.7-6.2-3.7.8-1.4 6.3 3.4L11.2 2Z" />
          </g>
        </svg>
      );
    case "openai":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
          <g fill="none" stroke="#74aa9c" strokeWidth={1.7} strokeLinecap="round">
            <path d="M12 3.2 18.7 7v8L12 18.8 5.3 15V7L12 3.2Z" />
            <path d="M5.3 7 12 10.9 18.7 7M12 10.9v7.9" />
          </g>
        </svg>
      );
    case "google":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" className={className} role="img" aria-label="Google">
          <path fill={"#" + siGoogle.hex} d={siGoogle.path} />
        </svg>
      );
    case "local":
      return <Cpu size={size} className={className} aria-hidden="true" />;
    case "api":
      return <Cpu size={size} className={className} aria-hidden="true" />;
    default:
      return <Cpu size={size} className={className} aria-hidden="true" />;
  }
}

export function GroxLogo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="grox-logo">
      <defs>
        <linearGradient id="grox-logo-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#9FE6B5" />
          <stop offset="50%" stopColor="#009957" />
          <stop offset="100%" stopColor="#005C36" />
        </linearGradient>
      </defs>
      <path fill="url(#grox-logo-grad)" d="M16.6 2.2c6 0 11 3.4 12.3 8.8.8 3.5-.5 6.6-3 8.8l2.5 7.4c.4 1.2-.8 2.3-2 1.8l-6.3-2.8c-1.4.3-2.9.5-4.4.5-6.4 0-11.5-3.8-12.5-9.6C2.2 10.7 6.6 4.9 13 2.7c1.2-.4 2.4-.5 3.6-.5Z" />
      <ellipse cx="13" cy="13.2" rx="1.7" ry="2.6" fill="#fff" />
      <ellipse cx="19.4" cy="14.2" rx="1.7" ry="2.6" fill="#fff" />
      <path d="M13.8 18.6c1.6 1.3 3.5 1.3 5.1 0" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
