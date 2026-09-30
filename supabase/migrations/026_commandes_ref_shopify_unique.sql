-- 026 (30/09/2026) : une commande du site ne peut exister qu'une fois dans l'app.
-- Contrôle préalable (lecture, 30/09) : 152 commandes du site avec un identifiant Shopify
-- numérique, 0 doublon. Les références vides (saisies manuelles) et celles des SAV
-- (« #1561 » = n° de la commande d'origine, légitimement répété) ne sont pas concernées.
-- Si un doublon apparaît avant application, la création de l'index échoue : NE PAS
-- supprimer de commande pour la forcer, traiter le doublon à la main d'abord.
create unique index if not exists commandes_ref_shopify_unique
  on public.commandes (ref_marketplace)
  where origine = 'Site Maxiconfort' and ref_marketplace ~ '^[0-9]+$';
