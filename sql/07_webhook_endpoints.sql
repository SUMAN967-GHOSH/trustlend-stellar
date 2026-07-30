-- TrustLend schema for Webhook Endpoints
-- Add these columns to store Discord/Telegram webhook integrations

CREATE TABLE IF NOT EXISTS public.webhook_endpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('discord', 'telegram', 'slack', 'custom')),
    topic TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ensure URL is valid (basic validation)
ALTER TABLE public.webhook_endpoints
  ADD CONSTRAINT valid_webhook_url CHECK (url LIKE 'https://%');

-- Indexes
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_platform ON public.webhook_endpoints(platform);
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_topic ON public.webhook_endpoints(topic);

-- Trigger for updated_at
DROP TRIGGER IF EXISTS trg_webhook_endpoints_updated_at ON public.webhook_endpoints;
CREATE TRIGGER trg_webhook_endpoints_updated_at
BEFORE UPDATE ON public.webhook_endpoints
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS Policies
ALTER TABLE public.webhook_endpoints ENABLE ROW LEVEL SECURITY;

-- Only Admins can manage webhooks
CREATE POLICY "Admins can view webhooks"
  ON public.webhook_endpoints
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles 
      WHERE profiles.id = auth.uid() 
      AND profiles.role = 'admin'
    )
  );

CREATE POLICY "Admins can insert webhooks"
  ON public.webhook_endpoints
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles 
      WHERE profiles.id = auth.uid() 
      AND profiles.role = 'admin'
    )
  );

CREATE POLICY "Admins can update webhooks"
  ON public.webhook_endpoints
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles 
      WHERE profiles.id = auth.uid() 
      AND profiles.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles 
      WHERE profiles.id = auth.uid() 
      AND profiles.role = 'admin'
    )
  );

CREATE POLICY "Admins can delete webhooks"
  ON public.webhook_endpoints
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles 
      WHERE profiles.id = auth.uid() 
      AND profiles.role = 'admin'
    )
  );
