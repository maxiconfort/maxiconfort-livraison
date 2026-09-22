-- Migration 017 : suivi de l'envoi du n° de suivi GLS vers TikTok Shop (Edge Function tiktok-fulfill)
-- Date : 2026-09-23
--
-- Colonnes sur `commandes` :
--   tiktok_suivi_envoye_at : quand le n° GLS a été transmis à TikTok (ou constaté déjà saisi)
--   tiktok_suivi_note      : détail (ex. « saisi via API », « déjà présent dans TikTok »)
--   tiktok_suivi_erreur    : dernière erreur API (NULL si OK) — nouvel essai à chaque passage
-- + cron pg_cron `tiktok-fulfill-every-10min` (décalé de 5 min par rapport à tiktok-sync).

ALTER TABLE public.commandes
  ADD COLUMN IF NOT EXISTS tiktok_suivi_envoye_at timestamptz,
  ADD COLUMN IF NOT EXISTS tiktok_suivi_note text,
  ADD COLUMN IF NOT EXISTS tiktok_suivi_erreur text;

CREATE INDEX IF NOT EXISTS commandes_tiktok_a_transmettre_idx
  ON public.commandes (created_at)
  WHERE origine = 'TikTok Shop' AND tiktok_suivi_envoye_at IS NULL;

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tiktok-fulfill-every-10min') THEN
    PERFORM cron.unschedule('tiktok-fulfill-every-10min');
  END IF;
END $$;

SELECT cron.schedule(
  'tiktok-fulfill-every-10min',
  '5-59/10 * * * *',
  $job$
    SELECT net.http_post(
      url := 'https://jmvfjtnmebstkzcfnlgp.supabase.co/functions/v1/tiktok-fulfill',
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

SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = 'tiktok-fulfill-every-10min';

-- Pour DÉSACTIVER : SELECT cron.unschedule('tiktok-fulfill-every-10min');
