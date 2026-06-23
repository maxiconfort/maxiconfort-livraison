-- Migration 011 : pg_cron schedule pour sms-avis (demande d'avis Google J+1)
-- Date : 2026-06-23
-- Auteur : Borhen via Claude
--
-- Programme un job quotidien qui appelle l'Edge Function sms-avis a 09:00 UTC
-- (= 11:00 Paris en ete / 10:00 en hiver) pour envoyer, le lendemain de chaque
-- livraison (statut "livré", J-1), un SMS de demande d'avis Google au client.
-- Demande d'avis HONNETE, sans condition ni recompense. 1 SMS = 1 credit OVH.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Idempotence : retirer l'ancien schedule s'il existe
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sms-avis-daily') THEN
    PERFORM cron.unschedule('sms-avis-daily');
  END IF;
END $$;

-- Programmer le job : tous les jours a 09:00 UTC (11h Paris ete)
SELECT cron.schedule(
  'sms-avis-daily',
  '0 9 * * *',
  $job$
    SELECT net.http_post(
      url := 'https://jmvfjtnmebstkzcfnlgp.supabase.co/functions/v1/sms-avis',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          SELECT decrypted_secret
          FROM vault.decrypted_secrets
          WHERE name = 'SUPABASE_SERVICE_ROLE_KEY'
          LIMIT 1
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
  $job$
);

SELECT jobid, jobname, schedule FROM cron.job WHERE jobname = 'sms-avis-daily';

-- Pour DESACTIVER : SELECT cron.unschedule('sms-avis-daily');
-- Historique : SELECT * FROM cron.job_run_details
--   WHERE jobid=(SELECT jobid FROM cron.job WHERE jobname='sms-avis-daily')
--   ORDER BY start_time DESC LIMIT 20;
