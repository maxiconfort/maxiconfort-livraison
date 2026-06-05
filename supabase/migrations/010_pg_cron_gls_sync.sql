-- Migration 010 : pg_cron schedule pour gls-sync toutes les 2h
-- Date : 2026-06-05
-- Auteur : Borhen via Claude
--
-- Cette migration active pg_cron + pg_net et programme un job qui appelle
-- l'Edge Function gls-sync toutes les 2h pour synchroniser automatiquement
-- les statuts de livraison des colis GLS depuis l'API ShipIT-FARM.

-- ─────────────────────────────────────────────────────────────────────
-- 1. Activer les extensions pg_cron + pg_net
-- ─────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ─────────────────────────────────────────────────────────────────────
-- 2. Supprimer l'ancien schedule s'il existe (idempotence)
-- ─────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'gls-sync-every-2h') THEN
    PERFORM cron.unschedule('gls-sync-every-2h');
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────
-- 3. Programmer le job toutes les 2h (a la minute 0)
--    Cron expression : "0 */2 * * *" = a chaque heure paire (00, 02, 04, ...)
-- ─────────────────────────────────────────────────────────────────────
SELECT cron.schedule(
  'gls-sync-every-2h',
  '0 */2 * * *',
  $job$
    SELECT net.http_post(
      url := 'https://jmvfjtnmebstkzcfnlgp.supabase.co/functions/v1/gls-sync',
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
      timeout_milliseconds := 60000
    );
  $job$
);

-- ─────────────────────────────────────────────────────────────────────
-- 4. Verification : afficher le job programme
-- ─────────────────────────────────────────────────────────────────────
SELECT jobid, jobname, schedule, command FROM cron.job WHERE jobname = 'gls-sync-every-2h';

-- ─────────────────────────────────────────────────────────────────────
-- Pour DESACTIVER le cron (si besoin) :
--   SELECT cron.unschedule('gls-sync-every-2h');
--
-- Pour VOIR LES HISTORIQUES d'execution :
--   SELECT * FROM cron.job_run_details
--     WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'gls-sync-every-2h')
--     ORDER BY start_time DESC LIMIT 20;
-- ─────────────────────────────────────────────────────────────────────
