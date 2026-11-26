-- 039_arrivages_prix_revient.sql — 25/11/2026 — RÉCEPTION D'ARRIVAGE, PRIX DE REVIENT, PRODUITS NON VENDABLES (application v7.5.136).
--
-- ⚠️ DÉPÔT PUBLIC : ce fichier ne contient AUCUN prix d'achat, montant, numéro de facture ou nom de fournisseur. Les données d'un
--    arrivage sont chargées à part, depuis un fichier privé, par un administrateur (jamais par l'application).
--
-- But (demande de Borhen du 25/11/2026 : intégrer un conteneur de matelas) :
--   1. arrivages / arrivage_lignes : un conteneur attendu, ses références et quantités, puis la RÉCEPTION (reçu / endommagé /
--      manquant par ligne) validée UNE seule fois par l'administrateur (fonction valider_reception_arrivage, atomique).
--   2. Prix de revient HT par produit, valorisé au COÛT MOYEN PONDÉRÉ (CUMP) à chaque réception — CHOIX À VALIDER PAR BORHEN :
--      la méthode est une constante (interne.arrivage_methode_valorisation) ; 'DERNIER_PRIX' est l'autre méthode possible.
--      Historique par lot dans prix_revient_historique (ajout seul : jamais modifié rétroactivement).
--   3. Produits NON VENDABLES : une nouvelle référence arrive sans prix de vente (prix NULL, prix_vente_defini = false,
--      vendable = false). Elle peut être reçue et stockée mais ne peut être ni vendue (commande), ni reliée à une variante
--      Shopify, ni comptée dans un ensemble vendable, tant que l'administrateur n'a pas fixé son prix.
--
-- Pourquoi le prix de revient n'est PAS une colonne de « produits » (écart volontaire avec la demande initiale) :
--   la table produits est LISIBLE en entier par les sessions collaboratrice et livreur (politiques sess_collab et
--   sess_livreur_lecture de la migration 019) et par le cerveau (brain_read). Une colonne prix_revient_ht y serait donc visible
--   par tout le monde. Le revient vit dans produits_revient, lisible par l'administrateur seulement (même règle que
--   journal_financier). Les marges des commandes passées ne sont JAMAIS recalculées (aucune colonne de coût ajoutée aux
--   commandes dans ce lot : le coût figé à la vente viendra avec le lot « Marges »).
--
-- Rien n'est écrit dans produits.stock par cette migration : le stock n'augmente qu'à la validation d'une réception.
-- Le stock ENTRANT (arrivages en attente) est lu par la fonction stock_entrant() (administrateur et collaboratrice), sans prix.
--
-- ORDRE DE MISE EN SERVICE : 1) cette migration ; 2) l'application v7.5.136 ; 3) (facultatif) jarvis-action et
-- whatsapp-receive redéployées (elles filtrent les produits non vendables) ; 4) le fichier privé de chargement d'un arrivage.
--
-- RETOUR ARRIÈRE (sans perte de données, à faire AVANT toute réception validée) :
--   drop trigger if exists commandes_produit_vendable_garde on public.commandes;
--   drop trigger if exists stock_correspondance_vendable_garde on public.stock_correspondance;
--   drop trigger if exists produits_correspondance_garde on public.produits;
--   drop trigger if exists produits_vente_garde on public.produits;
--   alter table public.produits drop constraint if exists produits_prix_defini_non_null;
--   alter table public.produits drop constraint if exists produits_vendable_prix_defini;
--   (les tables et colonnes ajoutées peuvent rester : elles sont inoffensives) ; revenir à l'application v7.5.135.
--   Après une réception validée : le stock ajouté est tracé dans mouvements_stock (type 'entree', source 'arrivage:<réf>') et dans
--   stock_entrees (motif 'arrivage:<réf>', lu par stock-sync-shopify et JARVIS). La contrainte élargie de stock_entrees.motif peut rester.

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 1. Produits : prix de vente « à définir », vendable, référence interne, caractéristiques
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- Une nouvelle référence n'a pas encore de prix de vente : prix NULL (et non 0, qui serait un vrai prix). Sans effet si la
-- colonne accepte déjà NULL. L'application lit un prix NULL comme 0 et affiche « Prix à définir ».
alter table public.produits alter column prix drop not null;

alter table public.produits
  add column if not exists prix_vente_defini boolean not null default true,
  add column if not exists vendable boolean not null default true,
  add column if not exists reference_interne text,
  add column if not exists caracteristiques jsonb;
create unique index if not exists produits_reference_interne_unique on public.produits (reference_interne) where reference_interne is not null;
comment on column public.produits.prix_vente_defini is 'false = prix de vente pas encore fixé par la direction (prix NULL) : produit non vendable. Seul un administrateur le passe à true (avec un prix > 0).';
comment on column public.produits.vendable is 'false = jamais proposé à la vente (commande, ensemble, correspondance Shopify). Modifiable par un administrateur seulement.';
comment on column public.produits.reference_interne is 'Référence interne (ex. MC-…), unique si renseignée.';
comment on column public.produits.caracteristiques is 'Caractéristiques techniques (jsonb), affichage seulement.';

-- ÉTAT DE VENTE TOUJOURS COHÉRENT (revue Codex PR 26 sur fd751b8) : « prix défini » sans prix (NULL) est interdit — sinon la base
-- et les fonctions serveur le tenaient pour vendable alors que l'application (prix NULL = « à définir ») ne le proposait pas.
-- Contraintes (insertion ET modification, toutes origines) + message clair dans le déclencheur produits_vente_garde.
-- Avant cette migration, prix était NOT NULL : aucune ligne existante ne les viole.
alter table public.produits drop constraint if exists produits_prix_defini_non_null;
alter table public.produits add constraint produits_prix_defini_non_null check (not prix_vente_defini or prix is not null);
alter table public.produits drop constraint if exists produits_vendable_prix_defini;
alter table public.produits add constraint produits_vendable_prix_defini check (not vendable or prix_vente_defini);

-- Un produit est NON VENDABLE s'il est marqué non vendable, sans prix de vente défini (ou sans prix), ou si c'est un ensemble dont
-- un composant est non vendable (un niveau, comme getStockDispo dans l'application). Revue Codex PR 26 sur fd751b8 : un composant
-- INTROUVABLE (identifiant qui ne désigne aucun produit) rend l'ensemble NON VENDABLE — même règle que les fonctions serveur, qui
-- refusent un catalogue où un composant manque (lireCatalogueComplet) ; avant, il était ignoré, donc vendable par défaut.
create or replace function interne.produit_non_vendable(p_id text) returns boolean
language sql stable security definer set search_path = public, pg_catalog as $$
  select exists (
    select 1 from public.produits p
     where p.id = p_id
       and (not p.vendable or not p.prix_vente_defini or p.prix is null
            or (jsonb_typeof(p.composants) = 'array' and exists (
                  select 1 from jsonb_array_elements(p.composants) c
                    left join public.produits q on q.id = c ->> 'id'
                   where coalesce(c ->> 'id', '') <> ''
                     and (q.id is null or not q.vendable or not q.prix_vente_defini or q.prix is null)))));
$$;
revoke all on function interne.produit_non_vendable(text) from public, anon, authenticated;

-- Garde sur produits :
--  * une session collaboratrice ou livreur ne change jamais vendable, prix_vente_defini, reference_interne, caracteristiques ;
--  * tant que le prix n'est pas défini, une écriture ordinaire ne lui donne pas de prix (l'application envoie 0 par défaut) ;
--  * passer à « prix défini » exige un prix > 0 ; un produit sans prix défini ne peut pas être vendable.
-- Décision PURE sur l'état de vente proposé (revue Codex PR 26 sur fd751b8) : NULL = accepté, sinon le motif du refus.
--   'prix_obligatoire'   : passage de « à définir » à « défini » sans prix > 0 (modification) ;
--   'prix_null'          : « prix défini » sans prix (insertion OU modification) ;
--   'sans_prix_vendable' : vendable sans prix de vente défini.
create or replace function interne.l039_etat_vente_refus(p_op text, p_ancien_defini boolean, p_defini boolean, p_vendable boolean, p_prix numeric)
returns text language sql immutable as $$
  select case
    when p_op = 'UPDATE' and p_ancien_defini is false and p_defini is true and coalesce(p_prix, 0) <= 0 then 'prix_obligatoire'
    when p_defini is not false and p_prix is null then 'prix_null'
    when p_vendable is not false and p_defini is false then 'sans_prix_vendable'
  end
$$;
revoke all on function interne.l039_etat_vente_refus(text, boolean, boolean, boolean, numeric) from public, anon, authenticated;

