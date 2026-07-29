"use client";

import { clsx } from "clsx";

// ─────────────────────────────────────────────────────────────────────────────
// Skeleton — base loading placeholder component
// ─────────────────────────────────────────────────────────────────────────────
// Renders a pulsing gray block that signals content is loading.
// Mimics shadcn/ui's Skeleton pattern adapted to the project's Tailwind 4 setup.
//
// Usage:
//   <Skeleton className="h-4 w-[250px]" />
//   <Skeleton className="h-10 w-full rounded-lg" />
// ─────────────────────────────────────────────────────────────────────────────

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Whether the skeleton is visible. Default true. Set to false to hide instantly. */
  loading?: boolean;
}

export function Skeleton({ className, loading = true, ...props }: SkeletonProps) {
  if (!loading) return null;

  return (
    <div
      aria-hidden="true"
      className={clsx(
        "animate-pulse rounded-md bg-gray-200 dark:bg-white/10",
        className,
      )}
      {...props}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ShimmerBar — convenience wrapper for a single skeleton bar
// ─────────────────────────────────────────────────────────────────────────────
// Pre-sized variant used extensively by existing skeleton components.
// Accepts width and height as style properties.
// ─────────────────────────────────────────────────────────────────────────────

export function ShimmerBar({
  width = "100%",
  height = "0.85rem",
  className = "",
}: {
  width?: string | number;
  height?: string | number;
  className?: string;
}) {
  return (
    <Skeleton className={className} style={{ width, height }} />
  );
}
