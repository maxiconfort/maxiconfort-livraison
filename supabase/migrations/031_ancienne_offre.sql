-- 031_ancienne_offre.sql — 09/10/2026 — « ANCIENNE OFFRE — NE PLUS UTILISER » (décision de Borhen du 08/10/2026).
--
-- But : empêcher toute nouvelle vente d'une offre retirée, sans casser l'historique ni les commandes en attente.
--
-- * produits.ancienne_offre : marqueur posé côté serveur par un administrateur. Le produit RESTE actif dans le catalogue
--   (les commandes déjà prises restent lisibles, leur stock reste correctement déduit), mais l'application v7.5.118 ne le
--   propose plus pour une nouvelle commande et l'affiche « ANCIENNE OFFRE — NE PLUS UTILISER » dans le stock et l'historique.
-- * Pourquoi une colonne à part et pas « actif = false » : l'application ne charge que les produits actifs ; un produit
--   inactif disparaît de sa mémoire et le stock des commandes en attente serait mal déduit. De plus chaque appareil renvoie
--   « actif » avec le reste de la fiche : un appareil avec un ancien catalogue en mémoire aurait pu remettre l'offre en vente.
--   Aucune version de l'application n'envoie « ancienne_offre » : une écriture venant d'un appareil ne peut pas le modifier
--   (et, par sécurité, le déclencheur ci-dessous ignore toute tentative de le lever depuis une session de l'application).
-- * Un produit marqué ne peut pas être supprimé (il sert encore à l'historique et au stock).
-- * AUCUNE commande n'est modifiée par cette migration. La table commandes n'est pas touchée, ni aucun déclencheur de paiement
--   ou d'annulation.
--
-- RETOUR ARRIÈRE (sans perte de données) :
--   update public.produits set ancienne_offre = false where ancienne_offre;   -- l'offre redevient sélectionnable
--   (facultatif) drop trigger if exists produits_ancienne_offre_garde on public.produits;
--   puis, si besoin, revenir à l'application v7.5.117 (étiquette git « v7.5.117-avant-ancienne-offre »).
--   La colonne peut rester en place, elle est inoffensive.

alter table public.produits add column if not exists ancienne_offre boolean not null default false;
comment on column public.produits.ancienne_offre is 'Ancienne offre : reste au catalogue pour l''historique et le stock, mais n''est plus proposée pour une nouvelle commande (application v7.5.118). Posé côté serveur uniquement.';

create or replace function interne.produits_ancienne_offre_garde() returns trigger
language plpgsql security definer set search_path = public, interne as $$
begin
  if tg_op = 'DELETE' then
    if old.ancienne_offre then
      raise exception 'ANCIENNE OFFRE : ce produit sert encore à l''historique et au stock des commandes, il ne peut pas être supprimé' using errcode = 'P0001';
    end if;
    return old;
  end if;
  -- Une session de l'application (bureau, collaboratrice, livreur) ne peut pas lever le marqueur : seule une opération
  -- faite côté serveur par un administrateur le peut.
  if old.ancienne_offre and not coalesce(new.ancienne_offre, false) and (select public.session_role()) is not null then
    new.ancienne_offre := true;
  end if;
  return new;
end $$;

drop trigger if exists produits_ancienne_offre_garde on public.produits;
create trigger produits_ancienne_offre_garde before update or delete on public.produits
  for each row execute function interne.produits_ancienne_offre_garde();

-- Offres retirées le 09/10/2026 : lit coffre 140x190 + matelas 20 cm, blanc et noir.
update public.produits set ancienne_offre = true where id in ('pr1779111250992', 'pr1779111182143');

-- Prix catalogue de l'offre ACTUELLE (pack lit coffre 140x190 + matelas 15 cm, blanc et noir) : 299 -> 349 euros.
-- Ne concerne que les NOUVELLES commandes : chaque commande déjà prise garde son propre prix (colonnes prix et lignes).
update public.produits set prix = 349, updated_at = now() where id in ('pr1789810598512', 'pr1789810425754') and prix = 299;
