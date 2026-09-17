-- Migration 015 : pg_cron pour gls-auto-etiquette (création automatique des étiquettes GLS)
-- Date : 2026-09-17 — voir migration 014 pour les colonnes et le verrou.
--
-- Toutes les 5 minutes, de 05:00 à 19:55 UTC = 7h à 21h55 Paris (heure d'été ;
-- 6h-20h55 en hiver). Pas la nuit : la création déclenche le SMS « expédiée »
-- au client. Une commande arrivée après 22h est étiquetée le lendemain à 7h.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'gls-auto-etiquette-5min') THEN
    PERFORM cron.unschedule('gls-auto-etiquette-5min');
  END IF;
END $$;

SELECT cron.schedule(
  'gls-auto-etiquette-5min',
  '*/5 5-19 * * *',
  $job$
    SELECT net.http_post(
      url := 'https://jmvfjtnmebstkzcfnlgp.supabase.co/functions/v1/gls-auto-etiquette',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          SELECT decrypted_secret FROM vault.decrypted_secrets
          WHERE name = 'SUPABASE_SERVICE_ROLE_KEY' LIMIT 1
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 300000
    );
  $job$
);

SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = 'gls-auto-etiquette-5min';

-- Pour DÉSACTIVER la création automatique : SELECT cron.unschedule('gls-auto-etiquette-5min');
-- Historique : SELECT * FROM cron.job_run_details
--   WHERE jobid=(SELECT jobid FROM cron.job WHERE jobname='gls-auto-etiquette-5min')
--   ORDER BY start_time DESC LIMIT 20;
