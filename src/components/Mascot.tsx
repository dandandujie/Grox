import { memo, useId } from "react";
import { CURSOR_BODY, CURSOR_FIT } from "@/lib/mascot-body";
import { gradientFor } from "@/lib/mascot";
import { cn } from "@/lib/cn";

export interface MascotProps {
  color: string;
  shape?: string;
  expression?: string;
  size?: number;
  avatarUrl?: string;
  faceColor?: string | null;
  className?: string;
  animated?: boolean;
  title?: string;
}

const EYE = (cx: number, cy: number, rx = 11, ry = 17) => (
  <ellipse cx={cx} cy={cy} rx={rx} ry={ry} />
);

function eyes(expression: string, ink: string) {
  switch (expression) {
    case "happy":
      return (
        <g fill="none" stroke={ink} strokeWidth={7} strokeLinecap="round">
          <path d="M73 109 Q86 95 99 109" />
          <path d="M115 116 Q128 102 141 116" />
        </g>
      );
    case "sleeping":
    case "drowsy":
      return (
        <g fill="none" stroke={ink} strokeWidth={7} strokeLinecap="round">
          <path d="M74 107 Q86 117 98 107" />
          <path d="M116 113 Q128 123 140 113" />
        </g>
      );
    case "proud":
      return (
        <g fill="none" stroke={ink} strokeWidth={7} strokeLinecap="round">
          <path d="M74 111 Q86 99 98 111" />
          <path d="M116 117 Q128 105 140 117" />
        </g>
      );
    case "working":
      return (
        <g fill={ink}>
          <ellipse cx={86} cy={106} rx={9} ry={13} />
          <ellipse cx={128} cy={112} rx={9} ry={13} />
        </g>
      );
    case "suspicious":
      return (
        <g fill={ink}>
          <path d="M74 110 Q86 103 98 110 L98 113 Q86 108 74 113 Z" />
          <ellipse cx={128} cy={112} rx={9} ry={14} />
        </g>
      );
    case "thinking":
      return (
        <g fill={ink}>
          <ellipse cx={88} cy={102} rx={10} ry={15} />
          <ellipse cx={130} cy={108} rx={10} ry={15} />
          <path d="M68 88 Q86 81 103 88" fill="none" stroke={ink} strokeWidth={5} strokeLinecap="round" />
        </g>
      );
    case "surprised":
      return (
        <g fill={ink}>
          <circle cx={86} cy={106} r={14} />
          <circle cx={129} cy={112} r={15} />
        </g>
      );
    case "curious":
      return (
        <g fill={ink}>
          <circle cx={86} cy={106} r={11} />
          <circle cx={130} cy={112} r={15} />
          <circle cx={91} cy={101} r={3.4} fill="rgba(0,0,0,.35)" />
          <circle cx={135} cy={107} r={3.8} fill="rgba(0,0,0,.35)" />
        </g>
      );
    case "listening":
      return (
        <g fill={ink}>
          {EYE(85, 104, 11, 17)}
          {EYE(127, 111, 11, 17)}
        </g>
      );
    default:
      return (
        <g fill={ink}>
          {EYE(86, 105)}
          {EYE(128, 112)}
        </g>
      );
  }
}

function mouth(expression: string, ink: string) {
  switch (expression) {
    case "happy":
    case "proud":
      return <path d="M82 136 Q104 160 128 138" fill="none" stroke={ink} strokeWidth={7} strokeLinecap="round" />;
    case "surprised":
      return <ellipse cx={103} cy={146} rx={9} ry={12} fill="none" stroke={ink} strokeWidth={6} />;
    case "thinking":
    case "curious":
      return <ellipse cx={103} cy={146} rx={6} ry={7} fill={ink} />;
    case "suspicious":
      return <path d="M86 143 Q102 140 118 142" fill="none" stroke={ink} strokeWidth={6} strokeLinecap="round" />;
    case "sleeping":
    case "drowsy":
      return <path d="M89 145 Q103 151 118 143" fill="none" stroke={ink} strokeWidth={6} strokeLinecap="round" />;
    case "working":
      return <path d="M88 144 Q103 150 119 143" fill="none" stroke={ink} strokeWidth={6} strokeLinecap="round" />;
    case "listening":
      return <path d="M87 142 Q103 153 121 141" fill="none" stroke={ink} strokeWidth={7} strokeLinecap="round" />;
    default:
      return <path d="M86 140 Q104 154 121 140" fill="none" stroke={ink} strokeWidth={7} strokeLinecap="round" />;
  }
}

function shapeBody(shape: string, fill: string) {
  switch (shape) {
    case "circle":
      return <circle cx={114} cy={114} r={101} fill={fill} />;
    case "rounded":
      return <rect x={15} y={15} width={198} height={198} rx={58} fill={fill} />;
    case "square":
      return <rect x={16} y={16} width={196} height={196} rx={26} fill={fill} />;
    case "blob":
      return (
        <path
          fill={fill}
          d="M119 13C171 10 215 47 217 105C219 165 178 218 119 219C61 220 14 179 12 117C10 55 59 16 119 13Z"
        />
      );
    default:
      return <g transform={CURSOR_FIT} dangerouslySetInnerHTML={{ __html: CURSOR_BODY }} />;
  }
}

export const Mascot = memo(function Mascot({
  color,
  shape = "cursor",
  expression = "idle",
  size = 44,
  avatarUrl,
  faceColor,
  className,
  animated = true,
  title,
}: MascotProps) {
  const rawId = useId();
  const gradientId = "mascot-" + rawId.replace(/[^a-zA-Z0-9_-]/g, "");
  const [light, fill, dark] = gradientFor(color);
  const ink = faceColor || (color === "chrome" ? "#1E2833" : "#ffffff");
  const radius = shape === "circle" ? "50%" : shape === "square" ? "18%" : shape === "rounded" ? "27%" : "36%";

  if (avatarUrl) {
    return (
      <span
        className={cn("mascot mascot-image", className)}
        style={{ width: size, height: size, borderRadius: radius }}
        title={title}
      >
        <img src={avatarUrl} alt={title ?? ""} draggable={false} />
      </span>
    );
  }

  return (
    <svg
      className={cn("mascot", !animated && "mascot-still", className)}
      width={size}
      height={size}
      viewBox="0 0 228.541 228.541"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <linearGradient id={gradientId} x1="22%" y1="4%" x2="78%" y2="96%">
          <stop offset="0%" stopColor={light} />
          <stop offset="48%" stopColor={fill} />
          <stop offset="100%" stopColor={dark} />
        </linearGradient>
      </defs>
      <g>
        {shape === "cursor" ? (
          <g transform={CURSOR_FIT}>
            <g dangerouslySetInnerHTML={{ __html: CURSOR_BODY.replace(/url\(#body-grad\)/g, "url(#" + gradientId + ")") }} />
          </g>
        ) : (
          shapeBody(shape, "url(#" + gradientId + ")")
        )}
      </g>
      <g className="mascot-face">
        {eyes(expression, ink)}
        {mouth(expression, ink)}
      </g>
    </svg>
  );
});
