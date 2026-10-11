-- Migration 032 : 2e passage quotidien de tiktok-finance-watch (limites de remise GLS des commandes TikTok)
-- Date : 2026-10-12
-- 15:30 UTC = 17:30 Paris (été) / 16:30 (hiver). Appel sécurisé via interne.appel_fonction (x-cron-secret, migration 019).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tiktok-finance-watch-pm') THEN
    PERFORM cron.unschedule('tiktok-finance-watch-pm');
  END IF;
END $$;

SELECT cron.schedule(
  'tiktok-finance-watch-pm',
  '30 15 * * *',
  $job$ select interne.appel_fonction('tiktok-finance-watch', '{}'::jsonb, 60000); $job$
);

SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname LIKE 'tiktok-finance-watch%';

-- Pour DÉSACTIVER : SELECT cron.unschedule('tiktok-finance-watch-pm');