create or replace function interne.produits_vente_garde() returns trigger
language plpgsql security definer set search_path = public, interne, pg_catalog as $$
declare r text := (select public.session_role()); v_refus text; v_ex record;
begin
  if tg_op = 'UPDATE' and r is not null and r <> 'admin' then
    new.vendable := old.vendable;
    new.prix_vente_defini := old.prix_vente_defini;
    new.reference_interne := old.reference_interne;
    new.caracteristiques := old.caracteristiques;
  end if;
  if tg_op = 'INSERT' and r is not null and r <> 'admin' then
    new.reference_interne := null; new.caracteristiques := null;
    -- création ordinaire depuis l'application : produit vendable avec son prix, comme avant
    new.vendable := true; new.prix_vente_defini := true;
  end if;
  -- Enregistrement « upsert » de l'application (INSERT … ON CONFLICT, sbSaveProduit) d'un produit DÉJÀ présent dont le prix n'est pas
  -- encore défini (relecture complète PR 26 sur fd751b8) : la ligne proposée (prix NULL, prix_vente_defini par défaut à true) passe
  -- par ce déclencheur et par les contraintes AVANT la détection du conflit. Elle reprend donc l'état de vente ACTUEL du produit
  -- (« à définir », non vendable, prix NULL) : la modification ordinaire (stock, emplacement…) reste possible et ne fixe pas de prix ;
  -- le déclencheur UPDATE garde ensuite les mêmes règles qu'avant.
  if tg_op = 'INSERT' then
    select p.prix_vente_defini, p.vendable, p.prix into v_ex from public.produits p where p.id = new.id;
    if found and v_ex.prix_vente_defini = false then
      new.prix_vente_defini := false; new.vendable := v_ex.vendable; new.prix := v_ex.prix;
    end if;
  end if;
  if not new.prix_vente_defini then
    if tg_op = 'UPDATE' and old.prix_vente_defini = false then new.prix := old.prix;  -- reste « à définir »
    elsif tg_op = 'INSERT' then new.prix := null;
    end if;
  end if;
  -- décision PURE (interne.l039_etat_vente_refus, testée par l'auto-contrôle section 10), insertion comme modification
  v_refus := interne.l039_etat_vente_refus(tg_op, case when tg_op = 'UPDATE' then old.prix_vente_defini end,
                                           new.prix_vente_defini, new.vendable, new.prix);
  -- passage de « à définir » à « défini » : prix > 0 obligatoire (une création ordinaire, elle, garde son fonctionnement)
  if v_refus = 'prix_obligatoire' then
    raise exception 'PRIX DE VENTE : un prix supérieur à 0 est obligatoire pour définir le prix de « % »', new.nom using errcode = 'P0001';
  end if;
  -- revue Codex PR 26 sur fd751b8 : « prix défini » sans prix (NULL) refusé (la base l'aurait tenu pour vendable)
  if v_refus = 'prix_null' then
    raise exception 'PRIX DE VENTE : « % » est marqué « prix défini » sans prix (NULL) : refusé', new.nom using errcode = 'P0001';
  end if;
  if v_refus = 'sans_prix_vendable' then
    raise exception 'PRODUIT NON VENDABLE : « % » n''a pas de prix de vente défini', new.nom using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists produits_vente_garde on public.produits;
create trigger produits_vente_garde before insert or update on public.produits
  for each row execute function interne.produits_vente_garde();

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 2. Commandes et correspondance Shopify : un produit non vendable est REFUSÉ
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- Une commande déjà prise qui contient un produit retiré de la vente reste modifiable, MAIS ses lignes de produits non vendables
-- sont FIGÉES (revue Codex sur 82a9b09) : pour chaque produit non vendable présent dans les lignes proposées, elles doivent être
-- exactement les lignes existantes de ce produit — même nombre d'occurrences, mêmes quantités, mêmes prix et remises (ordre libre).
-- Ajouter une ligne, changer une quantité, un prix ou une remise d'un produit non vendable est refusé ; retirer TOUTES ses lignes
-- reste permis. Un produit non vendable absent de la commande d'origine (ou dans une commande nouvelle) est refusé.
-- Aucune commande existante n'est touchée par cette migration. Les déclencheurs de paiement et d'annulation ne changent pas.
-- Nombre lu sans erreur (texte non numérique → NULL, comparé tel quel).
create or replace function interne.l039_nombre(p jsonb) returns numeric
language plpgsql immutable as $$
begin
  if p is null or jsonb_typeof(p) = 'null' then return null; end if;
  return (p #>> '{}')::numeric;
exception when others then return null;
end $$;
-- Signature d'une ligne : quantité (absente ou 0 = 1, comme l'application : l.qte || 1), prix et remises.
create or replace function interne.l039_signature_ligne(e jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'qte', coalesce(nullif(interne.l039_nombre(e -> 'qte'), 0), 1),
    'prixUnit', interne.l039_nombre(e -> 'prixUnit'),
    'prixBrut', interne.l039_nombre(e -> 'prixBrut'),
    'remiseLigne', interne.l039_nombre(e -> 'remiseLigne'),
    'remiseVal', interne.l039_nombre(e -> 'remiseVal'),
    'remiseType', e -> 'remiseType',
    'sousTotal', interne.l039_nombre(e -> 'sousTotal'))
$$;
-- PURE (aucune lecture de table) : produits de p_non_vendables dont les lignes proposées (p_new) diffèrent des lignes existantes
-- (p_old ; NULL = commande nouvelle). Comparaison ligne à ligne : multiensembles TRIÉS de signatures, produit par produit.
-- NULL = aucune modification interdite.
create or replace function interne.lignes_non_vendables_modifiees(p_new jsonb, p_old jsonb, p_non_vendables text[]) returns text[]
language sql immutable as $$
  with nv as (select case when jsonb_typeof(p_new) = 'array' then p_new else '[]'::jsonb end as js),
       ov as (select case when jsonb_typeof(p_old) = 'array' then p_old else '[]'::jsonb end as js),
       pids as (select distinct e ->> 'produitId' as pid from nv, jsonb_array_elements(nv.js) e
                 where e ->> 'produitId' = any(coalesce(p_non_vendables, '{}'::text[])))
  select array_agg(pid order by pid) from pids
   where (select coalesce(jsonb_agg(interne.l039_signature_ligne(e) order by interne.l039_signature_ligne(e)), '[]'::jsonb)
            from nv, jsonb_array_elements(nv.js) e where e ->> 'produitId' = pids.pid)
         is distinct from
         (select coalesce(jsonb_agg(interne.l039_signature_ligne(o) order by interne.l039_signature_ligne(o)), '[]'::jsonb)
            from ov, jsonb_array_elements(ov.js) o where o ->> 'produitId' = pids.pid)
$$;
revoke all on function interne.lignes_non_vendables_modifiees(jsonb, jsonb, text[]) from public, anon, authenticated;

-- IDENTIFICATION d'une ligne (revue Codex PR 26 sur 66def07) : une ligne ne porte pas toujours un produitId fiable (commande ancienne,
-- article « hors catalogue » « _custom_… », import du site ou de TikTok, WhatsApp : produitId vide et seulement le NOM). Avant, une telle
-- ligne au nom d'un produit non vendable passait. Règle :
--   * produitId d'un produit EXISTANT → ce produit (identifiant fiable, comme avant) ;
--   * sinon, nom (« produit » ou « nom ») égal au NOM NORMALISÉ d'un produit NON VENDABLE, ou référence (« reference », « sku »,
--     « _ugs » TikTok, ou le nom lui-même) égale à sa reference_interne normalisée → la ligne est AMBIGUË et RAPPORTÉE à ce produit
--     (même contrôle « lignes figées » : refusée dans une commande nouvelle ou si elle est ajoutée ou modifiée) ;
--   * sinon → ligne inchangée (hors catalogue, comme avant).
-- Normalisation (même règle que nomNormalise côté serveur et venNorm dans l'application) : minuscules, sans accents, « × » lu « x »,
-- espaces regroupés, « 140 x 190 » = « 140x190 ». Pure.
create or replace function interne.l039_norm(p text) returns text
language sql immutable as $$
  select nullif(regexp_replace(btrim(regexp_replace(
           translate(lower(coalesce(p, '')), 'àâäáãåçéèêëíìîïñóòôöõúùûüýÿ×', 'aaaaaaceeeeiiiinooooouuuuyyx'),
           '\s+', ' ', 'g')), '(\d) ?x ?(\d)', '\1x\2', 'g'), '')
$$;
-- La ligne e DÉSIGNE-t-elle le produit (nom p_nom, référence p_ref) ? Nom (« produit » ou « nom ») égal au nom normalisé, ou référence
-- (« reference », « sku », « _ugs » ou le nom lui-même) égale à la référence normalisée. Jamais NULL (false si rien à comparer). Pure.
-- Même règle que venDesigne (application).
create or replace function interne.l039_designe(e jsonb, p_nom text, p_ref text) returns boolean
language sql immutable as $$
  select coalesce(
           (interne.l039_norm(p_nom) is not null
            and interne.l039_norm(p_nom) in (interne.l039_norm(e ->> 'produit'), interne.l039_norm(e ->> 'nom')))
        or (interne.l039_norm(p_ref) is not null
            and interne.l039_norm(p_ref) in (interne.l039_norm(e ->> 'reference'), interne.l039_norm(e ->> 'sku'),
                                             interne.l039_norm(e ->> '_ugs'), interne.l039_norm(e ->> 'produit'))), false)
$$;
revoke all on function interne.l039_designe(jsonb, text, text) from public, anon, authenticated;
-- Lignes avec leur produit IDENTIFIÉ (produitId remplacé par l'identifiant du produit non vendable reconnu par nom ou référence).
-- Sert seulement à la COMPARAISON : les lignes enregistrées ne sont jamais modifiées. NULL → NULL.
-- Revue Codex PR 26 sur 4ec0313 : un produitId EXISTANT n'est plus fiable à lui seul. Il est gardé si le nom ou la référence de la
-- ligne DÉSIGNE ce produit ; sinon, si le nom ou la référence désigne un produit NON VENDABLE, la ligne est CONTRADICTOIRE (ex.
-- identifiant d'un produit vendable + nom d'un produit interdit) et rapportée à ce produit non vendable : refusée dans une commande
-- nouvelle (insertion comme upsert) ou si elle est ajoutée ou modifiée ; sinon (ni nom ni référence, ou nom libre) → inchangée.
-- Appliqué aux lignes proposées ET aux lignes actuelles : une commande déjà prise inchangée reste modifiable comme avant.
-- Revue Codex PR 26 sur 17f631a : UNE concordance ne suffit plus. Une ligne dont l'identifiant et le nom désignent un produit
-- VENDABLE mais dont un AUTRE champ (sku, référence, _ugs, ancien « nom ») désigne un produit NON VENDABLE est contradictoire :
-- TOUS les champs sont examinés et, si l'un désigne un produit non vendable, la ligne est rapportée à ce produit (refusée si elle
-- est nouvelle). L'identifiant n'est gardé tel quel que s'il désigne lui-même un produit non vendable désigné par la ligne (déjà
-- refusé) ou si aucun champ ne désigne de produit non vendable. Décision PURE (l039_ligne_identifiee), testée par l'auto-contrôle.
--   p_cands = produits candidats : [{"id", "designe" (la ligne le désigne-t-elle ?), "nv" (non vendable ?)}, …]
create or replace function interne.l039_ligne_identifiee(e jsonb, p_cands jsonb) returns jsonb
language sql immutable as $$
  select case
    when exists (select 1 from jsonb_array_elements(coalesce(p_cands, '[]'::jsonb)) c
                  where coalesce(e ->> 'produitId', '') <> '' and c ->> 'id' = e ->> 'produitId'
                    and coalesce((c ->> 'designe')::boolean, false) and coalesce((c ->> 'nv')::boolean, false)) then e
    else coalesce((select e || jsonb_build_object('produitId', c ->> 'id')
                     from jsonb_array_elements(coalesce(p_cands, '[]'::jsonb)) c
                    where coalesce((c ->> 'designe')::boolean, false) and coalesce((c ->> 'nv')::boolean, false)
                    order by c ->> 'id' limit 1), e)
  end
