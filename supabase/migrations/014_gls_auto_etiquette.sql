-- ════════════════════════════════════════════════════════════════════
-- Migration 014 : création AUTOMATIQUE des étiquettes GLS + verrou anti-doublon
-- ════════════════════════════════════════════════════════════════════
-- DATE : 2026-09-17 — demande Borhen : « imprimer directement quand une commande
--        GLS tombe » → l'étiquette doit être créée sans clic, puis l'agent du bureau
--        (print-agent) l'imprime.
--
-- 1. Colonnes de suivi de la création d'étiquette (état + verrou) :
--      gls_creation_statut : NULL (jamais tentée) | 'en_cours' (verrou posé)
--                            | 'cree' | 'echec' (GLS a refusé, rien de facturé)
--                            | 'incertain' (coupure pendant l'appel : vérifier YourGLS)
--                            | 'ignore' (exclue par la note : SANS ETIQUETTE / YOURGLS)
--      gls_creation_at, gls_creation_source ('auto' | 'app'), gls_creation_erreur
-- 2. Fonction gls_reserver_creation(id, auto) : pose le verrou de façon ATOMIQUE.
--      auto  = true  → seulement si jamais tentée (NULL) et pas d'étiquette
--      auto  = false → clic dans l'app : si pas d'étiquette et pas de création en
--                      cours (un verrou de plus de 10 min est considéré abandonné)
-- 3. Cron gls-auto-etiquette : voir migration 015.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE public.commandes
  ADD COLUMN IF NOT EXISTS gls_creation_statut  TEXT,
  ADD COLUMN IF NOT EXISTS gls_creation_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gls_creation_source  TEXT,
  ADD COLUMN IF NOT EXISTS gls_creation_erreur  TEXT;

CREATE INDEX IF NOT EXISTS idx_commandes_gls_auto_candidates
  ON public.commandes (created_at)
  WHERE transporteur = 'GLS' AND gls_creation_statut IS NULL;

CREATE OR REPLACE FUNCTION public.gls_reserver_creation(p_id TEXT, p_auto BOOLEAN)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  n INTEGER;
BEGIN
  UPDATE public.commandes
     SET gls_creation_statut = 'en_cours',
         gls_creation_at     = now(),
         gls_creation_source = CASE WHEN p_auto THEN 'auto' ELSE 'app' END,
         gls_creation_erreur = NULL
   WHERE id = p_id
     AND COALESCE(tracking_transporteur, '') = ''
     AND (
           (p_auto AND gls_creation_statut IS NULL)
        OR (NOT p_auto AND (
                gls_creation_statut IS NULL
             OR gls_creation_statut <> 'en_cours'
             OR gls_creation_at < now() - INTERVAL '10 minutes'))
         );
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.gls_reserver_creation(TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gls_reserver_creation(TEXT, BOOLEAN) TO service_role;

-- Les étiquettes déjà existantes sont marquées 'cree' (jamais reconsidérées)
UPDATE public.commandes
   SET gls_creation_statut = 'cree'
 WHERE COALESCE(tracking_transporteur, '') <> ''
   AND gls_creation_statut IS NULL;

-- Le cron est posé séparément (migration 015), une fois les Edge Functions déployées.

SELECT gls_creation_statut, COUNT(*) FROM public.commandes
 WHERE transporteur = 'GLS' GROUP BY gls_creation_statut;
