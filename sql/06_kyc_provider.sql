-- =====================================================================
-- TrustLend: Issue #118 — KYC Provider Integration
-- Adds columns for 3rd-party KYC provider (SumSub-compatible) linkage
-- and regulated pool access flag.
-- Apply after 01_core_schema.sql
-- =====================================================================

-- 1. New columns on profiles for provider linkage
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS kyc_provider_id        TEXT,          -- SumSub applicantId
  ADD COLUMN IF NOT EXISTS kyc_provider_status    TEXT,          -- raw provider status string
  ADD COLUMN IF NOT EXISTS regulated_pool_access  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS date_of_birth          DATE;

-- 2. Index for fast provider-ID lookup (webhook resolution)
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_kyc_provider_id
  ON public.profiles (kyc_provider_id)
  WHERE kyc_provider_id IS NOT NULL;

-- 3. Index for regulated pool access queries
CREATE INDEX IF NOT EXISTS idx_profiles_regulated_pool_access
  ON public.profiles (regulated_pool_access);

-- 4. Ensure 'submitted' value exists in kyc_status enum (idempotent)
DO $$
BEGIN
  ALTER TYPE public.kyc_status ADD VALUE IF NOT EXISTS 'submitted';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 5. RLS: only service-role / admin can write kyc_provider_id and regulated_pool_access
--    (users can write their own profile fields but NOT these sensitive ones)

DROP POLICY IF EXISTS "Service role can write kyc provider fields" ON public.profiles;

-- Supabase service role bypasses RLS automatically; this policy is for
-- completeness and to document intent. Regular users cannot set these.
CREATE POLICY "Service role can write kyc provider fields"
  ON public.profiles
  FOR UPDATE
  USING (
    -- Only service role (no JWT) or admin role can update provider fields
    (auth.uid() IS NULL)   -- service role has no JWT
    OR EXISTS (
      SELECT 1 FROM public.profiles AS p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  )
  WITH CHECK (
    (auth.uid() IS NULL)
    OR EXISTS (
      SELECT 1 FROM public.profiles AS p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

-- 6. View: regulated_kyc_queue for admin monitoring
CREATE OR REPLACE VIEW public.regulated_kyc_queue AS
SELECT
  id,
  full_name,
  kyc_status,
  kyc_provider_id,
  kyc_provider_status,
  regulated_pool_access,
  kyc_submitted_at,
  kyc_verified_at,
  kyc_rejection_reason
FROM public.profiles
WHERE kyc_status IN ('submitted', 'verified', 'rejected')
ORDER BY kyc_submitted_at DESC NULLS LAST;

COMMENT ON VIEW public.regulated_kyc_queue IS
  'Admin-only view of KYC applicants linked to the 3rd-party provider.';
