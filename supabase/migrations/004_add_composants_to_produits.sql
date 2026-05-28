-- ════════════════════════════════════════════════════════════════════
-- Migration 004 : Ajout colonne `composants` (JSONB) a produits
-- ════════════════════════════════════════════════════════════════════
-- DATE : 2026-05-28
-- BUT  : Permettre de definir la composition d'un produit "Ensemble"
--        (ex : 1 matelas + 1 sommier). Le stock dispo de l'ensemble
--        sera calcule comme min(stock_composants).
--
-- Format JSONB attendu :
--   composants = [{"id":"pr15","qte":1}, {"id":"pr31","qte":1}]
--   - id  : id du produit composant
--   - qte : quantite de ce composant dans 1 unite de l'ensemble
--
-- Pour les produits "simples" (matelas seul, sommier seul, etc.) :
--   composants = NULL  →  on utilise produit.stock directement
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE public.produits
  ADD COLUMN IF NOT EXISTS composants JSONB DEFAULT NULL;

-- Verification
SELECT
  COUNT(*) AS total_produits,
  COUNT(composants) AS avec_composants,
  COUNT(*) FILTER (WHERE cat='Ensemble') AS total_ensembles
FROM public.produits;
