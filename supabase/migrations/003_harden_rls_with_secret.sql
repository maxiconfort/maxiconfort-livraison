-- ════════════════════════════════════════════════════════════════════
-- Migration 003 : Durcir RLS avec verification header x-app-secret
-- ════════════════════════════════════════════════════════════════════
-- DATE : 2026-05-28 (a executer EN DERNIER, apres modification de l'app)
-- BUT  : Remplacer les policies "temp_allow_all" (qui acceptent tout)
--        par des policies qui exigent un header HTTP `x-app-secret`
--        avec la valeur du secret connu uniquement de l'app.
--
-- ⚠ ATTENTION : NE PAS executer tant que le HTML n'envoie pas ce header
--    Sinon TOUS les appels Supabase echouent et l'app est cassee.
--
-- ORDRE D'EXECUTION :
--   1. Modifier le HTML (envoyer header x-app-secret partout)
--   2. Push GitHub
--   3. Verifier en prod que l'app fonctionne avec policies permissives
--   4. Executer cette migration 003 (durcir)
--   5. Verifier que l'app fonctionne toujours
--   6. Regenerer la cle anon dans le dashboard Supabase
-- ════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'caisse_remises','chargements','commandes','depenses','entretiens',
    'geofence_logs','gps_positions','lbc_annonces','lbc_config','lbc_produits',
    'livreurs','mouvements_stock','parametres','produits','sms_historique',
    'stock_camion','stock_mouvements','tournees','vehicules','zones'
  ];
  -- ⚠ Remplacer le SECRET ci-dessous par la valeur de APP_SECRET du .env :
  app_secret text := '9fefa508934706dba95559be02e2033f0df05f593a4b4d81da7d7aac307ce257';
BEGIN
  FOREACH tbl IN ARRAY tables
  LOOP
    BEGIN
      -- Supprimer la policy permissive temporaire
      EXECUTE format('DROP POLICY IF EXISTS "temp_allow_all" ON public.%I', tbl);

      -- Creer la nouvelle policy stricte
      EXECUTE format('DROP POLICY IF EXISTS "require_app_secret" ON public.%I', tbl);
      EXECUTE format(
        'CREATE POLICY "require_app_secret" ON public.%I '
        'FOR ALL TO public '
        'USING ( current_setting(''request.headers'', true)::json->>''x-app-secret'' = %L ) '
        'WITH CHECK ( current_setting(''request.headers'', true)::json->>''x-app-secret'' = %L )',
        tbl, app_secret, app_secret
      );
      RAISE NOTICE 'OK durcissement: %', tbl;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'SKIP % : %', tbl, SQLERRM;
    END;
  END LOOP;
END $$;

-- Verification
SELECT
  tablename,
  rowsecurity AS rls_active,
  (SELECT string_agg(policyname, ', ') FROM pg_policies p
   WHERE p.schemaname='public' AND p.tablename=t.tablename) AS policies
FROM pg_tables t
WHERE schemaname='public'
ORDER BY tablename;
