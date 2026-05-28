-- ════════════════════════════════════════════════════════════════════
-- Migration 001 : Activation RLS avec policies permissives
-- ════════════════════════════════════════════════════════════════════
-- DATE : 2026-05-28
-- BUT  : Activer la Row Level Security sur toutes les tables sans
--        changer le comportement actuel de l'app (les policies
--        permissives `USING(true)` laissent tout passer).
--
-- ETAPE SUIVANTE (a faire ce soir, hors tournee active) :
--   - Modifier ces policies pour exiger un header `x-app-secret`
--   - Modifier le HTML pour envoyer ce header
--   - Regenerer la cle anon dans le dashboard Supabase
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
BEGIN
  FOREACH tbl IN ARRAY tables
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
      EXECUTE format('DROP POLICY IF EXISTS "temp_allow_all" ON public.%I', tbl);
      EXECUTE format(
        'CREATE POLICY "temp_allow_all" ON public.%I '
        'FOR ALL TO public USING (true) WITH CHECK (true)',
        tbl
      );
      RAISE NOTICE 'OK: %', tbl;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'SKIP % (probablement une vue) : %', tbl, SQLERRM;
    END;
  END LOOP;
END $$;

-- Verification : lister l'etat RLS de chaque table
SELECT
  schemaname,
  tablename,
  rowsecurity AS rls_active,
  (SELECT count(*) FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=t.tablename) AS nb_policies
FROM pg_tables t
WHERE schemaname='public'
ORDER BY tablename;
