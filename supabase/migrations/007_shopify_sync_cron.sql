-- ════════════════════════════════════════════════════════════════════
-- Migration 007 : Cron job pour synchroniser les commandes Shopify
-- ════════════════════════════════════════════════════════════════════
-- DATE : 2026-05-29
-- BUT  : Appeler l'Edge Function `shopify-sync` toutes les 10 minutes
--        pour importer les nouvelles commandes du site maxiconfort.fr
--
-- ⚠ PRE-REQUIS :
--   1. L'Edge Function `shopify-sync` doit etre deployee (dashboard
--      Supabase > Edge Functions > shopify-sync)
--   2. Les secrets de la function doivent etre configures :
--      - SHOPIFY_STORE_DOMAIN
--      - SHOPIFY_ACCESS_TOKEN
--      - SHOPIFY_API_VERSION
--   3. La ligne `last_shopify_sync` doit etre initialisee dans la table
--      `parametres` (sinon, la 1ere sync va importer les commandes
--      de la derniere heure).
--
-- IMPORTANT : Remplacer SERVICE_ROLE_KEY_ICI par la vraie cle service_role
-- (recuperable sur Settings > API > service_role secret).
-- ════════════════════════════════════════════════════════════════════

-- Extensions necessaires (gratuites sur Supabase free tier)
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Initialiser le timestamp de derniere sync a maintenant
-- (n'importe que les commandes creees apres cette migration)
INSERT INTO public.parametres (cle, valeur, updated_at)
VALUES ('last_shopify_sync', NOW()::text, NOW())
ON CONFLICT (cle) DO NOTHING;

-- Si un ancien job existe, le supprimer pour eviter doublon
SELECT cron.unschedule('shopify-sync-every-10min')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'shopify-sync-every-10min'
);

-- Programmer la sync toutes les 10 minutes
SELECT cron.schedule(
  'shopify-sync-every-10min',
  '*/10 * * * *',
  $job$
  SELECT net.http_post(
    url     := 'https://jmvfjtnmebstkzcfnlgp.supabase.co/functions/v1/shopify-sync',
    headers := jsonb_build_object(
      'Authorization', 'Bearer SERVICE_ROLE_KEY_ICI',
      'Content-Type',  'application/json'
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) AS req_id
  $job$
);

-- Verification : voir le job programme
SELECT jobid, jobname, schedule, command
FROM cron.job
WHERE jobname = 'shopify-sync-every-10min';
