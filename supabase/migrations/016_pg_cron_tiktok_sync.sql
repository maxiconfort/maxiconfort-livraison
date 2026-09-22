-- Migration 016 : pg_cron pour tiktok-sync (import automatique des commandes TikTok Shop)
-- Date : 2026-09-22 — même mécanique que shopify-sync (migration 007) et 015.
--
-- Toutes les 10 minutes : l'Edge Function `tiktok-sync` lit les commandes
-- TikTok « en attente d'expédition » via l'API TikTok Shop (jeton dans
-- `parametres`, clés tiktok_*) et crée les commandes manquantes dans
-- `commandes` (transporteur GLS forcé, paiement « TikTok Shop » / Payé).
-- Ensuite `gls-auto-etiquette` (cron 5 min) crée l'étiquette GLS comme pour
-- une commande du site.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tiktok-sync-every-10min') THEN
    PERFORM cron.unschedule('tiktok-sync-every-10min');
  END IF;
END $$;

SELECT cron.schedule(
  'tiktok-sync-every-10min',
  '*/10 * * * *',
  $job$
    SELECT net.http_post(
      url := 'https://jmvfjtnmebstkzcfnlgp.supabase.co/functions/v1/tiktok-sync',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          SELECT decrypted_secret FROM vault.decrypted_secrets
          WHERE name = 'SUPABASE_SERVICE_ROLE_KEY' LIMIT 1
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $job$
);

SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = 'tiktok-sync-every-10min';

-- Pour DÉSACTIVER : SELECT cron.unschedule('tiktok-sync-every-10min');
-- Historique : SELECT * FROM cron.job_run_details
--   WHERE jobid=(SELECT jobid FROM cron.job WHERE jobname='tiktok-sync-every-10min')
--   ORDER BY start_time DESC LIMIT 20;