$$;
revoke all on function interne.l039_ligne_identifiee(jsonb, jsonb) from public, anon, authenticated;
create or replace function interne.l039_lignes_identifiees(p jsonb) returns jsonb
language sql stable security definer set search_path = public, interne, pg_catalog as $$
  select case when p is null then null else (
    select coalesce(jsonb_agg(
      interne.l039_ligne_identifiee(e, (
        select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'designe', interne.l039_designe(e, q.nom, q.reference_interne),
                                                     'nv', interne.produit_non_vendable(q.id))), '[]'::jsonb)
          from public.produits q
         where q.id = e ->> 'produitId' or interne.l039_designe(e, q.nom, q.reference_interne)))
      order by t.ord), '[]'::jsonb)
      from jsonb_array_elements(case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end) with ordinality t(e, ord))
  end
$$;
revoke all on function interne.l039_lignes_identifiees(jsonb) from public, anon, authenticated;

create or replace function interne.commandes_produit_vendable_garde() returns trigger
language plpgsql security definer set search_path = public, interne, pg_catalog as $$
declare v_nv text[]; v_modif text[]; v_refus text; v_new jsonb := to_jsonb(new.lignes); v_old jsonb;
begin
  if jsonb_typeof(v_new) is distinct from 'array' then return new; end if;
  if tg_op = 'UPDATE' then v_old := to_jsonb(old.lignes);
  else
    -- enregistrement « upsert » de l'application (INSERT … ON CONFLICT) : le déclencheur INSERT voit la ligne proposée AVANT
    -- la détection du conflit ; si la commande existe déjà, ses lignes actuelles servent de référence (comme pour un UPDATE).
    -- Commande nouvelle : v_old reste NULL, toute ligne d'un produit non vendable est donc refusée.
    select to_jsonb(c.lignes) into v_old from public.commandes c where c.id = new.id;
  end if;
  -- lignes sans produitId fiable : rapportées au produit non vendable reconnu par nom ou référence (revue Codex sur 66def07),
  -- des deux côtés (une commande déjà prise qui le contenait par son seul nom reste modifiable si cette ligne ne change pas)
  v_new := interne.l039_lignes_identifiees(v_new);
  v_old := interne.l039_lignes_identifiees(v_old);
  -- produits non vendables présents dans les lignes proposées (TOUTES les lignes, pas seulement les « nouvelles »)
  select array_agg(distinct p.id) into v_nv
    from public.produits p
   where p.id in (select e ->> 'produitId' from jsonb_array_elements(v_new) e where coalesce(e ->> 'produitId', '') <> '')
     and interne.produit_non_vendable(p.id);
  if v_nv is null then return new; end if;
  v_modif := interne.lignes_non_vendables_modifiees(v_new, v_old, v_nv);
  if v_modif is null then return new; end if;
  select string_agg(p.nom, ', ' order by p.nom) into v_refus from public.produits p where p.id = any(v_modif);
  raise exception 'PRODUIT NON VENDABLE (prix de vente à définir) : % — ligne ajoutée, quantité ou prix modifié : refusé', v_refus
    using errcode = 'P0001';
end $$;
drop trigger if exists commandes_produit_vendable_garde on public.commandes;
create trigger commandes_produit_vendable_garde before insert or update of lignes on public.commandes
  for each row execute function interne.commandes_produit_vendable_garde();

-- Une variante Shopify « certaine » (utilisée pour importer les commandes et publier le stock) ne peut pas pointer vers un
-- produit non vendable. Les fonctions Shopify ne sont pas modifiées.
create or replace function interne.stock_correspondance_vendable_garde() returns trigger
language plpgsql security definer set search_path = public, interne, pg_catalog as $$
begin
  if new.app_produit_id is not null and new.fiabilite = 'certaine' and interne.produit_non_vendable(new.app_produit_id) then
    raise exception 'PRODUIT NON VENDABLE : la variante Shopify % ne peut pas être reliée à % tant que son prix de vente n''est pas défini',
      new.shopify_variant_id, new.app_produit_id using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists stock_correspondance_vendable_garde on public.stock_correspondance;
create trigger stock_correspondance_vendable_garde before insert or update of app_produit_id, fiabilite on public.stock_correspondance
  for each row execute function interne.stock_correspondance_vendable_garde();

-- Un produit qui DEVIENT non vendable (vendable → false, prix « à définir », ensemble dont la composition change) alors qu'une
-- variante Shopify « certaine » pointe vers lui, ou vers un ENSEMBLE qui le contient (devenu non vendable par ce composant), est
-- REFUSÉ (revue Codex sur 82a9b09) : sinon la correspondance resterait utilisée pour importer des commandes et publier le stock.
-- L'administrateur retire d'abord la correspondance (ou la passe en non certaine), puis retire le produit de la vente.
-- Déclencheur AFTER : produit_non_vendable lit l'état NOUVEAU du produit (et de l'ensemble).
create or replace function interne.produits_correspondance_garde() returns trigger
language plpgsql security definer set search_path = public, interne, pg_catalog as $$
declare v_refus text;
begin
  select string_agg(distinct sc.shopify_variant_id::text || ' → ' || sc.app_produit_id, ', ') into v_refus
    from public.stock_correspondance sc
   where sc.fiabilite = 'certaine'
     and (sc.app_produit_id = new.id
          or sc.app_produit_id in (select q.id from public.produits q
                                    where jsonb_typeof(q.composants) = 'array'
                                      and exists (select 1 from jsonb_array_elements(q.composants) c where c ->> 'id' = new.id)))
     and interne.produit_non_vendable(sc.app_produit_id);
  if v_refus is not null then
    raise exception 'PRODUIT NON VENDABLE : « % » est relié à des variantes Shopify « certaines » (%) ; retirer d''abord ces correspondances',
      new.nom, v_refus using errcode = 'P0001';
  end if;
  return null;
end $$;
drop trigger if exists produits_correspondance_garde on public.produits;
create trigger produits_correspondance_garde after update of vendable, prix_vente_defini, composants on public.produits
  for each row execute function interne.produits_correspondance_garde();

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 3. Arrivages, lignes, prix de revient, historique
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.arrivages (
  id bigint generated always as identity primary key,
  reference_interne text not null unique,           -- ex. ARR-2026-11-01 (jamais le numéro de facture dans le dépôt public)
  fournisseur text,
  facture text,
  date_facture date,
  transitaire_facture text,
  navire text,
  bl text,
  devise text not null default 'USD',
  taux_change numeric(12,6) check (taux_change > 0),  -- 1 unité de devise = taux_change €
  taux_provisoire boolean not null default true,
  frais_import_ht numeric(12,2) not null default 0 check (frais_import_ht >= 0), -- transport, transit, douane (€ HT)
  statut text not null default 'en_attente' check (statut in ('en_attente', 'recu', 'annule')),
  recu_le timestamptz,
  ordre_reception bigint unique,                     -- ordre RÉEL des réceptions (séquence tirée après les verrous produits)
  recu_par text,
  remarque text,
  cree_at timestamptz not null default now(),
  maj_at timestamptz not null default now()
);

