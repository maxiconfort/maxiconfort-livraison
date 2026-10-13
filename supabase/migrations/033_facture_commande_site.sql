-- Migration 033 (13/10/2026) : numero de commande du site sur la facture client
-- La page facture.html affichait la reference interne de la fiche (#1870) au lieu du numero
-- de commande connu du client (#1174). Ce numero n'existe que dans la note interne
-- (« Commande site #1174. »), que la page publique ne doit pas lire en entier.
-- Champ calcule, lisible par PostgREST comme une colonne : ?select=...,commande_site
-- Il ne renvoie que les chiffres du numero, jamais le reste de la note.
create or replace function public.commande_site(c public.commandes)
returns text language sql stable as $$
  select (regexp_match(coalesce(c.instr, ''), 'site #([0-9]+)'))[1]
$$;
grant execute on function public.commande_site(public.commandes) to anon, authenticated;
notify pgrst, 'reload schema';
