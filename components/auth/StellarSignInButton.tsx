"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { signInWithStellar } from "@/lib/auth/siws-client";
import { getDashboardPath } from "@/lib/auth/roles";

interface StellarSignInButtonProps {
  className?: string;
  disabled?: boolean;
}

/**
 * "Sign in with Stellar" (SIWS / SEP-0010) button. Drives the wallet challenge
 * → sign → verify flow and, on success, routes to the user's dashboard.
 */
export function StellarSignInButton({ className, disabled }: StellarSignInButtonProps) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const { role } = await signInWithStellar();
      router.push(getDashboardPath(role));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Stellar sign-in failed.");
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      <button
        type="button"
        id="siws-auth-btn"
        className={className ?? "auth-page-google-btn"}
        onClick={handleClick}
        disabled={isLoading || disabled}
      >
        {isLoading ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
            <path d="M12 2 3 6.5v11L12 22l9-4.5v-11L12 2Zm0 2.3 6.6 3.3-6.6 3.3-6.6-3.3L12 4.3ZM5 9.2l6 3v6.6l-6-3V9.2Zm14 0v6.6l-6 3v-6.6l6-3Z" />
          </svg>
        )}
        <span>{isLoading ? "Waiting for wallet…" : "Sign in with Stellar"}</span>
      </button>
      {error ? (
        <p className="text-xs text-red-500" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
