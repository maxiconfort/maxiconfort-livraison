-- ════════════════════════════════════════════════════════════════════
-- Migration 002 : Ajout colonne date_commande
-- ════════════════════════════════════════════════════════════════════
-- DATE : 2026-05-28
-- BUT  : Permettre de saisir une "date de prise de commande" distincte
--        de la date_livraison (date souhaitee par le client) et de
--        created_at (date de saisie en BD).
--
-- ZERO RISQUE LIVREUR : la colonne est nullable avec default,
-- l'app actuelle ignore cette colonne, rien ne casse.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE public.commandes
  ADD COLUMN IF NOT EXISTS date_commande DATE DEFAULT CURRENT_DATE;

-- Backfill : pour les commandes existantes, date_commande = date de creation
UPDATE public.commandes
SET date_commande = created_at::date
WHERE date_commande IS NULL OR date_commande = CURRENT_DATE;

-- Verification
SELECT
  COUNT(*) AS total,
  COUNT(date_commande) AS avec_date_cmd,
  MIN(date_commande) AS plus_ancienne,
  MAX(date_commande) AS plus_recente
FROM public.commandes;
