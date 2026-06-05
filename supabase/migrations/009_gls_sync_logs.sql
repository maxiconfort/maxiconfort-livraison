-- Migration 009 : Table de logs pour Edge Function gls-sync
-- Date : 2026-06-05
-- Auteur : Borhen via Claude
--
-- Cette table enregistre chaque exécution de la fonction gls-sync
-- (manuelle ou via pg_cron) avec les compteurs et le détail des cmds traitées.

CREATE TABLE IF NOT EXISTS gls_sync_logs (
  id              text PRIMARY KEY,
  run_at          timestamptz NOT NULL DEFAULT now(),
  cmds_a_checker  integer NOT NULL DEFAULT 0,
  cmds_livre      integer NOT NULL DEFAULT 0,
  cmds_erreur     integer NOT NULL DEFAULT 0,
  duration_ms     integer NOT NULL DEFAULT 0,
  details         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gls_sync_logs_run_at
  ON gls_sync_logs (run_at DESC);

-- RLS : seul le service_role peut lire/écrire (la fonction Edge utilise service_role)
ALTER TABLE gls_sync_logs ENABLE ROW LEVEL SECURITY;

-- Policy require_app_secret pour pouvoir consulter depuis l'admin si besoin
DROP POLICY IF EXISTS require_app_secret ON gls_sync_logs;
CREATE POLICY require_app_secret ON gls_sync_logs
  FOR ALL
  USING ((SELECT current_setting('request.headers', true)::json->>'x-app-secret') = '9fefa508934706dba95559be02e2033f0df05f593a4b4d81da7d7aac307ce257')
  WITH CHECK ((SELECT current_setting('request.headers', true)::json->>'x-app-secret') = '9fefa508934706dba95559be02e2033f0df05f593a4b4d81da7d7aac307ce257');

COMMENT ON TABLE gls_sync_logs IS 'Logs d''exécution de l''Edge Function gls-sync (auto-tracking colis GLS via API officielle)';
