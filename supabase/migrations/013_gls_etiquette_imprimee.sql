-- ════════════════════════════════════════════════════════════════════
-- Migration 013 : impression automatique des étiquettes GLS
-- ════════════════════════════════════════════════════════════════════
-- DATE : 2026-09-16
-- BUT  : L'agent d'impression du bureau (print-agent/agent-impression.js)
--        surveille les commandes GLS dont l'étiquette vient d'être créée
--        et pas encore imprimée. Cette colonne mémorise la date
--        d'impression physique sur la Phomemo PM-344-WF (NULL = pas
--        encore imprimée). Elle est écrite uniquement par l'agent.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE public.commandes
  ADD COLUMN IF NOT EXISTS gls_etiquette_imprimee_at TIMESTAMPTZ;

COMMENT ON COLUMN public.commandes.gls_etiquette_imprimee_at IS
  'Date/heure d''impression automatique de l''étiquette GLS sur l''imprimante du bureau (agent print-agent). NULL = pas encore imprimée.';

-- Index partiel : l'agent interroge toutes les 15 s les GLS non imprimées
CREATE INDEX IF NOT EXISTS idx_commandes_gls_a_imprimer
  ON public.commandes (gls_date_etiquette)
  WHERE transporteur = 'GLS' AND gls_etiquette_imprimee_at IS NULL;

-- Vérification
SELECT COUNT(*) AS gls_avec_etiquette_non_marquees
FROM public.commandes
WHERE transporteur = 'GLS'
  AND COALESCE(tracking_transporteur, '') <> ''
  AND gls_etiquette_imprimee_at IS NULL;
