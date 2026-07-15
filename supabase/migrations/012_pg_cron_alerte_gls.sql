-- Migration 012 : pg_cron schedule pour alerte-gls (gardien expeditions GLS)
-- Date : 2026-07-15
-- Auteur : Borhen via Claude
--
-- Contexte : le 08/07/2026, ~11 commandes GLS payees etaient restees sans
-- etiquette (jusqu'a 1 mois de retard, 1 reclamation client) parce que des
-- expeditions se font parfois en direct sur YourGLS sans passer par l'app.
-- Ce job appelle l'Edge Function alerte-gls chaque matin a 06:30 UTC
-- (= 8h30 Paris en ete) : si des commandes GLS payees attendent leur
-- etiquette depuis plus de 48h, Borhen recoit un SMS avec la liste.
-- Re-alerte chaque jour tant que non traite. ~1 credit OVH par alerte.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Idempotence : retirer l'ancien schedule s'il existe
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'alerte-gls-daily') THEN
    PERFORM cron.unschedule('alerte-gls-daily');
  END IF;
END $$;

-- Programmer le job : tous les jours a 06:30 UTC (8h30 Paris ete)
SELECT cron.schedule(
  'alerte-gls-daily',
  '30 6 * * *',
  $job$
    SELECT net.http_post(
      url := 'https://jmvfjtnmebstkzcfnlgp.supabase.co/functions/v1/alerte-gls',
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

SELECT jobid, jobname, schedule FROM cron.job WHERE jobname = 'alerte-gls-daily';

-- Pour DESACTIVER : SELECT cron.unschedule('alerte-gls-daily');
-- Historique : SELECT * FROM cron.job_run_details
--   WHERE jobid=(SELECT jobid FROM cron.job WHERE jobname='alerte-gls-daily')
--   ORDER BY start_time DESC LIMIT 20;
