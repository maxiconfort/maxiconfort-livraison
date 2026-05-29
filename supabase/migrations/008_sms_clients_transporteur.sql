-- ════════════════════════════════════════════════════════════════════
-- Migration 008 : Transporteur + tracking + SMS clients automatiques
-- ════════════════════════════════════════════════════════════════════
-- DATE : 2026-05-29
-- BUT  : Permettre les 3 SMS clients automatiques :
--        1. RANOU : SMS depart tournee (clic "Je pars" sur 1er stop)
--        2. RANOU : SMS en route (clic Waze sur l'app livreur)
--        3. GLS   : SMS expedition (saisie n° tracking dans commande)
-- ════════════════════════════════════════════════════════════════════

-- 1. Colonnes nouvelles sur commandes
ALTER TABLE public.commandes
  ADD COLUMN IF NOT EXISTS transporteur TEXT DEFAULT 'RANOU',
  ADD COLUMN IF NOT EXISTS tracking_transporteur TEXT,
  ADD COLUMN IF NOT EXISTS sms_envoyes JSONB DEFAULT '[]'::jsonb;

-- 2. Pour les commandes existantes, transporteur = RANOU par defaut
UPDATE public.commandes
SET transporteur = 'RANOU'
WHERE transporteur IS NULL;

-- 3. Index pour lookup rapide
CREATE INDEX IF NOT EXISTS idx_commandes_transporteur
  ON public.commandes(transporteur);
CREATE INDEX IF NOT EXISTS idx_commandes_tracking
  ON public.commandes(tracking_transporteur)
  WHERE tracking_transporteur IS NOT NULL;

-- 4. Verification
SELECT
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE transporteur = 'RANOU') AS ranou,
  COUNT(*) FILTER (WHERE transporteur = 'GLS') AS gls,
  COUNT(*) FILTER (WHERE tracking_transporteur IS NOT NULL) AS avec_tracking
FROM public.commandes;
