-- ════════════════════════════════════════════════════════════════════
-- Migration 006 : Tracking token public pour le suivi client
-- ════════════════════════════════════════════════════════════════════
-- DATE : 2026-05-29
-- BUT  : Permettre au client de suivre sa commande via un lien
--        SMS contenant un token unique. La policy publique autorise
--        SELECT sur une commande SI on fournit son token en header.
-- ════════════════════════════════════════════════════════════════════

-- 1. Ajouter colonne tracking_token (UUID unique auto-genere)
ALTER TABLE public.commandes
  ADD COLUMN IF NOT EXISTS tracking_token UUID DEFAULT gen_random_uuid();

-- 2. Generer un token pour les commandes existantes sans token
UPDATE public.commandes
SET tracking_token = gen_random_uuid()
WHERE tracking_token IS NULL;

-- 3. Index pour lookup rapide par token
CREATE INDEX IF NOT EXISTS idx_commandes_tracking_token
  ON public.commandes(tracking_token);

-- 4. Policy publique : autorise SELECT si on fournit le bon token en header
-- (en OR avec require_app_secret deja en place, donc l'app continue de marcher)
DROP POLICY IF EXISTS "public_tracking" ON public.commandes;
CREATE POLICY "public_tracking" ON public.commandes
FOR SELECT TO public
USING (
  tracking_token::text = current_setting('request.headers', true)::json->>'x-tracking-token'
);

-- 5. Verification
SELECT
  COUNT(*) AS total_commandes,
  COUNT(tracking_token) AS avec_token,
  (SELECT tracking_token FROM public.commandes LIMIT 1) AS exemple_token
FROM public.commandes;