create table if not exists public.arrivage_lignes (
  id bigint generated always as identity primary key,
  arrivage_id bigint not null references public.arrivages(id) on delete restrict,
  produit_id text not null references public.produits(id) on update cascade on delete restrict,
  quantite_attendue integer not null check (quantite_attendue > 0),
  quantite_recue integer check (quantite_recue >= 0),           -- reçues en BON état (ajoutées au stock)
  quantite_endommagee integer check (quantite_endommagee >= 0), -- reçues abîmées (NON ajoutées au stock)
  quantite_manquante integer check (quantite_manquante >= 0),   -- jamais arrivées
  fob_unitaire numeric(12,4) check (fob_unitaire >= 0),         -- prix d'achat unitaire dans la devise de l'arrivage
  revient_unitaire_ht numeric(12,4) check (revient_unitaire_ht >= 0), -- € HT : FOB × taux + part des frais d'import
  remarque text,
  unique (arrivage_id, produit_id),
  check (quantite_recue is null
         or quantite_recue + coalesce(quantite_endommagee, 0) + coalesce(quantite_manquante, 0) = quantite_attendue)
);
create index if not exists arrivage_lignes_produit_idx on public.arrivage_lignes (produit_id);

-- Ordre des réceptions : tiré dans valider_reception_arrivage APRÈS les verrous sur les produits. Deux réceptions qui touchent
-- un même produit sont sérialisées par ces verrous : la seconde obtient forcément un numéro plus grand. now() (heure de début
-- de transaction) ne le garantit pas, d'où cette séquence (revue Codex).
create sequence if not exists public.arrivages_ordre_reception_seq;
revoke all on sequence public.arrivages_ordre_reception_seq from public, anon, authenticated;

-- Prix de revient HT ACTUEL de chaque produit (valeur de la méthode de valorisation). Administrateur seulement.
create table if not exists public.produits_revient (
  produit_id text primary key references public.produits(id) on update cascade on delete cascade,
  prix_revient_ht numeric(12,4) not null check (prix_revient_ht >= 0),
  methode text not null,
  provisoire boolean not null default false,  -- calculé avec un taux de change provisoire
  maj_at timestamptz not null default now(),
  maj_par text
);

-- Historique par lot (ajout seul). Une correction de taux ajoute une ligne et RELIE l'ancienne (remplace_par) sans la modifier.
create table if not exists public.prix_revient_historique (
  id bigint generated always as identity primary key,
  produit_id text not null references public.produits(id) on update cascade on delete restrict,
  revient_ht numeric(12,4) not null check (revient_ht >= 0),   -- revient unitaire du LOT
  quantite integer not null check (quantite >= 0),             -- quantité entrée en stock pour ce lot
  stock_avant integer,                                         -- produits.stock juste avant la réception
  revient_moyen_avant numeric(12,4),                           -- revient du produit avant (NULL = inconnu)
  revient_moyen_apres numeric(12,4) not null,                  -- revient du produit après (méthode appliquée)
  methode text not null,
  source text not null default 'arrivage' check (source in ('arrivage', 'recalcul_taux')),
  arrivage_id bigint references public.arrivages(id) on delete restrict,
  date timestamptz not null default now(),
  provisoire boolean not null default false,                   -- revient du LOT calculé avec un taux provisoire
  moyen_avant_provisoire boolean,                              -- le revient du produit AVANT était provisoire
  moyen_apres_provisoire boolean not null default false,       -- revient du produit APRÈS provisoire (CUMP qui en intègre un)
  corrige_id bigint references public.prix_revient_historique(id),   -- ligne corrigée (recalcul de taux)
  remplace_par bigint references public.prix_revient_historique(id), -- ligne de correction qui la remplace
  cree_par text
);
create index if not exists prix_revient_historique_produit_idx on public.prix_revient_historique (produit_id, date);

create or replace function interne.prix_revient_historique_fige() returns trigger
language plpgsql set search_path = public, pg_catalog as $$
begin
  if tg_op = 'DELETE' then raise exception 'HISTORIQUE DES PRIX DE REVIENT : suppression interdite' using errcode = 'P0001'; end if;
  -- seule modification permise : relier une ligne PROVISOIRE à sa correction (une seule fois), sans toucher aux valeurs
  if old.provisoire and old.remplace_par is null and new.remplace_par is not null
     and (to_jsonb(new) - 'remplace_par') = (to_jsonb(old) - 'remplace_par') then
    return new;
  end if;
  raise exception 'HISTORIQUE DES PRIX DE REVIENT : modification interdite (ajout seul)' using errcode = 'P0001';
end $$;
drop trigger if exists prix_revient_historique_fige on public.prix_revient_historique;
create trigger prix_revient_historique_fige before update or delete on public.prix_revient_historique
  for each row execute function interne.prix_revient_historique_fige();

