/**
 * SynChem Global's mark and wordmark, drawn as SVG.
 *
 * Redrawn rather than shipped as a bitmap: it stays crisp at every size, needs
 * no asset request, and the three facets can pick up `currentColor` where the
 * surface demands it. The colours are sampled from the real logo —
 * red #D51B29, ink #303030, cyan #00A0E0.
 *
 * If an exact copy of the original file is ever required, drop it into
 * `public/` and swap `<Mark />` for an `<img>`; nothing else needs to change.
 */

export function Mark({ size = 32, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size * 0.82}
      viewBox="0 0 64 52"
      className={className}
      role="img"
      aria-label="SynChem Global"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* left facet — red */}
      <path d="M31 2 L6 47 L19.5 47 L31 24.5 Z" fill="#D51B29" />
      {/* centre facet — ink, the shadowed inner face */}
      <path d="M31 24.5 L19.5 47 L40 47 Z" fill="#303030" />
      {/* right facet — cyan, the wider wing */}
      <path d="M31 2 L58 47 L40 47 L31 24.5 Z" fill="#00A0E0" />
    </svg>
  );
}

/** Mark plus wordmark, for the sidebar and any full-brand placement. */
export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <Mark size={compact ? 26 : 34} />
      <span className="leading-none">
        <span className="block text-[17px] font-semibold tracking-tight text-slate-800">synchem</span>
        <span className="mt-[3px] flex items-center gap-1.5">
          <span className="h-px w-3 bg-slate-300" aria-hidden />
          <span className="text-[9px] font-medium uppercase tracking-[0.22em] text-slate-500">Global</span>
          <span className="h-px w-3 bg-slate-300" aria-hidden />
        </span>
      </span>
    </span>
  );
}
