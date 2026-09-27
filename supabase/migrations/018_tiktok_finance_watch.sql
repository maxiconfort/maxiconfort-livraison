-- Migration 018 : surveillance des versements TikTok Shop (Edge Function tiktok-finance-watch)
-- Date : 2026-09-27
--
-- Cron pg_cron `tiktok-finance-watch-daily` : tous les jours à 07:30 UTC (09:30 Paris en été,
-- 08:30 en hiver). Alertes Telegram : versement payé / nouveau / en retard (> 3 j) / échoué.
-- État mémorisé dans parametres.tiktok_finance_etat.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tiktok-finance-watch-daily') THEN
    PERFORM cron.unschedule('tiktok-finance-watch-daily');
  END IF;
END $$;

SELECT cron.schedule(
  'tiktok-finance-watch-daily',
  '30 7 * * *',
  $job$
    SELECT net.http_post(
      url := 'https://jmvfjtnmebstkzcfnlgp.supabase.co/functions/v1/tiktok-finance-watch',
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

SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = 'tiktok-finance-watch-daily';

-- Pour DÉSACTIVER : SELECT cron.unschedule('tiktok-finance-watch-daily');