-- Droits : lecture ADMINISTRATEUR seulement (comme journal_financier) ; aucune écriture directe depuis l'application :
-- tout passe par les fonctions ci-dessous (ou par un administrateur côté serveur pour le chargement d'un arrivage).
do $$
declare t text;
begin
  foreach t in array array['arrivages', 'arrivage_lignes', 'produits_revient', 'prix_revient_historique'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated, public', t);
    execute format('grant select on table public.%I to anon', t);
    execute format('drop policy if exists sess_admin_lecture on public.%I', t);
    execute format('create policy sess_admin_lecture on public.%I for select to anon using ((select public.session_role()) = ''admin'')', t);
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 4. Méthode de valorisation (CONSTANTE — CHOIX À VALIDER PAR BORHEN) et calcul du revient
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 'CUMP'         : nouveau = (stock_avant × revient_avant + qté_reçue × revient_lot) / (stock_avant + qté_reçue) ;
--                  revient_avant inconnu ou stock_avant ≤ 0 → revient du lot.
-- 'DERNIER_PRIX' : nouveau = revient du dernier lot reçu.
-- Même constante dans l'application : ARR_METHODE_VALORISATION (bloc ARR-DEBUT … ARR-FIN de maxiconfort-v7.html).
create or replace function interne.arrivage_methode_valorisation() returns text
language sql immutable as $$ select 'CUMP'::text $$;

create or replace function interne.revient_apres(p_methode text, p_stock_avant integer, p_revient_avant numeric, p_qte integer, p_revient_lot numeric)
returns numeric language sql immutable as $$
  select case
    when coalesce(p_qte, 0) <= 0 then p_revient_avant
    when p_methode = 'DERNIER_PRIX' or p_revient_avant is null or coalesce(p_stock_avant, 0) <= 0 then round(p_revient_lot, 4)
    else round((p_stock_avant * p_revient_avant + p_qte * p_revient_lot) / (p_stock_avant + p_qte), 4)
  end
$$;

-- Le revient du produit après réception est-il provisoire ? Revient du lot seul (dernier prix, pas de stock, revient inconnu)
-- → selon le lot ; moyenne pondérée → provisoire si le lot OU l'ancien revient l'est.
create or replace function interne.revient_provisoire_apres(p_methode text, p_stock_avant integer, p_revient_avant numeric, p_qte integer,
    p_prov_avant boolean, p_prov_lot boolean)
returns boolean language sql immutable as $$
  select case
    when coalesce(p_qte, 0) <= 0 then coalesce(p_prov_avant, false)
    when p_methode = 'DERNIER_PRIX' or p_revient_avant is null or coalesce(p_stock_avant, 0) <= 0 then coalesce(p_prov_lot, false)
    else coalesce(p_prov_lot, false) or coalesce(p_prov_avant, false)
  end
$$;

-- Revient unitaire HT d'un LOT (revue Codex PR 26 sur 66def07) : CALCULÉ PAR LA BASE, jamais cru sur parole —
--   FOB unitaire × taux de change + frais d'import répartis uniformément sur les quantités ATTENDUES de l'arrivage
--   (frais_u = frais_import_ht / Σ quantite_attendue), arrondi à 4 décimales. Même formule que recalculer_revient_arrivage.
create or replace function interne.l039_revient_lot(p_fob numeric, p_taux numeric, p_frais_u numeric) returns numeric
language sql immutable as $$ select round(p_fob * p_taux + coalesce(p_frais_u, 0), 4) $$;
-- Un revient déjà chargé sur la ligne est-il COHÉRENT avec le calcul ? Tolérance d'arrondi : 1 centime (le fichier de chargement
-- peut arrondir au centime). Absent (NULL) = cohérent : la base le remplit avec sa propre valeur.
create or replace function interne.l039_revient_coherent(p_charge numeric, p_calcule numeric) returns boolean
language sql immutable as $$ select p_charge is null or (p_calcule is not null and abs(p_charge - p_calcule) <= 0.01) $$;

-- EMPREINTE DE VALORISATION (revue Codex PR 26 sur 17f631a) : l'administrateur valide un APERÇU (stock et revient après réception).
-- Si le FOB, le taux, les frais, les quantités attendues, le revient chargé, le revient actuel d'un produit ou la méthode changent
-- entre cet aperçu et la validation, le revient appliqué ne serait plus celui qu'il a vu. L'application envoie donc le TEXTE des
-- valeurs affichées (même construction que arrEmpreinte, maxiconfort-v7.html) ; valider_reception_arrivage le recalcule APRÈS les
-- verrous et REFUSE (« valorisation_modifiee », rien n'est écrit) s'il diffère : nouvel aperçu et nouvelle confirmation obligatoires.
-- v2 (revue Codex PR 26 sur fd751b8) : le STOCK ACTUEL de chaque produit de l'arrivage y entre aussi — le CUMP et l'aperçu en
-- dépendent (stock_avant) : une vente entre l'aperçu et la validation changerait le revient appliqué. Stock changé → refus,
-- nouvel aperçu et nouvelle confirmation (le stock est lu ici après le verrou des produits : il ne peut plus bouger ensuite).
-- Nombres à ÉCHELLE FIXE (celle des colonnes : taux 6, frais 2, FOB et revients 4 décimales), vide si absent. Pures.
create or replace function interne.l039_fmt(p numeric, p_dec integer) returns text
language sql immutable as $$ select coalesce(round(p, p_dec)::text, '') $$;
-- p_lignes = [{"id", "produit_id", "quantite_attendue", "fob_unitaire", "revient_unitaire_ht", "revient_avant", "revient_avant_provisoire",
--             "stock_avant"}, …]
create or replace function interne.l039_empreinte(p_methode text, p_taux numeric, p_frais numeric, p_prov boolean, p_lignes jsonb) returns text
language sql immutable as $$
  select 'v2|' || coalesce(p_methode, '') || '|' || interne.l039_fmt(p_taux, 6) || '|' || interne.l039_fmt(p_frais, 2) || '|'
      || case when p_prov then 't' else 'f' end
      || coalesce((select string_agg('|' || coalesce(e ->> 'id', '') || ':' || coalesce(e ->> 'produit_id', '') || ':'
                                     || coalesce(e ->> 'quantite_attendue', '') || ':' || interne.l039_fmt((e ->> 'fob_unitaire')::numeric, 4) || ':'
                                     || interne.l039_fmt((e ->> 'revient_unitaire_ht')::numeric, 4) || ':'
                                     || interne.l039_fmt((e ->> 'revient_avant')::numeric, 4) || ':'
                                     || case (e ->> 'revient_avant_provisoire')::boolean when true then 't' when false then 'f' else '' end || ':'
                                     || coalesce(e ->> 'stock_avant', ''),
                                     '' order by (e ->> 'id')::bigint)
                     from jsonb_array_elements(case when jsonb_typeof(p_lignes) = 'array' then p_lignes else '[]'::jsonb end) e), '')
$$;
-- Empreinte ACTUELLE d'un arrivage (lue dans les tables). NULL si l'arrivage n'existe pas.
create or replace function interne.l039_empreinte_valorisation(p_arrivage_id bigint, p_methode text) returns text
language sql stable security definer set search_path = public, interne, pg_catalog as $$
  select interne.l039_empreinte(p_methode, a.taux_change, a.frais_import_ht, a.taux_provisoire,
           (select jsonb_agg(jsonb_build_object('id', l.id, 'produit_id', l.produit_id, 'quantite_attendue', l.quantite_attendue,
                     'fob_unitaire', l.fob_unitaire, 'revient_unitaire_ht', l.revient_unitaire_ht,
                     'revient_avant', r.prix_revient_ht, 'revient_avant_provisoire', r.provisoire,
                     'stock_avant', coalesce(p.stock, 0)::integer))
              from public.arrivage_lignes l left join public.produits_revient r on r.produit_id = l.produit_id
                   left join public.produits p on p.id = l.produit_id
             where l.arrivage_id = a.id))
    from public.arrivages a where a.id = p_arrivage_id
$$;
revoke all on function interne.l039_fmt(numeric, integer) from public, anon, authenticated;
revoke all on function interne.l039_empreinte(text, numeric, numeric, boolean, jsonb) from public, anon, authenticated;
revoke all on function interne.l039_empreinte_valorisation(bigint, text) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 5. Validation de la réception (ADMINISTRATEUR, une seule fois, atomique)
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- stock_entrees (migration 025) reçoit aussi chaque entrée d'arrivage (motif « arrivage:<réf> ») : stock-sync-shopify et
-- l'estimation de JARVIS comptent le stock à partir du dernier comptage validé + stock_entrees, jamais depuis produits.stock ;
-- l'application, elle, lit produits.stock et jamais stock_entrees : chaque source compte donc la réception UNE seule fois.
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.stock_entrees'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%motif%' loop
    execute format('alter table public.stock_entrees drop constraint %I', c.conname);
  end loop;
  alter table public.stock_entrees add constraint stock_entrees_motif_check
    check (motif in ('reassort', 'retour_gls', 'reprise_sav', 'correction') or motif like 'arrivage:%');
end $$;

-- p_lignes = [{"ligne_id": 12, "recue": 38, "endommagee": 1, "manquante": 1}, …] : UNE entrée par ligne de l'arrivage,
-- avec recue + endommagee + manquante = quantité attendue. Tout ou rien : la moindre erreur annule toute l'opération.
-- p_empreinte (revue Codex PR 26 sur 17f631a) = empreinte des valeurs de valorisation VUES dans l'aperçu (interne.l039_empreinte) :
-- obligatoire, comparée APRÈS les verrous à l'empreinte actuelle ; différente → « valorisation_modifiee », rien n'est écrit.
-- (Ancienne signature à 2 arguments supprimée : aucune validation possible sans empreinte.)
drop function if exists public.valider_reception_arrivage(bigint, jsonb);
-- Verrous, toujours dans le même ordre (comme recalculer_revient_arrivage) : arrivage → produits (par id) → produits_revient
-- (par produit_id), AVANT toute lecture de l'ancienne valorisation.
create or replace function public.valider_reception_arrivage(p_arrivage_id bigint, p_lignes jsonb, p_empreinte text) returns json
language plpgsql volatile security definer set search_path = public, interne, pg_catalog as $$
declare
  a public.arrivages%rowtype;
  l record; s jsonb; p record;
  v_methode text := interne.arrivage_methode_valorisation();
  v_rec integer; v_end integer; v_man integer;
  v_rev_avant numeric; v_prov_avant boolean; v_rev_apres numeric; v_prov_apres boolean; v_stock_avant integer;
  v_nb integer; v_resultat jsonb := '[]'::jsonb; v_total_recu integer := 0; v_ordre bigint; v_instant timestamptz;
  v_total_att integer; v_sans_fob integer; v_frais_u numeric; v_rev_lot numeric;
begin
  if (select public.session_role()) is distinct from 'admin' then
    return json_build_object('ok', false, 'erreur', 'session_admin_requise');
  end if;
  -- verrou : deux validations simultanées attendent l'une l'autre ; la seconde voit le statut « recu » et est refusée
  select * into a from public.arrivages where id = p_arrivage_id for update;
  if not found then return json_build_object('ok', false, 'erreur', 'arrivage_introuvable'); end if;
  if a.statut <> 'en_attente' then
    return json_build_object('ok', false, 'erreur', 'arrivage_deja_traite', 'statut', a.statut);
  end if;
  if jsonb_typeof(p_lignes) is distinct from 'array' then return json_build_object('ok', false, 'erreur', 'lignes_invalides'); end if;
  if coalesce(p_empreinte, '') = '' then return json_build_object('ok', false, 'erreur', 'empreinte_requise'); end if;
  -- lignes de l'arrivage verrouillées (ordre fixe : arrivage → lignes → produits → produits_revient) : FOB et revient chargé ne
  -- peuvent plus changer entre la comparaison d'empreinte ci-dessous et la valorisation
  perform 1 from public.arrivage_lignes where arrivage_id = a.id order by id for update;
  select count(*) into v_nb from public.arrivage_lignes where arrivage_id = a.id;
  if v_nb = 0 then return json_build_object('ok', false, 'erreur', 'arrivage_sans_ligne'); end if;
  if jsonb_array_length(p_lignes) <> v_nb
     or (select count(distinct (e ->> 'ligne_id')) from jsonb_array_elements(p_lignes) e) <> v_nb then
    return json_build_object('ok', false, 'erreur', 'une_saisie_par_ligne_requise');
  end if;
  -- revient de chaque lot CALCULÉ ici (revue Codex sur 66def07) : FOB et taux de change obligatoires, frais répartis sur les
  -- quantités attendues ; un revient chargé qui contredit ce calcul (au-delà d'un centime) est refusé plus bas, ligne par ligne
  if a.taux_change is null then return json_build_object('ok', false, 'erreur', 'taux_manquant'); end if;
  select sum(quantite_attendue), count(*) filter (where fob_unitaire is null) into v_total_att, v_sans_fob
    from public.arrivage_lignes where arrivage_id = a.id;
  if v_sans_fob > 0 then return json_build_object('ok', false, 'erreur', 'fob_manquant'); end if;
  v_frais_u := a.frais_import_ht / v_total_att;

  -- verrous dans un ordre fixe (pas d'interblocage avec une autre réception ni un recalcul) : produits, PUIS produits_revient
  perform 1 from public.produits where id in (select produit_id from public.arrivage_lignes where arrivage_id = a.id) order by id for update;
  perform 1 from public.produits_revient where produit_id in (select produit_id from public.arrivage_lignes where arrivage_id = a.id) order by produit_id for update;
  -- valeurs de valorisation VUES dans l'aperçu (revue Codex PR 26 sur 17f631a) : comparées ici, tous verrous pris et AVANT toute
  -- écriture ; FOB, taux, frais, quantités, revient chargé, revient actuel, STOCK actuel (v2, revue sur fd751b8) ou méthode changés
  -- → refus, nouvel aperçu à confirmer
  if p_empreinte is distinct from interne.l039_empreinte_valorisation(a.id, v_methode) then
    return json_build_object('ok', false, 'erreur', 'valorisation_modifiee');
  end if;
  -- ordre de réception tiré APRÈS les verrous : il suit l'ordre réel de valorisation (rejoué par recalculer_revient_arrivage)
  v_ordre := nextval('public.arrivages_ordre_reception_seq');
  -- instant RÉEL de la réception, pris au même moment (après les verrous) : clock_timestamp() et non now() (début de
  -- transaction), sinon une réception qui a attendu un verrou serait antidatée et une entrée finie après la fin d'un comptage
  -- serait exclue du calcul de stock (date_entree > fin du comptage)
  v_instant := clock_timestamp();

  for l in select * from public.arrivage_lignes where arrivage_id = a.id order by produit_id loop
    select e into s from jsonb_array_elements(p_lignes) e where e ->> 'ligne_id' = l.id::text;
    if s is null then raise exception 'SAISIE MANQUANTE pour la ligne %', l.id using errcode = 'P0001'; end if;
    begin
      -- relecture complète PR 26 : les TROIS quantités sont obligatoires (avant : endommagé ou manquant absent = 0 par défaut)
      v_rec := (s ->> 'recue')::integer; v_end := (s ->> 'endommagee')::integer; v_man := (s ->> 'manquante')::integer;
    exception when others then raise exception 'SAISIE INVALIDE pour la ligne % (nombres entiers attendus)', l.id using errcode = 'P0001';
    end;
    if v_rec is null or v_end is null or v_man is null or v_rec < 0 or v_end < 0 or v_man < 0 then
      raise exception 'SAISIE INVALIDE pour la ligne % (trois quantités entières, positives ou nulles, obligatoires)', l.id using errcode = 'P0001';
    end if;
    if v_rec + v_end + v_man <> l.quantite_attendue then
      raise exception 'CONTRÔLE : ligne % — reçu % + endommagé % + manquant % ≠ attendu %', l.id, v_rec, v_end, v_man, l.quantite_attendue using errcode = 'P0001';
    end if;
    v_rev_lot := interne.l039_revient_lot(l.fob_unitaire, a.taux_change, v_frais_u);
    if not interne.l039_revient_coherent(l.revient_unitaire_ht, v_rev_lot) then
      raise exception 'REVIENT INCOHÉRENT pour la ligne % : le revient chargé ne correspond pas à FOB × taux + frais (écart > 0,01 €)', l.id
        using errcode = 'P0001';
    end if;

    -- la ligne garde le revient CALCULÉ par la base (c'est lui qui valorise le stock et entre dans l'historique)
    update public.arrivage_lignes set quantite_recue = v_rec, quantite_endommagee = v_end, quantite_manquante = v_man,
      revient_unitaire_ht = v_rev_lot where id = l.id;

    select id, nom, stock into p from public.produits where id = l.produit_id;
    v_stock_avant := coalesce(p.stock, 0);
    v_rev_avant := null; v_prov_avant := false;
    select prix_revient_ht, provisoire into v_rev_avant, v_prov_avant from public.produits_revient where produit_id = l.produit_id;
    v_prov_avant := coalesce(v_prov_avant, false);
    v_rev_apres := v_rev_avant; v_prov_apres := v_prov_avant;
    if v_rec > 0 then
      -- seules les quantités reçues en BON état entrent dans le stock disponible
      update public.produits set stock = coalesce(stock, 0) + v_rec, updated_at = now() where id = l.produit_id;
      insert into public.mouvements_stock (type, produit_libelle, quantite, source, destination, commande_id, tournee_id, livreur, par_user)
        values ('entree', p.nom, v_rec, 'arrivage:' || a.reference_interne, 'depot', null, null, null, 'admin');
      insert into public.stock_entrees (date_entree, app_produit_id, quantite, motif, cmd_id, saisi_par, remarque)
        values (v_instant, l.produit_id, v_rec, 'arrivage:' || a.reference_interne, null, 'admin', 'Réception d''arrivage validée dans l''application');
      v_rev_apres := interne.revient_apres(v_methode, v_stock_avant, v_rev_avant, v_rec, v_rev_lot);
      -- un CUMP qui intègre un revient encore PROVISOIRE reste provisoire
      v_prov_apres := interne.revient_provisoire_apres(v_methode, v_stock_avant, v_rev_avant, v_rec, v_prov_avant, a.taux_provisoire);
      insert into public.produits_revient (produit_id, prix_revient_ht, methode, provisoire, maj_at, maj_par)
        values (l.produit_id, v_rev_apres, v_methode, v_prov_apres, now(), 'admin')
        on conflict (produit_id) do update set prix_revient_ht = excluded.prix_revient_ht, methode = excluded.methode,
          provisoire = excluded.provisoire, maj_at = excluded.maj_at, maj_par = excluded.maj_par;
      insert into public.prix_revient_historique (produit_id, revient_ht, quantite, stock_avant, revient_moyen_avant, revient_moyen_apres,
          methode, source, arrivage_id, provisoire, moyen_avant_provisoire, moyen_apres_provisoire, cree_par)
        values (l.produit_id, v_rev_lot, v_rec, v_stock_avant, v_rev_avant, v_rev_apres, v_methode, 'arrivage', a.id, a.taux_provisoire,
          v_prov_avant, v_prov_apres, 'admin');
      v_total_recu := v_total_recu + v_rec;
    end if;
    v_resultat := v_resultat || jsonb_build_object('produit_id', l.produit_id, 'recue', v_rec, 'endommagee', v_end, 'manquante', v_man,
      'stock_avant', v_stock_avant, 'stock_apres', v_stock_avant + v_rec, 'revient_avant', v_rev_avant, 'revient_apres', v_rev_apres,
      'revient_provisoire', v_prov_apres);
  end loop;

  update public.arrivages set statut = 'recu', recu_le = v_instant, ordre_reception = v_ordre, recu_par = 'admin', maj_at = now() where id = a.id;
  return json_build_object('ok', true, 'arrivage', a.reference_interne, 'methode', v_methode, 'total_recu', v_total_recu, 'lignes', v_resultat);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 6. Taux de change définitif (ADMINISTRATEUR, une seule fois par arrivage)
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- revient d'une ligne = FOB × taux + frais d'import répartis uniformément sur les quantités attendues.
-- Arrivage en attente : seules les lignes changent. Arrivage reçu : lignes + revient des produits + historique.
-- Revient du produit : REJOUÉ DEPUIS LE DÉPART (revue Codex) — tous les lots du produit (lignes 'arrivage' de l'historique),
-- dans l'ordre RÉEL de RÉCEPTION (arrivages.ordre_reception, tiré après les verrous ; puis id de l'arrivage), chacun avec son revient EFFECTIF (sa correction de taux
-- si elle existe, sinon son revient d'origine ; pour l'arrivage corrigé ici : le nouveau revient), sa quantité REÇUE et le stock
-- réel enregistré juste avant sa réception (stock_avant), en partant de la valorisation d'avant le tout premier lot.
-- Le résultat ne dépend donc ni de l'ordre des corrections, ni d'une valeur intermédiaire périmée, ni du stock courant.
-- Provisoire : un lot jamais corrigé reste provisoire ; le revient du produit l'est si un lot rejoué qu'il intègre l'est
-- (interne.revient_provisoire_apres ; un lot reçu sur un stock nul repart de son seul revient).
-- Historique jamais réécrit : UNE ligne de correction ('recalcul_taux') pour le lot de cet arrivage, reliée à l'original
-- (remplace_par) ; les autres lots ne changent pas de revient et gardent leurs lignes telles quelles.
-- Verrous dans le même ordre que valider_reception_arrivage : arrivage → produits → produits_revient, avant toute lecture.
-- Les commandes ne sont jamais touchées.
create or replace function public.recalculer_revient_arrivage(p_arrivage_id bigint, p_nouveau_taux numeric) returns json
language plpgsql volatile security definer set search_path = public, interne, pg_catalog as $$
declare
  a public.arrivages%rowtype; l record; h record; x record;
  v_total integer; v_frais_u numeric; v_rev numeric; v_id bigint; v_res jsonb := '[]'::jsonb;
  v_cur numeric; v_prov boolean; v_premier boolean; v_nb integer;
  v_h_avant numeric; v_h_prov_avant boolean; v_h_apres numeric; v_h_prov_apres boolean;
begin
  if (select public.session_role()) is distinct from 'admin' then
    return json_build_object('ok', false, 'erreur', 'session_admin_requise');
  end if;
  if p_nouveau_taux is null or p_nouveau_taux <= 0 or p_nouveau_taux > 100 then
    return json_build_object('ok', false, 'erreur', 'taux_invalide');
  end if;
  select * into a from public.arrivages where id = p_arrivage_id for update;
  if not found then return json_build_object('ok', false, 'erreur', 'arrivage_introuvable'); end if;
  if a.statut = 'annule' then return json_build_object('ok', false, 'erreur', 'arrivage_annule'); end if;
  if not a.taux_provisoire then return json_build_object('ok', false, 'erreur', 'taux_deja_definitif'); end if;
  select sum(quantite_attendue), count(*) filter (where fob_unitaire is null) into v_total, v_id from public.arrivage_lignes where arrivage_id = a.id;
  if coalesce(v_total, 0) = 0 then return json_build_object('ok', false, 'erreur', 'arrivage_sans_ligne'); end if;
  if v_id > 0 then return json_build_object('ok', false, 'erreur', 'fob_manquant'); end if;
  v_frais_u := a.frais_import_ht / v_total;

  if a.statut = 'recu' then
    perform 1 from public.produits where id in (select produit_id from public.arrivage_lignes where arrivage_id = a.id) order by id for update;
    perform 1 from public.produits_revient where produit_id in (select produit_id from public.arrivage_lignes where arrivage_id = a.id) order by produit_id for update;
  end if;
  for l in select * from public.arrivage_lignes where arrivage_id = a.id order by produit_id loop
    v_rev := round(l.fob_unitaire * p_nouveau_taux + v_frais_u, 4);
    update public.arrivage_lignes set revient_unitaire_ht = v_rev where id = l.id;
    if a.statut = 'recu' then
      select * into h from public.prix_revient_historique
       where arrivage_id = a.id and produit_id = l.produit_id and source = 'arrivage' and remplace_par is null;
      if found then
        -- rejeu de TOUS les lots du produit, dans l'ordre de réception, revient effectif de chaque lot
        v_cur := null; v_prov := false; v_premier := true; v_nb := 0;
        for x in
          select o.id, o.arrivage_id, o.methode, o.stock_avant, o.quantite, o.revient_moyen_avant, o.moyen_avant_provisoire,
                 case when o.arrivage_id = a.id then v_rev else coalesce(c.revient_ht, o.revient_ht) end as revient_effectif,
                 case when o.arrivage_id = a.id then false when c.id is not null then c.provisoire else o.provisoire end as provisoire_effectif
            from public.prix_revient_historique o
            join public.arrivages ar on ar.id = o.arrivage_id
            left join public.prix_revient_historique c on c.id = o.remplace_par
           where o.produit_id = l.produit_id and o.source = 'arrivage'
           order by ar.ordre_reception nulls last, ar.id, o.id
        loop
          if v_premier then  -- valorisation d'avant le tout premier lot de l'historique
            v_cur := x.revient_moyen_avant; v_prov := coalesce(x.moyen_avant_provisoire, false); v_premier := false;
          end if;
          if x.arrivage_id = a.id then v_h_avant := v_cur; v_h_prov_avant := v_prov; end if;
          v_prov := interne.revient_provisoire_apres(x.methode, x.stock_avant, v_cur, x.quantite, v_prov, x.provisoire_effectif);
          v_cur := interne.revient_apres(x.methode, x.stock_avant, v_cur, x.quantite, x.revient_effectif);
          if x.arrivage_id = a.id then v_h_apres := v_cur; v_h_prov_apres := v_prov; end if;
          v_nb := v_nb + 1;
        end loop;
        insert into public.prix_revient_historique (produit_id, revient_ht, quantite, stock_avant, revient_moyen_avant, revient_moyen_apres,
            methode, source, arrivage_id, provisoire, moyen_avant_provisoire, moyen_apres_provisoire, corrige_id, cree_par)
          values (l.produit_id, v_rev, h.quantite, h.stock_avant, v_h_avant, v_h_apres, h.methode, 'recalcul_taux', a.id, false,
            v_h_prov_avant, v_h_prov_apres, h.id, 'admin')
          returning id into v_id;
        update public.prix_revient_historique set remplace_par = v_id where id = h.id;
        update public.produits_revient set prix_revient_ht = v_cur, provisoire = v_prov, maj_at = now(), maj_par = 'admin'
         where produit_id = l.produit_id;
        v_res := v_res || jsonb_build_object('produit_id', l.produit_id, 'revient_lot', v_rev, 'lots_rejoues', v_nb,
          'revient_produit', v_cur, 'revient_provisoire', v_prov);
      end if;
    else
      v_res := v_res || jsonb_build_object('produit_id', l.produit_id, 'revient_lot', v_rev);
    end if;
  end loop;
  update public.arrivages set taux_change = p_nouveau_taux, taux_provisoire = false, maj_at = now() where id = a.id;
  return json_build_object('ok', true, 'arrivage', a.reference_interne, 'lignes', v_res);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 7. Stock ENTRANT (arrivages en attente) — administrateur et collaboratrice, SANS aucun prix
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.stock_entrant() returns table (produit_id text, quantite bigint, arrivages bigint)
language plpgsql stable security definer set search_path = public, pg_catalog as $$
begin
  if coalesce((select public.session_role()), '') not in ('admin', 'collab') then return; end if;
  return query
    select l.produit_id, sum(l.quantite_attendue)::bigint, count(distinct l.arrivage_id)::bigint
      from public.arrivage_lignes l join public.arrivages a on a.id = l.arrivage_id
     where a.statut = 'en_attente'
     group by l.produit_id;
end $$;

revoke all on function public.valider_reception_arrivage(bigint, jsonb, text) from public, anon, authenticated;
revoke all on function public.recalculer_revient_arrivage(bigint, numeric) from public, anon, authenticated;
revoke all on function public.stock_entrant() from public, anon, authenticated;
grant execute on function public.valider_reception_arrivage(bigint, jsonb, text) to anon;
grant execute on function public.recalculer_revient_arrivage(bigint, numeric) to anon;
grant execute on function public.stock_entrant() to anon;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 8. Contrôle à l'application de la migration : mouvements_stock accepte une entrée « entree » (essai annulé, rien n'est écrit)
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
do $$
begin
  begin
    insert into public.mouvements_stock (type, produit_libelle, quantite, source, destination, commande_id, tournee_id, livreur, par_user)
      values ('entree', '#TEST-ARRIVAGE', 1, 'arrivage:#TEST', 'depot', null, null, null, 'admin');
    raise exception 'essai_annule';
  exception when others then
    if sqlerrm <> 'essai_annule' then
      raise exception 'mouvements_stock refuse une entrée d''arrivage (%). Migration annulée : adapter l''insertion de valider_reception_arrivage.', sqlerrm;
    end if;
  end;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 9. Auto-contrôle à l'application : lignes figées des produits non vendables (fonction PURE, valeurs fictives, rien n'est écrit)
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
do $$
declare
  o jsonb := '[{"produitId":"nv","qte":2,"prixUnit":10,"prixBrut":20,"remiseLigne":0,"sousTotal":20},
               {"produitId":"nv","qte":1,"prixUnit":10,"prixBrut":10,"remiseLigne":0,"sousTotal":10},
               {"produitId":"ok","qte":1,"prixUnit":5,"prixBrut":5,"remiseLigne":0,"sousTotal":5}]';
  nv text[] := array['nv'];
  f text;
begin
  -- [cas, lignes proposées, lignes existantes, résultat attendu (NULL = accepté)]
  if interne.lignes_non_vendables_modifiees(o, o, nv) is not null then f := 'identique'; end if;
  if interne.lignes_non_vendables_modifiees(
       '[{"produitId":"ok","qte":3,"prixUnit":5,"prixBrut":15,"remiseLigne":0,"sousTotal":15},
         {"produitId":"nv","qte":1,"prixUnit":10,"prixBrut":10,"remiseLigne":0,"sousTotal":10},
         {"produitId":"nv","qte":2,"prixUnit":10,"prixBrut":20,"remiseLigne":0,"sousTotal":20}]', o, nv) is not null then f := 'ordre / produit vendable modifié'; end if;
  if interne.lignes_non_vendables_modifiees('[{"produitId":"ok","qte":1,"prixUnit":5}]', o, nv) is not null then f := 'retrait total'; end if;
  if interne.lignes_non_vendables_modifiees(
       '[{"produitId":"nv","qte":3,"prixUnit":10,"prixBrut":30,"remiseLigne":0,"sousTotal":30},
         {"produitId":"nv","qte":1,"prixUnit":10,"prixBrut":10,"remiseLigne":0,"sousTotal":10}]', o, nv) is distinct from nv then f := 'quantité'; end if;
  if interne.lignes_non_vendables_modifiees(
       '[{"produitId":"nv","qte":2,"prixUnit":9,"prixBrut":18,"remiseLigne":0,"sousTotal":18},
         {"produitId":"nv","qte":1,"prixUnit":10,"prixBrut":10,"remiseLigne":0,"sousTotal":10}]', o, nv) is distinct from nv then f := 'prix'; end if;
  if interne.lignes_non_vendables_modifiees(o || '[{"produitId":"nv","qte":1,"prixUnit":10,"prixBrut":10,"remiseLigne":0,"sousTotal":10}]'::jsonb, o, nv)
       is distinct from nv then f := 'ligne en double ajoutée'; end if;
  if interne.lignes_non_vendables_modifiees('[{"produitId":"nv","qte":1,"prixUnit":10,"prixBrut":10,"remiseLigne":0,"sousTotal":10}]', o, nv)
       is distinct from nv then f := 'une occurrence retirée'; end if;
  if interne.lignes_non_vendables_modifiees(o, null, nv) is distinct from nv then f := 'commande nouvelle'; end if;
  if f is not null then
    raise exception 'Auto-contrôle 039 (lignes figées) en échec : cas « % ». Migration annulée.', f;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 10. Auto-contrôle à l'application : revient d'un lot calculé par la base, identification des lignes par nom (fonctions PURES,
--     valeurs FICTIVES, rien n'est écrit)
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
do $$
declare f text;
begin
  -- FOB 10 × taux 1,1 + frais 30 répartis sur 3 attendus (10 par unité) = 21
  if interne.l039_revient_lot(10, 1.1, 30.0 / 3) <> 21 then f := 'revient du lot'; end if;
  if interne.l039_revient_lot(1, 1, 10.0 / 3) <> 4.3333 then f := 'revient arrondi à 4 décimales'; end if;
  if not interne.l039_revient_coherent(null, 21) then f := 'revient absent = rempli par la base'; end if;
  if not interne.l039_revient_coherent(21.004, 21) then f := 'écart d''arrondi accepté'; end if;
  if not interne.l039_revient_coherent(21.01, 21) then f := 'écart d''un centime accepté'; end if;
  if interne.l039_revient_coherent(21.02, 21) then f := 'écart de 2 centimes refusé'; end if;
  if interne.l039_revient_coherent(15, 21) then f := 'revient contredisant FOB, taux et frais refusé'; end if;
  if interne.l039_revient_coherent(21, null) then f := 'calcul impossible refusé'; end if;
  if interne.l039_norm('  Matelas  Fictif ÉTÉ 140 × 190 x 25 ') is distinct from 'matelas fictif ete 140x190x25' then f := 'nom normalisé'; end if;
  if interne.l039_norm('   ') is not null then f := 'nom vide'; end if;
  -- désignation d'un produit par une ligne (revue Codex sur 4ec0313 : produitId et nom contradictoires)
  if not interne.l039_designe('{"produitId":"pr-a","produit":"matelas fictif a 140 x 190"}', 'Matelas Fictif A 140×190', null) then f := 'nom désignant le produit de l''identifiant'; end if;
  if interne.l039_designe('{"produitId":"pr-a","produit":"Matelas Nouveau N (fictif)"}', 'Matelas Fictif A 140×190', null) then f := 'nom désignant un autre produit'; end if;
  if not interne.l039_designe('{"produit":"Article TikTok","_ugs":"mc-test-1"}', 'Matelas Nouveau N (fictif)', 'MC-TEST-1') then f := 'référence désignant le produit'; end if;
  if interne.l039_designe('{"produitId":"pr-a"}', 'Matelas Fictif A 140×190', null) then f := 'ligne sans nom ni référence'; end if;
  if interne.l039_designe('{"produit":"  "}', '  ', '') then f := 'nom et référence vides'; end if;
  -- identification avec TOUS les champs (revue Codex sur 17f631a) : identifiant et nom vendables + sku d'un produit non vendable
  if interne.l039_ligne_identifiee('{"produitId":"pr-a","produit":"Matelas Fictif A 140×190","sku":"MC-TEST-1"}',
       '[{"id":"pr-a","designe":true,"nv":false},{"id":"pr-n","designe":true,"nv":true}]') ->> 'produitId' is distinct from 'pr-n'
    then f := 'identifiant et nom vendables, sku d''un produit non vendable'; end if;
  if interne.l039_ligne_identifiee('{"produitId":"pr-a","produit":"Matelas Fictif A 140×190"}', '[{"id":"pr-a","designe":true,"nv":false}]')
       ->> 'produitId' is distinct from 'pr-a' then f := 'identifiant et nom vendables, rien de non vendable'; end if;
  if interne.l039_ligne_identifiee('{"produitId":"pr-n","produit":"Matelas Nouveau N (fictif)"}',
       '[{"id":"pr-n","designe":true,"nv":true},{"id":"pr-0","designe":true,"nv":true}]') ->> 'produitId' is distinct from 'pr-n'
    then f := 'identifiant non vendable désigné gardé'; end if;
  if interne.l039_ligne_identifiee('{"produit":"Matelas Nouveau N (fictif)"}', '[{"id":"pr-n","designe":true,"nv":true}]')
       ->> 'produitId' is distinct from 'pr-n' then f := 'nom seul d''un produit non vendable'; end if;
  if interne.l039_ligne_identifiee('{"produit":"Libre"}', '[]') is distinct from '{"produit":"Libre"}'::jsonb then f := 'ligne libre inchangée'; end if;
  -- empreinte de valorisation : MÊME texte attendu que arrEmpreinte (application, banc outils/test-arrivage.js)
  if interne.l039_empreinte('CUMP', 1.1, 30, true,
       '[{"id":72,"produit_id":"pr-n","quantite_attendue":40,"fob_unitaire":20,"revient_unitaire_ht":null,"revient_avant":null,"revient_avant_provisoire":null,"stock_avant":0},
         {"id":71,"produit_id":"pr-a","quantite_attendue":30,"fob_unitaire":10.5,"revient_unitaire_ht":12.25,"revient_avant":40,"revient_avant_provisoire":false,"stock_avant":10}]')
       is distinct from 'v2|CUMP|1.100000|30.00|t|71:pr-a:30:10.5000:12.2500:40.0000:f:10|72:pr-n:40:20.0000::::0'
    then f := 'empreinte de valorisation'; end if;
  -- v2 (revue Codex sur fd751b8) : stock actuel d'un produit changé (vente entre l'aperçu et la validation) → empreinte différente
  if interne.l039_empreinte('CUMP', 1.1, 30, true, '[{"id":71,"produit_id":"pr-a","quantite_attendue":30,"fob_unitaire":10.5,"stock_avant":10}]')
     = interne.l039_empreinte('CUMP', 1.1, 30, true, '[{"id":71,"produit_id":"pr-a","quantite_attendue":30,"fob_unitaire":10.5,"stock_avant":9}]')
    then f := 'empreinte : stock changé'; end if;
  -- état de vente (revue Codex sur fd751b8) : insertion et modification
  if interne.l039_etat_vente_refus('INSERT', null, true, true, null) is distinct from 'prix_null' then f := 'insertion prix défini sans prix'; end if;
  if interne.l039_etat_vente_refus('UPDATE', true, true, true, null) is distinct from 'prix_null' then f := 'modification prix retiré, prix défini'; end if;
  if interne.l039_etat_vente_refus('UPDATE', true, true, false, null) is distinct from 'prix_null' then f := 'modification non vendable, prix défini sans prix'; end if;
  if interne.l039_etat_vente_refus('UPDATE', false, true, true, null) is distinct from 'prix_obligatoire' then f := 'modification prix défini sans prix'; end if;
  if interne.l039_etat_vente_refus('UPDATE', false, true, true, 0) is distinct from 'prix_obligatoire' then f := 'modification prix défini à 0'; end if;
  if interne.l039_etat_vente_refus('INSERT', null, false, true, null) is distinct from 'sans_prix_vendable' then f := 'insertion vendable sans prix défini'; end if;
  if interne.l039_etat_vente_refus('INSERT', null, false, false, null) is not null then f := 'insertion à définir non vendable acceptée'; end if;
  if interne.l039_etat_vente_refus('INSERT', null, true, true, 0) is not null then f := 'création ordinaire (prix 0) acceptée'; end if;
  if interne.l039_etat_vente_refus('UPDATE', false, true, true, 120) is not null then f := 'prix fixé (> 0) accepté'; end if;
  if interne.l039_etat_vente_refus('UPDATE', true, true, false, 90) is not null then f := 'retrait de la vente accepté'; end if;
  if interne.l039_empreinte('CUMP', 1.1, 30, true, '[]') = interne.l039_empreinte('CUMP', 1.2, 30, true, '[]') then f := 'empreinte : taux changé'; end if;
  if interne.l039_empreinte('CUMP', 1.1, 30, true, '[]') = interne.l039_empreinte('CUMP', 1.1, 31, true, '[]') then f := 'empreinte : frais changés'; end if;
  if interne.l039_fmt(null, 4) <> '' or interne.l039_fmt(21, 4) <> '21.0000' then f := 'nombre à échelle fixe'; end if;
  if f is not null then
    raise exception 'Auto-contrôle 039 (revient / identification) en échec : cas « % ». Migration annulée.', f;
  end if;
end $$;
