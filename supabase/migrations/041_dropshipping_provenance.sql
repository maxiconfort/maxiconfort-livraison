-- 041 (26/11/2026) : DROPSHIPPING ENCADRÉ ET PROVENANCE DE CHAQUE PIÈCE — trois points de contrôle (pare-feu) par pièce, tenus
-- par le livreur (décisions de Borhen des 25 et 26/11/2026).
--
-- RETOUR ARRIÈRE (à exécuter tel quel dans l'éditeur SQL si besoin ; aucune commande, aucun stock, aucune dépense n'est
-- supprimé ni modifié) :
--   1) remettre les fonctions de la 040 (conservées telles quelles par la 041 sous les noms interne.l041_deduire_040 et
--      interne.l041_recrediter_040) et retirer le déclencheur du « livré » :
--        drop function if exists public.deduire_stock_livraison(text);
--        alter function interne.l041_deduire_040(text) rename to deduire_stock_livraison;
--        alter function interne.deduire_stock_livraison(text) set schema public;
--        grant execute on function public.deduire_stock_livraison(text) to anon;
--        drop function if exists public.recrediter_stock_livraison(text, boolean);
--        alter function interne.l041_recrediter_040(text, boolean) rename to recrediter_stock_livraison;
--        alter function interne.recrediter_stock_livraison(text, boolean) set schema public;
--        grant execute on function public.recrediter_stock_livraison(text, boolean) to anon;
--        drop trigger if exists commandes_livre_garde on public.commandes;
--        drop trigger if exists commandes_annulee_pieces on public.commandes;
--   2) drop function if exists public.drop_version(), public.drop_pieces(text), public.drop_declarer(bigint, text, bigint, text),
--        public.drop_enlever_payer(bigint, numeric, text, text, numeric), public.drop_ticket_ajouter(bigint, text),
--        public.drop_livre_sans_confirmation(text, text),
--        public.drop_confirmer_livraison(text, jsonb), public.drop_commande_non_livree(text), public.drop_controler(),
--        public.drop_alerte_vue(bigint), public.drop_bilan_jour(text), public.drop_marge_commande(text),
--        public.drop_reinitialiser_pieces(text), public.drop_tampon_entree(text, bigint, date, text, text, jsonb),
--        public.drop_tampon_etat(), public.drop_tampon_corriger(bigint, text);
--   3) les tables (fournisseurs, fournisseur_prix, drop_produits, commande_pieces, achats_fournisseur, pieces_couts,
--      drop_journal, drop_alertes, stock_tampon_entrees, stock_tampon_lots, tampon_sorties, tampon_retours, drop_derogations,
--      drop_livrees_avant_activation)
--      et les colonnes ajoutées à stock_camion peuvent rester : elles ne sont lues par rien d'autre.
--      Les dépenses « Achat fournisseur » déjà créées restent dans depenses (elles ont été réellement payées).
--   4) revenir à l'application précédente (v7.5.198) : sans la fonction drop_version, l'appli n'affiche plus rien de ce module.
--
-- ORDRE DE MISE EN SERVICE (obligatoire) : 038b (PR 24) → 039 (PR 26) → 040 (PR 29) → CETTE 041 → PUIS l'application.
-- Elle exige la table produits_revient (039) et, de la 040 RÉVISÉE (PR 29, v7.5.198), deduire_stock_livraison, les journaux
-- stock_sorties_livraison / stock_operations et les fonctions interne.l040_* : les contrôles des sections 7 et 9 ANNULENT la
-- migration si elles manquent. AUCUNE écriture de stock hors des fonctions de la base : la 041 ne retire du stock que dans
-- deduire_stock_livraison (même verrou, même marque l040.fonction, mêmes journaux que la 040 ; recrédit de la 040 inchangé).
--
-- DÉCISIONS DE BORHEN (25-26/11/2026) reproduites ici :
--   * Finalité : « à la fin de la journée, on sait ce qu'on a gagné », dropshipping ou autre.
--   * Dropshipping activé par l'ADMINISTRATEUR, référence par référence (table drop_produits), jamais automatiquement.
--     Plusieurs fournisseurs par référence (fournisseur_prix), chacun avec son prix d'achat HT. Tout est compté en HT.
--   * Une commande est découpée en PIÈCES (commande_pieces) : un ensemble = ses composants (produits.composants), une pièce
--     par unité (un ensemble 180×190 = 1 matelas + 2 sommiers 90×190 = 3 pièces).
--   * Trois points de contrôle par pièce, par le livreur :
--     1. CHARGEMENT (drop_declarer) : « Dépôt », « À prendre chez <fournisseur> » (référence activée seulement ; prix prévu HT
--        repris du fournisseur choisi) ou « Déjà dans le camion » (une pièce du stock du camion de CE livreur) ;
--     2. ENLÈVEMENT (drop_enlever_payer) : « Enlevé et payé » — montant payé TTC (v7.5.201 ; coût HT à part), espèces ou CB, chemin de la photo du ticket
--        (stockage privé drop-tickets). Écart payé / prévu → alerte administrateur. Espèces → une dépense « Espèces » de la
--        tournée (déduite de ce qu'il remet à la caisse, PR 24) ; CB → une dépense « CB » à part (non déduite) ;
--     3. LIVRAISON (drop_confirmer_livraison) : pièce par pièce, livrée ou non ; une pièce sans provenance, ou une pièce
--        fournisseur non payée, ne peut pas être confirmée livrée.
--   * Pièce achetée mais NON livrée (client absent, report, pièce refusée) → STOCK DU CAMION (stock_camion, rattachée à son
--     achat) ; le lendemain : « Déjà dans le camion », sans nouvel achat, son coût (l'achat d'origine) est repris dans la marge.
--     Alerte si elle reste dans le camion plus de N jours (réglage drop_camion_alerte_jours, 3 par défaut).
--   * STOCK du dépôt retiré SEULEMENT pour les pièces d'origine « Dépôt » (deduire_stock_livraison, toujours idempotente, une
--     seule fois par commande). Alerte « manque au dépôt » si une pièce que le stock théorique disait disponible est prise
--     chez un fournisseur.
--   * MARGE de chaque commande = prix HT − coût réel de chaque pièce (Dépôt : prix de revient de la 039 ; Fournisseur : prix
--     payé HT ; Camion : coût de l'achat d'origine, ou prix de revient si la pièce venait du dépôt), coût FIGÉ à la livraison
--     (pieces_couts). BILAN DU JOUR (drop_bilan_jour, administrateur seul) : ventes livrées HT, coût des produits, GLS,
--     résultat ; réglage « charges fixes du jour » vide par défaut.
--   * Journal de chaque action (drop_journal : qui, quand, quoi, combien), ajout seul.
--   * STOCK TAMPON DROPSHIPPING (exigence de Borhen du 27/11/2026 ~00h20) : on peut aussi ACHETER À L'AVANCE chez un
--     fournisseur et constituer au dépôt un stock tampon. Entrée (drop_tampon_entree, administrateur) : fournisseur, pièces,
--     quantités, prix d'achat HT réel par pièce, date, mode de paiement, photo du ticket ou de la facture → des LOTS
--     identifiés « tampon » (stock_tampon_lots) avec leur coût propre, séparés du stock BMS (conteneur) et de son prix de
--     revient ; le stock du dépôt augmente PAR LA BASE (mouvement_stock_produit de la 040, idempotent). Au chargement, une
--     pièce peut venir du « Dépôt — stock BMS », du « Dépôt — stock tampon (fournisseur X) », de « chez le
--     fournisseur » ou du camion. À la livraison, deduire_stock_livraison retire la pièce du stock ET de son lot (premier
--     entré, premier sorti, tampon_sorties) ; son coût = le prix d'achat réel du lot (marge, bilan du jour). Écrans : entrée,
--     stock tampon restant par fournisseur et sa valeur (drop_tampon_etat), alerte si un lot dort plus de N jours
--     (réglage drop_tampon_alerte_jours, 30 par défaut).
--
-- DROITS : administrateur = tout (lecture ; écritures des fournisseurs, prix et activations par l'API, journalisées par
-- déclencheur) ; collaboratrice = fournisseurs, activations et pièces EN LECTURE, aucun prix d'achat ; livreur = les pièces,
-- achats et prix de SES commandes (règle ±2 jours de sess_livreur), prix des fournisseurs des seules références activées.
-- Les pièces, achats, coûts, journal et alertes ne s'écrivent QUE par les fonctions SECURITY DEFINER ci-dessous (session
-- vérifiée dans chaque fonction, comme deduire_stock_livraison).
--
-- v7.5.201 (revue Codex sur 53c7b59 ; DÉCISION DE BORHEN CORRIGÉE du 27/11 ~00h55 : « caisse TTC, marge HT ») :
--   * CAISSE TTC, MARGE HT : le fournisseur facture TOUJOURS en TTC, même payé en espèces. Le prix prévu du fournisseur reste
--     saisi en HT par l'administrateur ; le livreur voit le TTC attendu (HT × (1 + TVA), réglage drop_tva_pct, 20 par défaut)
--     et saisit le TTC payé. On enregistre SÉPARÉMENT le montant payé TTC (achats_fournisseur.montant_paye_ttc : la dépense
--     de la tournée = TTC, espèces déduites de ce que le livreur remet, CB à part) et le coût HT (montant_paye_ht = HT de la
--     facture s'il est saisi, sinon TTC ÷ (1 + TVA) : marge, coût des pièces, bilan du jour). L'alerte d'écart compare le TTC
--     payé au TTC attendu. Même logique pour le stock tampon (facture TTC payée, coût HT des lots).
--   * « LIVRÉ » REFUSÉ PAR LA BASE tant qu'une pièce de la commande n'est pas confirmée (déclencheur commandes_livre_garde,
--     sessions de l'application ; une commande sans pièces n'est jamais bloquée) ; exception explicite de l'administrateur :
--     drop_livre_sans_confirmation (motif obligatoire, journalisé). La déduction d'une commande découpée ATTEND la
--     confirmation des pièces (refus « pieces_non_confirmees ») : une pièce dont livraison est NULL n'est jamais tenue pour
--     livrée, sauf dérogation de l'administrateur.
--   * DÉCOUPAGE PÉRIMÉ (lignes changées après une déclaration) : confirmation de livraison refusée (« decoupage_perime ») tant
--     que l'administrateur n'a pas réinitialisé les pièces.
--   * ANNULATION / RELIVRAISON : le recrédit (enveloppe de recrediter_stock_livraison de la 040) remet chaque pièce du stock
--     tampon dans SON lot d'origine (tampon_retours) et ouvre un nouveau CYCLE de livraison des pièces (confirmation, coûts
--     figés et sorties de lots propres à chaque cycle : rien n'est gardé du cycle précédent).
--   * BORNES EXPLICITES (plus de limite silencieuse) : 50 unités au plus par ligne, 20 au plus par composant d'un ensemble,
--     200 pièces au plus par commande ; au-delà, refus « quantite_hors_borne » (découpage) — la commande se traite alors au
--     bureau (dérogation).
--
-- v7.5.205 (lecture de la VRAIE base le 27/11 ; avis chatgpt-review et revue native sur b8b7fe0, 5d095d5 et 3728fb8) :
--   * stock_camion.id est un UUID (défaut gen_random_uuid()) : commande_pieces.stock_camion_id en uuid, lignes du camion
--     créées avec un vrai uuid, une seule par achat (index unique partiel) ; identifiant reçu de l'appli converti sans erreur.
--   * annulation après livraison partielle : la pièce « pas livrée » est remise à zéro (son article acheté reste une ligne
--     du camion disponible) ; une pièce fournisseur dont l'achat est au camion n'est jamais confirmée livrée.
--   * stock du camion réservé et consommé PAR UNITÉ (ligne de plusieurs unités découpée à la déclaration).
--   * COMMANDE CONCERNÉE (interne.l041_concernee) jamais découpée : « livré » et déduction refusés, sauf dérogation.
--   * stock tampon épuisé entre la déclaration et la livraison : confirmation / déduction refusées, correction tracée
--     (drop_tampon_corriger).
--
-- v7.5.206 (avis chatgpt-review sur efe0409 et cfbf0fa, revue native P2 sur cfbf0fa) :
--   * COMMANDE CONCERNÉE : les commandes déjà LIVRÉES à l'activation sont relevées une seule fois (drop_livrees_avant_activation)
--     et sont les seules exemptées ; une commande créée avant l'activation mais pas encore livrée est concernée (découpée au
--     chargement, dérogation de l'administrateur possible). GLS et sans livreur : jamais bloquées.
--   * RECRÉDIT d'une livraison CONFIRMÉE mais jamais DÉDUITE (déduction en attente, puis annulation) : la 040 répond « deja »
--     (rien à rendre au stock) ; les pièces sont tout de même ROUVERTES (nouveau cycle, unité du camion remise « en_camion »,
--     pièces « pas livrées » remises à zéro). Un rejeu (déjà réconcilié) ne refait rien.
--   * COMMANDE ANNULÉE AVANT SA LIVRAISON (déclencheur commandes_annulee_pieces, toutes voies) : pièces déclarées libérées comme
--     pour un report (achat payé → stock du camion).
--
-- LIMITES : un « livré » posé hors session de l'application (serveur, maintenance) n'est pas bloqué par le déclencheur ; la
-- déduction refuse alors (« pieces_non_confirmees ») et une alerte est posée. Le stockage des photos utilise la même session
-- (en-têtes x-app-secret / x-session-token) que l'API REST : à vérifier sur le premier ticket envoyé ; sans photo,
-- l'enlèvement est enregistré avec une alerte « ticket manquant ». Aucune donnée existante n'est modifiée par cette migration.

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 1. Réglages (table parametres existante ; valeurs modifiables par l'administrateur, aucune valeur commerciale ici)
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
insert into public.parametres (cle, valeur) values
  ('drop_camion_alerte_jours', '3'),          -- alerte : pièce achetée restée dans le camion plus de N jours
  ('drop_charges_fixes_jour_ht', ''),         -- charges fixes du jour (HT) : VIDE = non comptées dans le bilan
  ('drop_gls_cout_commande_ht', ''),          -- coût GLS HT par commande livrée par GLS : VIDE = « GLS non renseigné »
  ('drop_tva_pct', '20'),                     -- TVA pour passer le prix de vente TTC d'une commande en HT
  ('drop_tampon_alerte_jours', '30'),         -- alerte : lot du stock tampon dropshipping non écoulé depuis plus de N jours
  -- v7.5.205 (avis chatgpt-review n° 1) : date de l'activation du module = première application de cette migration (gardée aux
  -- rejeux) ; v7.5.206 : renseignement seulement (la règle « concernée » lit drop_livrees_avant_activation)
  ('drop_actif_depuis', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
on conflict (cle) do nothing;

create or replace function interne.l041_reglage(p_cle text) returns numeric
language plpgsql stable security definer set search_path = public, pg_catalog as $$
declare v text;
begin
  select valeur into v from public.parametres where cle = p_cle;
  v := replace(btrim(coalesce(v, '')), ',', '.');
  if v !~ '^-?[0-9]+(\.[0-9]+)?$' then return null; end if;
  return v::numeric;
end $$;
revoke all on function interne.l041_reglage(text) from public, anon, authenticated;

-- v7.5.205 : date d'activation du module (réglage drop_actif_depuis) ; illisible ou absente = « depuis toujours ».
-- v7.5.206 : renseignement seulement — la règle « commande concernée » ne lit plus la date de création (voir plus bas)
create or replace function interne.l041_actif_depuis() returns timestamptz
language plpgsql stable security definer set search_path = public, pg_catalog as $$
declare v text;
begin
  select btrim(coalesce(valeur, '')) into v from public.parametres where cle = 'drop_actif_depuis';
  if coalesce(v, '') = '' then return '-infinity'::timestamptz; end if;
  begin return v::timestamptz; exception when others then return '-infinity'::timestamptz; end;
end $$;
revoke all on function interne.l041_actif_depuis() from public, anon, authenticated;

-- v7.5.206 (avis chatgpt-review sur efe0409, point 1) : COMMANDES DÉJÀ LIVRÉES À L'ACTIVATION, relevées UNE SEULE FOIS, à la
-- première application de cette migration (table créée et remplie dans le même bloc ; un rejeu ne la complète jamais : une
-- commande livrée APRÈS l'activation n'y entre pas). Ce sont les seules commandes de nos livreurs jamais obligées au découpage
-- (relivraison après annulation comprise) ; une commande créée avant l'activation mais PAS ENCORE LIVRÉE à ce moment-là est
-- concernée comme les autres (elle est découpée au chargement). Lue seulement par les fonctions (aucune politique).
do $$
begin
  if to_regclass('public.drop_livrees_avant_activation') is null then
    create table public.drop_livrees_avant_activation (
      cmd_id text primary key,
      statut text,
      releve_at timestamptz not null default now());
    insert into public.drop_livrees_avant_activation (cmd_id, statut)
    select id, statut from public.commandes where coalesce(statut, '') in ('livré', 'livre')
    on conflict (cmd_id) do nothing;
  end if;
end $$;
alter table public.drop_livrees_avant_activation enable row level security;
revoke all on public.drop_livrees_avant_activation from public, anon, authenticated;

-- v7.5.205 (avis chatgpt-review n° 1 sur 76ebd77 et b8b7fe0), révisée en v7.5.206 (avis sur efe0409, point 1) : COMMANDE
-- CONCERNÉE par l'obligation de découpage en pièces et de confirmation avant « livré » (et avant la déduction du stock) =
--   1. livrée par NOS livreurs : transporteur RANOU (vide = RANOU, comme l'appli) — jamais une commande GLS ;
--   2. avec un livreur attribué (une commande sans livreur = retrait ou vente du bureau) ;
--   3. PAS DÉJÀ LIVRÉE au moment de l'activation du module (table drop_livrees_avant_activation). v7.5.206 : la date de
--      création ne compte plus — une commande créée avant l'activation, confiée à un livreur et livrée après, n'échappe plus
--      au contrôle de provenance (découpée au chargement ; dérogation de l'administrateur possible, journalisée).
-- Une commande concernée ne passe « livré » que découpée et confirmée pièce par pièce, ou par DÉROGATION explicite et
-- journalisée de l'administrateur (drop_livre_sans_confirmation). Une commande encore « livrée » n'est jamais bloquée.
drop function if exists interne.l041_concernee(text, text, timestamptz);
create or replace function interne.l041_concernee(p_transporteur text, p_livreur text, p_cmd_id text) returns boolean
language sql stable security definer set search_path = public, interne, pg_catalog as $$
  select upper(coalesce(nullif(btrim(p_transporteur), ''), 'RANOU')) = 'RANOU' and coalesce(btrim(p_livreur), '') <> ''
     and not exists (select 1 from public.drop_livrees_avant_activation a where a.cmd_id = p_cmd_id) $$;
revoke all on function interne.l041_concernee(text, text, text) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 2. Tables
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.fournisseurs (
  id bigint generated always as identity primary key,
  nom text not null check (btrim(nom) <> ''),
  adresse text not null check (btrim(adresse) <> ''),
  telephone text,
  notes text,
  actif boolean not null default true,
  cree_at timestamptz not null default now(),
  maj_at timestamptz not null default now()
);
create unique index if not exists fournisseurs_nom_idx on public.fournisseurs (lower(btrim(nom)));

create table if not exists public.fournisseur_prix (
  id bigint generated always as identity primary key,
  produit_id text not null references public.produits(id) on update cascade on delete cascade,
  fournisseur_id bigint not null references public.fournisseurs(id) on delete cascade,
  prix_achat_ht numeric(12,2) not null check (prix_achat_ht > 0 and prix_achat_ht <= 100000),
  actif boolean not null default true,
  maj_at timestamptz not null default now(),
  unique (produit_id, fournisseur_id)
);

-- activation du dropshipping, RÉFÉRENCE PAR RÉFÉRENCE, par l'administrateur seulement
create table if not exists public.drop_produits (
  produit_id text primary key references public.produits(id) on update cascade on delete cascade,
  actif boolean not null default false,
  motif text,
  maj_at timestamptz not null default now()
);

-- pièces d'une commande (une ligne par unité) et leur provenance
create table if not exists public.commande_pieces (
  id bigint generated always as identity primary key,
  cmd_id text not null,
  ligne_idx integer not null check (ligne_idx >= 0),
  piece_idx integer not null check (piece_idx >= 0),
  produit_id text,                       -- produit de la pièce (composant pour un ensemble) ; NULL = produit introuvable
  libelle text not null,
  composant_de text,                     -- ensemble dont la pièce est un composant
  empreinte text not null,               -- empreinte des lignes de la commande au découpage
  provenance text check (provenance in ('depot', 'tampon', 'fournisseur', 'camion')),   -- depot = « Dépôt — stock BMS » ; tampon = stock tampon du dépôt (fournisseur_id = fournisseur du lot)
  origine text check (origine in ('depot', 'fournisseur')),   -- d'où vient réellement la pièce (camion : selon son achat)
  fournisseur_id bigint references public.fournisseurs(id),
  achat_id bigint,                       -- achat en cours de la pièce (provenance fournisseur)
  stock_camion_id uuid,                  -- pièce du camion utilisée (provenance camion) — v7.5.205 : uuid comme stock_camion.id
  stock_camion_demande uuid,             -- v7.5.205 : ligne du camion choisie par le livreur (une ligne de plusieurs unités est découpée)
  declare_par text, declare_at timestamptz,
  livraison text check (livraison in ('livree', 'non_livree')),
  livraison_par text, livraison_at timestamptz,
  -- v7.5.201 : cycle de livraison (1, puis +1 à chaque recrédit d'une annulation) : confirmation, coût figé et sortie de lot
  -- sont propres au cycle (une relivraison ne garde rien du cycle précédent)
  cycle integer not null default 1 check (cycle >= 1),
  cree_at timestamptz not null default now(),
  unique (cmd_id, ligne_idx, piece_idx)
);
create index if not exists commande_pieces_cmd_idx on public.commande_pieces (cmd_id);

create table if not exists public.achats_fournisseur (
  id bigint generated always as identity primary key,
  piece_id bigint not null references public.commande_pieces(id),
  cmd_id text not null,
  fournisseur_id bigint not null references public.fournisseurs(id),
  livreur text,
  tournee_id text,
  prix_prevu_ht numeric(12,2) not null check (prix_prevu_ht > 0),
  montant_paye_ht numeric(12,2) check (montant_paye_ht > 0),          -- COÛT HT (marge) : HT de la facture, sinon TTC ÷ (1 + TVA)
  montant_paye_ttc numeric(12,2) check (montant_paye_ttc > 0),        -- v7.5.201 : montant RÉELLEMENT payé TTC (caisse du livreur)
  tva_pct numeric(5,2) check (tva_pct is null or (tva_pct >= 0 and tva_pct <= 100)),   -- taux retenu au paiement
  mode text check (mode in ('especes', 'cb')),
  ticket_path text,
  statut text not null default 'prevu' check (statut in ('prevu', 'paye', 'annule')),
  depense_id text,
  paye_par text, paye_at timestamptz,
  cree_at timestamptz not null default now(),
  check (statut <> 'paye' or (montant_paye_ht is not null and montant_paye_ttc is not null and mode is not null and paye_at is not null)),
  check (montant_paye_ht is null or montant_paye_ttc is null or montant_paye_ht <= montant_paye_ttc)
);
create index if not exists achats_fournisseur_piece_idx on public.achats_fournisseur (piece_id);
create index if not exists achats_fournisseur_cmd_idx on public.achats_fournisseur (cmd_id);
-- une pièce n'a jamais deux achats en cours (prévu ou payé) en même temps
create unique index if not exists achats_fournisseur_un_en_cours on public.achats_fournisseur (piece_id) where statut = 'prevu';

-- coût FIGÉ d'une pièce livrée (administrateur seulement)
create table if not exists public.pieces_couts (
  piece_id bigint not null references public.commande_pieces(id),
  cycle integer not null default 1,      -- v7.5.201 : un coût figé par cycle de livraison (relivraison = nouveau coût)
  cmd_id text not null,
  cout_ht numeric(12,4) check (cout_ht is null or cout_ht >= 0),
  source text not null check (source in ('revient', 'achat', 'achat_camion', 'revient_camion', 'tampon', 'inconnu')),
  lot_id bigint,                         -- lot du stock tampon d'où sort la pièce (source tampon)
  achat_id bigint,
  fige_at timestamptz not null default now(),
  primary key (piece_id, cycle)
);
create index if not exists pieces_couts_cmd_idx on public.pieces_couts (cmd_id);

create table if not exists public.drop_journal (
  id bigint generated always as identity primary key,
  action text not null,
  cmd_id text, piece_id bigint, achat_id bigint,
  montant numeric(12,2),
  details jsonb,
  acteur text,
  cree_at timestamptz not null default now()
);
create index if not exists drop_journal_cmd_idx on public.drop_journal (cmd_id);

create table if not exists public.drop_alertes (
  id bigint generated always as identity primary key,
  type text not null check (type in ('ecart_prix', 'ticket_manquant', 'manque_depot', 'camion_ancien', 'livre_sans_confirmation', 'tampon_ancien', 'tampon_epuise')),
  cle text not null,
  cmd_id text, piece_id bigint, achat_id bigint,
  message text not null,
  montant numeric(12,2),
  cree_at timestamptz not null default now(),
  vue_par text, vue_at timestamptz,
  unique (type, cle)
);

-- STOCK TAMPON DROPSHIPPING : entrées (un achat d'avance chez un fournisseur) et lots (une référence × un prix réel HT)
create table if not exists public.stock_tampon_entrees (
  id bigint generated always as identity primary key,
  cle text not null unique,               -- clé d'idempotence choisie par l'appareil (rejeu sans double entrée)
  fournisseur_id bigint not null references public.fournisseurs(id),
  date_achat date not null,
  mode text not null check (mode in ('especes', 'cb', 'virement', 'autre')),
  ticket_path text,                       -- photo du ticket ou de la facture (bucket privé drop-tickets, dossier tampon/)
  total_ht numeric(12,2) not null check (total_ht > 0),          -- coût HT des lots (marge)
  total_ttc numeric(12,2) check (total_ttc is null or total_ttc >= total_ht),   -- v7.5.201 : facture TTC réellement payée
  tva_pct numeric(5,2),
  acteur text,
  cree_at timestamptz not null default now()
);
create table if not exists public.stock_tampon_lots (
  id bigint generated always as identity primary key,
  entree_id bigint not null references public.stock_tampon_entrees(id),
  fournisseur_id bigint not null references public.fournisseurs(id),
  produit_id text not null references public.produits(id) on update cascade,
  date_achat date not null,
  prix_achat_ht numeric(12,2) not null check (prix_achat_ht > 0 and prix_achat_ht <= 100000),
  quantite_initiale integer not null check (quantite_initiale between 1 and 10000),
  quantite_restante integer not null check (quantite_restante >= 0),
  cree_at timestamptz not null default now(),
  check (quantite_restante <= quantite_initiale)
);
create index if not exists stock_tampon_lots_fifo_idx on public.stock_tampon_lots (produit_id, fournisseur_id, date_achat, id) where quantite_restante > 0;
-- sortie d'une pièce de son lot (une seule fois par pièce ; ajout seul)
create table if not exists public.tampon_sorties (
  id bigint generated always as identity primary key,
  lot_id bigint not null references public.stock_tampon_lots(id),
  piece_id bigint not null references public.commande_pieces(id),
  cycle integer not null default 1,       -- v7.5.201 : une sortie par cycle de livraison de la pièce
  cmd_id text not null,
  prix_achat_ht numeric(12,2) not null,
  cree_at timestamptz not null default now(),
  unique (piece_id, cycle)
);
-- v7.5.201 : retour d'une sortie dans SON lot (recrédit d'une annulation ; une seule fois par sortie ; ajout seul)
create table if not exists public.tampon_retours (
  id bigint generated always as identity primary key,
  sortie_id bigint not null unique references public.tampon_sorties(id),
  lot_id bigint not null references public.stock_tampon_lots(id),
  piece_id bigint not null,
  cmd_id text not null,
  operation_id bigint,                    -- opération de recrédit de la 040 (stock_operations)
  cree_at timestamptz not null default now()
);
-- v7.5.201 : « livré » sans confirmation des pièces accordé par l'ADMINISTRATEUR (motif obligatoire ; ajout seul)
create table if not exists public.drop_derogations (
  id bigint generated always as identity primary key,
  cmd_id text not null,
  cycle integer not null,
  motif text not null check (length(btrim(motif)) between 5 and 500),
  acteur text,
  cree_at timestamptz not null default now(),
  unique (cmd_id, cycle)
);

-- stock du camion (table existante, créée hors migrations) : colonnes pour rattacher une pièce à son achat
alter table public.stock_camion add column if not exists produit_id text;
alter table public.stock_camion add column if not exists achat_id bigint;
alter table public.stock_camion add column if not exists piece_id bigint;            -- pièce d'origine (achetée, non livrée)
alter table public.stock_camion add column if not exists utilise_par_piece bigint;   -- pièce qui l'a déclarée « Déjà dans le camion »
-- v7.5.205 (obstacle relevé dans la VRAIE base le 27/11) : stock_camion.id est un uuid (défaut gen_random_uuid()), pas un
-- texte. Les lignes créées par la 041 reçoivent donc un vrai uuid (défaut de la table) ; la rejouabilité est garantie par
-- l'achat : une seule ligne du camion par achat (index unique partiel ci-dessous).
alter table public.stock_camion add column if not exists scinde_de uuid;             -- v7.5.205 : ligne d'origine d'une unité découpée
create unique index if not exists stock_camion_achat_unique on public.stock_camion (achat_id) where achat_id is not null;
-- rejouabilité : une 041 d'avant la v7.5.205 (jamais appliquée en production) aurait créé stock_camion_id en texte
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'commande_pieces'
               and column_name = 'stock_camion_id' and udt_name <> 'uuid') then
    execute $q$alter table public.commande_pieces alter column stock_camion_id type uuid using
      (case when stock_camion_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then stock_camion_id::uuid end)$q$;
  end if;
end $$;
alter table public.commande_pieces add column if not exists stock_camion_demande uuid;
-- identifiant de ligne du camion reçu de l'appli (texte JSON) → uuid, ou NULL s'il n'en a pas la forme (jamais d'erreur de type)
create or replace function interne.l041_uuid(p text) returns uuid
language sql immutable set search_path = pg_catalog as $$
  select case when p ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p::uuid end $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 3. Droits et politiques (sess_admin / sess_collab / sess_livreur, comme la 019)
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['fournisseurs', 'fournisseur_prix', 'drop_produits', 'commande_pieces', 'achats_fournisseur',
                           'pieces_couts', 'drop_journal', 'drop_alertes', 'stock_tampon_entrees', 'stock_tampon_lots', 'tampon_sorties',
                           'tampon_retours', 'drop_derogations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select on table public.%I to anon', t);
    execute format('drop policy if exists sess_admin_lecture on public.%I', t);
    execute format('create policy sess_admin_lecture on public.%I for select to anon using ((select public.session_role()) = ''admin'')', t);
  end loop;
  -- écritures DIRECTES de l'administrateur : fournisseurs, prix, activations (journalisées par déclencheur, section 4)
  foreach t in array array['fournisseurs', 'fournisseur_prix', 'drop_produits'] loop
    execute format('grant insert, update on table public.%I to anon', t);
    execute format('drop policy if exists sess_admin_ecriture on public.%I', t);
    execute format('create policy sess_admin_ecriture on public.%I for insert to anon with check ((select public.session_role()) = ''admin'')', t);
    execute format('drop policy if exists sess_admin_modif on public.%I', t);
    execute format('create policy sess_admin_modif on public.%I for update to anon using ((select public.session_role()) = ''admin'') with check ((select public.session_role()) = ''admin'')', t);
  end loop;
end $$;
revoke all on sequence public.fournisseurs_id_seq, public.fournisseur_prix_id_seq, public.commande_pieces_id_seq,
  public.achats_fournisseur_id_seq, public.drop_journal_id_seq, public.drop_alertes_id_seq, public.stock_tampon_entrees_id_seq,
  public.stock_tampon_lots_id_seq, public.tampon_sorties_id_seq, public.tampon_retours_id_seq, public.drop_derogations_id_seq
  from public, anon, authenticated;
grant usage on sequence public.fournisseurs_id_seq, public.fournisseur_prix_id_seq to anon;   -- insertions de l'administrateur

-- fournisseurs (nom, adresse) : collaboratrice et livreur en lecture (adresse de l'arrêt d'enlèvement)
drop policy if exists sess_lecture on public.fournisseurs;
create policy sess_lecture on public.fournisseurs for select to anon using ((select public.session_role()) in ('collab', 'livreur'));
drop policy if exists sess_lecture on public.drop_produits;
create policy sess_lecture on public.drop_produits for select to anon using ((select public.session_role()) in ('collab', 'livreur'));
-- prix d'achat : livreur seulement pour une référence ACTIVÉE en dropshipping ; collaboratrice : jamais
drop policy if exists sess_livreur_lecture on public.fournisseur_prix;
create policy sess_livreur_lecture on public.fournisseur_prix for select to anon
  using ((select public.session_role()) = 'livreur' and actif
         and exists (select 1 from public.drop_produits d where d.produit_id = fournisseur_prix.produit_id and d.actif));
-- pièces : collaboratrice ; livreur = pièces des commandes qu'il voit (politique sess_livreur de commandes, ±2 jours)
drop policy if exists sess_lecture on public.commande_pieces;
create policy sess_lecture on public.commande_pieces for select to anon
  using ((select public.session_role()) = 'collab'
         or ((select public.session_role()) = 'livreur' and exists (select 1 from public.commandes c where c.id = commande_pieces.cmd_id)));
-- achats : livreur = les siens
drop policy if exists sess_livreur_lecture on public.achats_fournisseur;
create policy sess_livreur_lecture on public.achats_fournisseur for select to anon
  using ((select public.session_role()) = 'livreur' and upper(coalesce(livreur, '')) = (select public.session_livreur()));

-- stockage PRIVÉ des photos de tickets : bucket drop-tickets ; chemin <livreur>/<commande sans #>/<fichier>
-- livreur : écriture dans SON dossier, pour une commande qu'il voit ; administrateur : lecture et écriture ; personne d'autre
do $$
begin
  if to_regclass('storage.buckets') is not null and to_regclass('storage.objects') is not null then
    execute $q$insert into storage.buckets (id, name, public) values ('drop-tickets', 'drop-tickets', false)
                on conflict (id) do update set public = false$q$;
    execute 'drop policy if exists drop_tickets_livreur_ajout on storage.objects';
    execute $q$create policy drop_tickets_livreur_ajout on storage.objects for insert to anon with check (
      bucket_id = 'drop-tickets' and (select public.session_role()) = 'livreur'
      and split_part(name, '/', 1) = lower((select public.session_livreur()))
      and exists (select 1 from public.commandes c where replace(c.id, '#', '') = split_part(name, '/', 2)))$q$;
    execute 'drop policy if exists drop_tickets_admin on storage.objects';
    execute $q$create policy drop_tickets_admin on storage.objects for all to anon
      using (bucket_id = 'drop-tickets' and (select public.session_role()) = 'admin')
      with check (bucket_id = 'drop-tickets' and (select public.session_role()) = 'admin')$q$;
  else
    raise notice '041 : schéma storage absent — bucket drop-tickets non créé (photos des tickets indisponibles)';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 4. Journal (ajout seul) et journalisation des écritures de l'administrateur
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function interne.l041_acteur() returns text
language sql stable security definer set search_path = public, pg_catalog as $$
  select coalesce(public.session_role(), 'serveur') || coalesce(':' || public.session_livreur(), '') $$;
revoke all on function interne.l041_acteur() from public, anon, authenticated;

create or replace function interne.l041_journal_fige() returns trigger
language plpgsql as $$
begin
  raise exception '% : ajout seul (ni modification ni suppression)', tg_table_name;
end $$;
drop trigger if exists drop_journal_fige on public.drop_journal;
create trigger drop_journal_fige before update or delete on public.drop_journal
  for each row execute function interne.l041_journal_fige();
drop trigger if exists tampon_sorties_fige on public.tampon_sorties;
create trigger tampon_sorties_fige before update or delete on public.tampon_sorties
  for each row execute function interne.l041_journal_fige();
drop trigger if exists tampon_retours_fige on public.tampon_retours;
create trigger tampon_retours_fige before update or delete on public.tampon_retours
  for each row execute function interne.l041_journal_fige();
drop trigger if exists drop_derogations_fige on public.drop_derogations;
create trigger drop_derogations_fige before update or delete on public.drop_derogations
  for each row execute function interne.l041_journal_fige();
drop trigger if exists pieces_couts_fige on public.pieces_couts;
create trigger pieces_couts_fige before update or delete on public.pieces_couts
  for each row execute function interne.l041_journal_fige();

create or replace function interne.l041_journaliser_admin() returns trigger
language plpgsql security definer set search_path = public, interne, pg_catalog as $$
begin
  new.maj_at := now();
  insert into public.drop_journal (action, montant, details, acteur)
  values (tg_table_name || '_' || lower(tg_op),
          (to_jsonb(new) ->> 'prix_achat_ht')::numeric,
          jsonb_build_object('nouveau', to_jsonb(new), 'ancien', case when tg_op = 'UPDATE' then to_jsonb(old) end),
          interne.l041_acteur());
  return new;
end $$;
revoke all on function interne.l041_journaliser_admin() from public, anon, authenticated;
do $$
declare t text;
begin
  foreach t in array array['fournisseurs', 'fournisseur_prix', 'drop_produits'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_journal', t);
    execute format('create trigger %I before insert or update on public.%I for each row execute function interne.l041_journaliser_admin()', t || '_journal', t);
  end loop;
end $$;

create or replace function interne.l041_journal(p_action text, p_cmd text, p_piece bigint, p_achat bigint, p_montant numeric, p_details jsonb)
returns void language sql security definer set search_path = public, interne, pg_catalog as $$
  insert into public.drop_journal (action, cmd_id, piece_id, achat_id, montant, details, acteur)
  values (p_action, p_cmd, p_piece, p_achat, p_montant, p_details, interne.l041_acteur()) $$;
revoke all on function interne.l041_journal(text, text, bigint, bigint, numeric, jsonb) from public, anon, authenticated;

create or replace function interne.l041_alerte(p_type text, p_cle text, p_cmd text, p_piece bigint, p_achat bigint, p_message text, p_montant numeric)
returns void language sql security definer set search_path = public, pg_catalog as $$
  insert into public.drop_alertes (type, cle, cmd_id, piece_id, achat_id, message, montant)
  values (p_type, p_cle, p_cmd, p_piece, p_achat, p_message, p_montant)
  on conflict (type, cle) do update set message = excluded.message, montant = excluded.montant, cree_at = now(), vue_par = null, vue_at = null
  where drop_alertes.message is distinct from excluded.message or drop_alertes.montant is distinct from excluded.montant $$;
revoke all on function interne.l041_alerte(text, text, text, bigint, bigint, text, numeric) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 5. Fonctions PURES (auto-contrôle section 10) et aides
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function interne.l041_mode(p text) returns text
language sql immutable set search_path = pg_catalog as $$
  select case lower(btrim(coalesce(p, ''))) when 'especes' then 'especes' when 'espèces' then 'especes'
              when 'cb' then 'cb' when 'carte' then 'cb' else null end $$;
create or replace function interne.l041_ht(p_ttc numeric, p_tva numeric) returns numeric
language sql immutable set search_path = pg_catalog as $$
  select round(coalesce(p_ttc, 0) / (1 + coalesce(p_tva, 20) / 100), 2) $$;
create or replace function interne.l041_ecart(p_prevu numeric, p_paye numeric) returns numeric
language sql immutable set search_path = pg_catalog as $$ select round(coalesce(p_paye, 0) - coalesce(p_prevu, 0), 2) $$;
-- v7.5.201 (caisse TTC, marge HT) : TTC attendu d'un prix HT
create or replace function interne.l041_ttc(p_ht numeric, p_tva numeric) returns numeric
language sql immutable set search_path = pg_catalog as $$
  select round(coalesce(p_ht, 0) * (1 + coalesce(p_tva, 20) / 100), 2) $$;
-- taux de TVA du réglage drop_tva_pct (20 par défaut ; hors 0..100 = 20)
create or replace function interne.l041_tva() returns numeric
language sql stable security definer set search_path = public, interne, pg_catalog as $$
  select case when v is null or v < 0 or v > 100 then 20 else v end from (select interne.l041_reglage('drop_tva_pct') as v) x $$;
revoke all on function interne.l041_tva() from public, anon, authenticated;
-- v7.5.201 : BORNES EXPLICITES du découpage (plus de limite silencieuse) — documentées dans CLAUDE.md
create or replace function interne.l041_qte_ligne_max() returns integer language sql immutable as $$ select 50 $$;
create or replace function interne.l041_qte_composant_max() returns integer language sql immutable as $$ select 20 $$;
create or replace function interne.l041_pieces_max() returns integer language sql immutable as $$ select 200 $$;
-- première ligne hors borne (NULL = tout est dans les bornes) : même lecture des lignes que l041_decomposer
create or replace function interne.l041_hors_borne(p_lignes jsonb, p_produit text, p_qte jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, interne, pg_catalog as $$
declare v_lignes jsonb; l jsonb; v_n integer := -1; v_q integer; v_pid text; pr record; e jsonb; v_k integer; v_total bigint := 0;
begin
  if jsonb_typeof(p_lignes) = 'array' and jsonb_array_length(p_lignes) > 0 then v_lignes := p_lignes;
  else v_lignes := jsonb_build_array(jsonb_build_object('produit', p_produit, 'qte', p_qte)); end if;
  for l in select x.value from jsonb_array_elements(v_lignes) with ordinality as x(value, o) order by x.o loop
    v_n := v_n + 1;
    if jsonb_typeof(l) <> 'object' then continue; end if;
    v_q := interne.l040_qte(l -> 'qte');
    if v_q > interne.l041_qte_ligne_max() then
      return jsonb_build_object('ligne', v_n, 'raison', 'qte_ligne', 'qte', v_q, 'max', interne.l041_qte_ligne_max()); end if;
    v_pid := interne.l040_trouver_produit(l ->> 'produitId', coalesce(nullif(l ->> 'nom', ''), l ->> 'produit'));
    select x.id, x.composants into pr from public.produits x where x.id = v_pid;
    if v_pid is not null and jsonb_typeof(pr.composants) = 'array' and jsonb_array_length(pr.composants) > 0 then
      for e in select x.value from jsonb_array_elements(pr.composants) x loop
        if coalesce(e ->> 'id', '') = '' then continue; end if;
        v_k := interne.l040_qte(e -> 'qte');
        if v_k > interne.l041_qte_composant_max() then
          return jsonb_build_object('ligne', v_n, 'raison', 'qte_composant', 'composant', e ->> 'id', 'qte', v_k, 'max', interne.l041_qte_composant_max()); end if;
        v_total := v_total + v_k::bigint * v_q;
      end loop;
    else
      v_total := v_total + v_q;
    end if;
    if v_total > interne.l041_pieces_max() then
      return jsonb_build_object('ligne', v_n, 'raison', 'pieces', 'qte', v_total, 'max', interne.l041_pieces_max()); end if;
  end loop;
  return null;
end $$;
revoke all on function interne.l041_hors_borne(jsonb, text, jsonb) from public, anon, authenticated;
-- empreinte des lignes d'une commande (découpage à refaire si elles changent avant toute déclaration)
create or replace function interne.l041_empreinte(p_lignes jsonb, p_produit text, p_qte integer) returns text
language sql immutable set search_path = pg_catalog as $$
  select md5(coalesce(p_lignes::text, '') || '|' || coalesce(p_produit, '') || '|' || coalesce(p_qte::text, '')) $$;
-- chemin de ticket accepté : <livreur en minuscules>/<commande sans #>/<fichier>
create or replace function interne.l041_chemin_ticket_ok(p_chemin text, p_livreur text, p_cmd text) returns boolean
language sql immutable set search_path = pg_catalog as $$
  select p_chemin is not null and p_livreur is not null and p_cmd is not null
     and split_part(p_chemin, '/', 1) = lower(p_livreur) and split_part(p_chemin, '/', 2) = replace(p_cmd, '#', '')
     and split_part(p_chemin, '/', 3) ~ '^[A-Za-z0-9._-]{1,120}$' and split_part(p_chemin, '/', 4) = '' $$;

-- commande accessible à la session (même règle que les politiques sess_* de la 019 ; collaboratrice si p_collab)
create or replace function interne.l041_cmd_autorisee(p_cmd text, p_collab boolean) returns boolean
language sql stable security definer set search_path = public, pg_catalog as $$
  select exists (select 1 from public.commandes c where c.id = p_cmd and (
    public.session_role() = 'admin' or (p_collab and public.session_role() = 'collab')
    or (public.session_role() = 'livreur' and public.session_livreur() is not null
        and upper(coalesce(c.livreur, '')) = public.session_livreur()
        and coalesce(c.date_livraison, '') >= to_char(current_date - 2, 'YYYY-MM-DD')
        and coalesce(c.date_livraison, '') <= to_char(current_date + 2, 'YYYY-MM-DD')))) $$;
revoke all on function interne.l041_cmd_autorisee(text, boolean) from public, anon, authenticated;

-- DÉCOUPAGE d'une commande en pièces (une par unité) : mêmes règles que 040 (lignes ou produit + qte, produit retrouvé par
-- identifiant puis par nom, quantité max(1, entier)) ; ENSEMBLE → ses composants (qte du composant × quantité).
-- v7.5.201 : AUCUNE limite silencieuse : les appelants vérifient d'abord interne.l041_hors_borne ; une quantité hors borne
-- arrivée ici fait échouer l'appel (jamais tronquée).
create or replace function interne.l041_decomposer(p_lignes jsonb, p_produit text, p_qte jsonb)
returns table (ligne_idx integer, piece_idx integer, produit_id text, libelle text, composant_de text)
language plpgsql stable security definer set search_path = public, interne, pg_catalog as $$
#variable_conflict use_variable
declare
  v_lignes jsonb; l jsonb; v_n integer := -1; v_nom text; v_q integer; v_pid text; v_k integer; v_i integer; v_p integer;
  pr record; cn record; e jsonb;
begin
  if jsonb_typeof(p_lignes) = 'array' and jsonb_array_length(p_lignes) > 0 then v_lignes := p_lignes;
  else v_lignes := jsonb_build_array(jsonb_build_object('produit', p_produit, 'qte', p_qte)); end if;
  for l in select x.value from jsonb_array_elements(v_lignes) with ordinality as x(value, o) order by x.o loop
    v_n := v_n + 1;                    -- même indice que le tableau des lignes (chargements[cmd][idx] de l'appli)
    if jsonb_typeof(l) <> 'object' then continue; end if;
    v_nom := coalesce(nullif(l ->> 'nom', ''), l ->> 'produit');
    v_q := interne.l040_qte(l -> 'qte');
    if v_q > interne.l041_qte_ligne_max() then raise exception 'quantite_hors_borne : ligne % (% > %)', v_n, v_q, interne.l041_qte_ligne_max(); end if;
    v_pid := interne.l040_trouver_produit(l ->> 'produitId', v_nom);
    v_p := 0;
    select x.id, x.nom, x.composants into pr from public.produits x where x.id = v_pid;
    if v_pid is not null and jsonb_typeof(pr.composants) = 'array' and jsonb_array_length(pr.composants) > 0 then
      for e in select x.value from jsonb_array_elements(pr.composants) with ordinality as x(value, o) order by x.o loop
        if coalesce(e ->> 'id', '') = '' then continue; end if;
        select x.nom into cn from public.produits x where x.id = e ->> 'id';
        v_k := interne.l040_qte(e -> 'qte');
        if v_k > interne.l041_qte_composant_max() then raise exception 'quantite_hors_borne : composant % (% > %)', e ->> 'id', v_k, interne.l041_qte_composant_max(); end if;
        v_k := v_k * v_q;
        for v_i in 1..v_k loop
          ligne_idx := v_n; piece_idx := v_p; produit_id := e ->> 'id';
          libelle := coalesce(cn.nom, e ->> 'nom', e ->> 'id'); composant_de := pr.id;
          v_p := v_p + 1; return next;
        end loop;
      end loop;
    else
      for v_i in 1..v_q loop
        ligne_idx := v_n; piece_idx := v_p; produit_id := v_pid;
        libelle := coalesce(pr.nom, v_nom, 'Produit'); composant_de := null;
        v_p := v_p + 1; return next;
      end loop;
    end if;
  end loop;
end $$;
revoke all on function interne.l041_decomposer(jsonb, text, jsonb) from public, anon, authenticated;

-- coût d'une pièce : Dépôt = prix de revient (039) ; Fournisseur = prix payé HT ; Camion = achat d'origine, sinon revient
create or replace function interne.l041_cout_piece(p_piece bigint, out cout numeric, out source text, out achat bigint)
language plpgsql stable security definer set search_path = public, pg_catalog as $$
declare p record; a record; sc record;
begin
  select * into p from public.commande_pieces where id = p_piece;
  if not found then source := 'inconnu'; return; end if;
  if p.provenance = 'fournisseur' then
    select id, montant_paye_ht, prix_prevu_ht, statut into a from public.achats_fournisseur where id = p.achat_id;
    if found and a.statut = 'paye' then cout := a.montant_paye_ht; source := 'achat'; achat := a.id; return; end if;
    source := 'inconnu'; return;
  end if;
  if p.provenance = 'camion' then
    select achat_id into sc from public.stock_camion where id = p.stock_camion_id;   -- uuid = uuid (v7.5.205)
    if found and sc.achat_id is not null then
      select id, montant_paye_ht into a from public.achats_fournisseur where id = sc.achat_id and statut = 'paye';
      if found then cout := a.montant_paye_ht; source := 'achat_camion'; achat := a.id; return; end if;
      source := 'inconnu'; return;
    end if;
    select prix_revient_ht into cout from public.produits_revient where produit_id = p.produit_id;
    source := case when cout is null then 'inconnu' else 'revient_camion' end; return;
  end if;
  if p.provenance = 'tampon' then
    select ts.prix_achat_ht into cout from public.tampon_sorties ts where ts.piece_id = p.id and ts.cycle = p.cycle;
    if found then source := 'tampon'; return; end if;
    select l.prix_achat_ht into cout from public.stock_tampon_lots l
     where l.produit_id = p.produit_id and l.fournisseur_id = p.fournisseur_id and l.quantite_restante > 0
     order by l.date_achat, l.id limit 1;
    if found then source := 'tampon'; return; end if;
  end if;
  -- dépôt (ou provenance non déclarée : la pièce est supposée venir du dépôt, comme avant ce module)
  select prix_revient_ht into cout from public.produits_revient where produit_id = p.produit_id;
  source := case when cout is null then 'inconnu' else 'revient' end;
end $$;
revoke all on function interne.l041_cout_piece(bigint) from public, anon, authenticated;

-- pièce achetée non livrée → stock du camion (une seule fois par achat)
-- v7.5.205 : stock_camion.id est un uuid (défaut de la table) ; rejouable par l'achat (index unique partiel
-- stock_camion_achat_unique) : un 2e appel pour le même achat ne crée rien et renvoie la ligne existante.
drop function if exists interne.l041_vers_camion(bigint);   -- ancienne version (renvoyait un texte)
create or replace function interne.l041_vers_camion(p_piece bigint) returns uuid
language plpgsql security definer set search_path = public, interne, pg_catalog as $$
declare p record; a record; v_id uuid; v_liv text; v_n integer;
begin
  select * into p from public.commande_pieces where id = p_piece;
  if not found or p.provenance is distinct from 'fournisseur' or p.achat_id is null then return null; end if;
  select * into a from public.achats_fournisseur where id = p.achat_id;
  if not found or a.statut <> 'paye' then return null; end if;
  -- stock_camion.livreur est NOT NULL dans la vraie base : livreur de l'achat, sinon de la commande
  v_liv := coalesce(nullif(btrim(a.livreur), ''), (select nullif(btrim(livreur), '') from public.commandes where id = a.cmd_id), '');
  insert into public.stock_camion (livreur, produit_libelle, quantite, source_cmd_id, source_tournee_id, charge_at, charge_par,
                                   status, produit_id, achat_id, piece_id)
  values (v_liv, p.libelle, 1, a.cmd_id, a.tournee_id, now(), interne.l041_acteur(), 'en_camion', p.produit_id, a.id, p.id)
  on conflict (achat_id) where achat_id is not null do nothing;
  get diagnostics v_n = row_count;
  select id into v_id from public.stock_camion where achat_id = a.id;
  if v_n > 0 then
    perform interne.l041_journal('vers_camion', p.cmd_id, p.id, a.id, a.montant_paye_ht, jsonb_build_object('stock_camion_id', v_id));
  end if;
  return v_id;
end $$;
revoke all on function interne.l041_vers_camion(bigint) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 6. Fonctions du livreur (session vérifiée dans chaque fonction)
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.drop_version() returns text
language sql stable security definer set search_path = public, pg_catalog as $$
  select case when public.session_role() in ('admin', 'collab', 'livreur') then '041' end $$;
revoke all on function public.drop_version() from public, anon, authenticated;
grant execute on function public.drop_version() to anon;

-- pièce présentée à la session (prix et choix seulement pour l'administrateur et le livreur)
create or replace function interne.l041_piece_json(p_piece bigint) returns jsonb
language plpgsql stable security definer set search_path = public, interne, pg_catalog as $$
declare p record; c record; v_prix boolean := public.session_role() in ('admin', 'livreur'); j jsonb; v_tva numeric := interne.l041_tva();
begin
  select * into p from public.commande_pieces where id = p_piece;
  select id, livreur into c from public.commandes where id = p.cmd_id;
  j := jsonb_build_object('id', p.id, 'cmd_id', p.cmd_id, 'ligne_idx', p.ligne_idx, 'piece_idx', p.piece_idx,
    'produit_id', p.produit_id, 'libelle', p.libelle, 'composant_de', p.composant_de, 'provenance', p.provenance,
    'origine', p.origine, 'fournisseur_id', p.fournisseur_id,
    'fournisseur', (select jsonb_build_object('id', f.id, 'nom', f.nom, 'adresse', f.adresse, 'telephone', f.telephone)
                      from public.fournisseurs f where f.id = p.fournisseur_id),
    'stock_camion_id', p.stock_camion_id, 'declare_par', p.declare_par, 'declare_at', p.declare_at,
    'livraison', p.livraison, 'livraison_par', p.livraison_par, 'livraison_at', p.livraison_at, 'cycle', p.cycle,
    'drop_actif', exists (select 1 from public.drop_produits d where d.produit_id = p.produit_id and d.actif),
    'tampon', coalesce((select jsonb_agg(jsonb_build_object('fournisseur_id', t.fournisseur_id, 'nom', t.nom, 'restant', t.restant) order by t.nom)
                from (select l.fournisseur_id, f.nom, sum(l.quantite_restante)::integer as restant from public.stock_tampon_lots l
                        join public.fournisseurs f on f.id = l.fournisseur_id
                       where l.produit_id = p.produit_id and l.quantite_restante > 0 group by l.fournisseur_id, f.nom) t), '[]'::jsonb),
    'stock_bms', greatest(0, coalesce((select stock from public.produits x where x.id = p.produit_id), 0)
                       - coalesce((select sum(quantite_restante) from public.stock_tampon_lots l where l.produit_id = p.produit_id), 0)),
    'stock_depot', (select stock from public.produits x where x.id = p.produit_id));
  if v_prix then
    j := j || jsonb_build_object(
      'tva_pct', v_tva,   -- v7.5.201 : caisse TTC (TTC attendu = HT × (1 + TVA))
      'achat', (select jsonb_build_object('id', a.id, 'statut', a.statut, 'prix_prevu_ht', a.prix_prevu_ht,
                  'prix_prevu_ttc', interne.l041_ttc(a.prix_prevu_ht, v_tva),
                  'montant_paye_ht', a.montant_paye_ht, 'montant_paye_ttc', a.montant_paye_ttc, 'mode', a.mode, 'ticket', a.ticket_path is not null, 'paye_at', a.paye_at)
                  from public.achats_fournisseur a where a.id = p.achat_id),
      'fournisseurs', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'nom', f.nom, 'adresse', f.adresse,
                  'prix_prevu_ht', fp.prix_achat_ht, 'prix_prevu_ttc', interne.l041_ttc(fp.prix_achat_ht, v_tva)) order by fp.prix_achat_ht, f.id)
                  from public.fournisseur_prix fp join public.fournisseurs f on f.id = fp.fournisseur_id
                  where fp.produit_id = p.produit_id and fp.actif and f.actif
                    and exists (select 1 from public.drop_produits d where d.produit_id = p.produit_id and d.actif)), '[]'::jsonb),
      'camion', coalesce((select jsonb_agg(jsonb_build_object('id', sc.id, 'libelle', sc.produit_libelle,
                  'charge_at', sc.charge_at, 'achete', sc.achat_id is not null, 'quantite', coalesce(sc.quantite, 1)) order by sc.charge_at, sc.id)
                  from public.stock_camion sc
                  where sc.status = 'en_camion' and coalesce(sc.quantite, 1) >= 1 and upper(coalesce(sc.livreur, '')) = upper(coalesce(c.livreur, ''))
                    and (sc.produit_id = p.produit_id or (sc.produit_id is null and sc.produit_libelle = p.libelle))
                    and (sc.utilise_par_piece is null or sc.utilise_par_piece = p.id)
                    and (sc.achat_id is not null or sc.charge_at::timestamptz < date_trunc('day', now()))), '[]'::jsonb));
  end if;
  return j;
end $$;
revoke all on function interne.l041_piece_json(bigint) from public, anon, authenticated;

-- pièces d'une commande (découpées à la première demande ; redécoupées si les lignes ont changé et que rien n'est déclaré)
create or replace function public.drop_pieces(p_cmd_id text) returns json
language plpgsql volatile security definer set search_path = public, interne, pg_catalog as $$
declare c record; v_emp text; v_n integer; v_decl integer; v_perime boolean := false; v_hb jsonb;
begin
  if public.session_role() is null or public.session_role() not in ('admin', 'collab', 'livreur') then
    return json_build_object('ok', false, 'erreur', 'session_requise'); end if;
  if not interne.l041_cmd_autorisee(p_cmd_id, true) then return json_build_object('ok', false, 'erreur', 'commande_introuvable'); end if;
  select id, lignes, produit, qte into c from public.commandes where id = p_cmd_id for update;   -- un seul découpage à la fois
  v_emp := interne.l041_empreinte(c.lignes, c.produit, c.qte);
  select count(*), count(*) filter (where provenance is not null or livraison is not null or achat_id is not null
                                    or exists (select 1 from public.achats_fournisseur a where a.piece_id = commande_pieces.id))
    into v_n, v_decl from public.commande_pieces where cmd_id = c.id;
  if v_n > 0 and exists (select 1 from public.commande_pieces where cmd_id = c.id and empreinte <> v_emp) then
    if v_decl = 0 and public.session_role() <> 'collab' then
      delete from public.commande_pieces where cmd_id = c.id;  -- rien de déclaré : découpage refait d'après les lignes actuelles
      v_n := 0;
      perform interne.l041_journal('redecoupage', c.id, null, null, null, null);
    else
      v_perime := true;                                        -- l'administrateur décide (drop_reinitialiser_pieces)
    end if;
  end if;
  if v_n = 0 and public.session_role() <> 'collab' then
    -- v7.5.201 : bornes EXPLICITES (50 par ligne, 20 par composant, 200 pièces) : refus clair, jamais de troncature
    v_hb := interne.l041_hors_borne(c.lignes, c.produit, to_jsonb(c.qte));
    if v_hb is not null then
      return json_build_object('ok', false, 'erreur', 'quantite_hors_borne', 'detail', v_hb);
    end if;
    insert into public.commande_pieces (cmd_id, ligne_idx, piece_idx, produit_id, libelle, composant_de, empreinte)
    select c.id, d.ligne_idx, d.piece_idx, d.produit_id, d.libelle, d.composant_de, v_emp
      from interne.l041_decomposer(c.lignes, c.produit, to_jsonb(c.qte)) d;
  end if;
  return json_build_object('ok', true, 'cmd_id', c.id, 'perime', v_perime, 'tva_pct', interne.l041_tva(),
    'derogation', exists (select 1 from public.drop_derogations d where d.cmd_id = c.id
                            and d.cycle = (select max(q.cycle) from public.commande_pieces q where q.cmd_id = c.id)),
    'pieces', coalesce((select json_agg(interne.l041_piece_json(p.id) order by p.ligne_idx, p.piece_idx)
                          from public.commande_pieces p where p.cmd_id = c.id), '[]'::json));
end $$;

-- administrateur : refaire le découpage d'une commande dont les lignes ont changé (achats en cours annulés, pièces du camion
-- libérées ; un achat PAYÉ non livré part dans le stock du camion — rien n'est perdu)
create or replace function public.drop_reinitialiser_pieces(p_cmd_id text) returns json
language plpgsql volatile security definer set search_path = public, interne, pg_catalog as $$
declare p record;
begin
  if public.session_role() is distinct from 'admin' then return json_build_object('ok', false, 'erreur', 'admin_requis'); end if;
  perform 1 from public.commandes where id = p_cmd_id for update;
  if not found then return json_build_object('ok', false, 'erreur', 'commande_introuvable'); end if;
  if exists (select 1 from public.commande_pieces where cmd_id = p_cmd_id and livraison = 'livree') then
    return json_build_object('ok', false, 'erreur', 'pieces_deja_livrees'); end if;
  for p in select * from public.commande_pieces where cmd_id = p_cmd_id order by id for update loop
    perform interne.l041_vers_camion(p.id);
    update public.achats_fournisseur set statut = 'annule' where id = p.achat_id and statut = 'prevu';
    update public.stock_camion set utilise_par_piece = null where utilise_par_piece = p.id;
  end loop;
  -- les pièces gardent leurs achats et coûts éventuels : elles sont détachées (cmd_id préfixé), jamais supprimées
  update public.commande_pieces set cmd_id = '~' || cmd_id || '~' || id where cmd_id = p_cmd_id;
  perform interne.l041_journal('reinitialisation', p_cmd_id, null, null, null, null);
  return json_build_object('ok', true);
end $$;

-- 1er pare-feu : provenance d'une pièce au CHARGEMENT
create or replace function public.drop_declarer(p_piece_id bigint, p_provenance text, p_fournisseur_id bigint, p_stock_camion_id text)
returns json language plpgsql volatile security definer set search_path = public, interne, pg_catalog as $$
declare p record; c record; a record; v_fp record; sc record; v_prix_prevu numeric; v_tournee text; v_achat bigint; v_origine text;
  v_sc uuid := interne.l041_uuid(p_stock_camion_id); v_unite uuid;   -- v7.5.205 : identifiant de ligne du camion = uuid
begin
  if public.session_role() is null or public.session_role() not in ('admin', 'livreur') then
    return json_build_object('ok', false, 'erreur', 'session_requise'); end if;
  if p_provenance is null or p_provenance not in ('depot', 'tampon', 'fournisseur', 'camion') then
    return json_build_object('ok', false, 'erreur', 'provenance_invalide'); end if;
  select cmd_id into p from public.commande_pieces where id = p_piece_id;
  if not found or not interne.l041_cmd_autorisee(p.cmd_id, false) then return json_build_object('ok', false, 'erreur', 'piece_introuvable'); end if;
  select id, livreur into c from public.commandes where id = p.cmd_id for update;
  select * into p from public.commande_pieces where id = p_piece_id for update;
  if p.livraison is not null then return json_build_object('ok', false, 'erreur', 'piece_deja_confirmee'); end if;
  -- même déclaration : rien à faire (rejeu d'une demande dont la réponse a été perdue)
  -- v7.5.201 (revue Codex P2) : le fournisseur compte aussi pour le stock TAMPON (tampon F1 → tampon F2 n'est pas « deja »)
  if p.provenance = p_provenance and (p_provenance not in ('fournisseur', 'tampon') or p.fournisseur_id is not distinct from p_fournisseur_id)
     and (p_provenance <> 'camion' or p.stock_camion_id = v_sc or p.stock_camion_demande = v_sc) then
    return json_build_object('ok', true, 'deja', true, 'piece', interne.l041_piece_json(p.id)); end if;
  if p.achat_id is not null and exists (select 1 from public.achats_fournisseur where id = p.achat_id and statut = 'paye') then
    return json_build_object('ok', false, 'erreur', 'achat_deja_paye'); end if;
  if p_provenance = 'fournisseur' then
    if p.produit_id is null or not exists (select 1 from public.drop_produits d where d.produit_id = p.produit_id and d.actif) then
      return json_build_object('ok', false, 'erreur', 'dropshipping_inactif'); end if;
    select fp.prix_achat_ht, f.nom into v_fp from public.fournisseur_prix fp join public.fournisseurs f on f.id = fp.fournisseur_id
     where fp.produit_id = p.produit_id and fp.fournisseur_id = p_fournisseur_id and fp.actif and f.actif;
    if not found then return json_build_object('ok', false, 'erreur', 'prix_fournisseur_absent'); end if;
    v_prix_prevu := v_fp.prix_achat_ht;
  elsif p_provenance = 'tampon' then
    if p.produit_id is null or not exists (select 1 from public.stock_tampon_lots l where l.produit_id = p.produit_id
                                             and l.fournisseur_id = p_fournisseur_id and l.quantite_restante > 0) then
      return json_build_object('ok', false, 'erreur', 'stock_tampon_vide'); end if;
  elsif p_provenance = 'camion' then
    if v_sc is null then return json_build_object('ok', false, 'erreur', 'piece_camion_indisponible'); end if;
    select * into sc from public.stock_camion where id = v_sc for update;
    if not found or sc.status <> 'en_camion' or coalesce(sc.quantite, 1) < 1 or upper(coalesce(sc.livreur, '')) <> upper(coalesce(c.livreur, ''))
       or not (sc.produit_id = p.produit_id or (sc.produit_id is null and sc.produit_libelle = p.libelle))
       or (sc.utilise_par_piece is not null and sc.utilise_par_piece <> p.id) then
      return json_build_object('ok', false, 'erreur', 'piece_camion_indisponible'); end if;
  end if;
  -- l'ancienne déclaration est défaite : achat prévu annulé, pièce du camion libérée
  update public.achats_fournisseur set statut = 'annule' where id = p.achat_id and statut = 'prevu';
  update public.stock_camion set utilise_par_piece = null where utilise_par_piece = p.id;
  v_achat := null; v_origine := 'depot';
  if p_provenance = 'fournisseur' then
    select t.id into v_tournee from public.tournees t
     where t.stops::jsonb @> jsonb_build_array(jsonb_build_object('cmdId', c.id)) order by t.date_tournee desc, t.id limit 1;
    insert into public.achats_fournisseur (piece_id, cmd_id, fournisseur_id, livreur, tournee_id, prix_prevu_ht)
    values (p.id, c.id, p_fournisseur_id, c.livreur, v_tournee, v_fp.prix_achat_ht) returning id into v_achat;
    v_origine := 'fournisseur';
    -- « manque au dépôt » : le stock théorique disait la pièce disponible
    if coalesce((select stock from public.produits where id = p.produit_id), 0) > 0 then
      perform interne.l041_alerte('manque_depot', 'piece:' || p.id, c.id, p.id, v_achat,
        'Manque au dépôt ? ' || p.libelle || ' prise chez ' || v_fp.nom || ' alors que le stock théorique en indiquait '
        || (select stock from public.produits where id = p.produit_id) || ' (' || c.id || ')', null);
    end if;
  elsif p_provenance = 'camion' then
    -- v7.5.205 (revue native P2) : réservation PAR UNITÉ. Une ligne du camion de plusieurs unités (chargement de l'appli,
    -- quantite > 1) est DÉCOUPÉE : une unité part sur une nouvelle ligne (quantite 1, scinde_de = ligne d'origine) réservée à
    -- cette pièce ; la ligne d'origine garde les autres unités, disponibles pour d'autres pièces. Une ligne d'achat (041)
    -- vaut toujours une unité.
    if sc.achat_id is null and coalesce(sc.quantite, 1) > 1 then
      update public.stock_camion set quantite = quantite - 1 where id = sc.id;
      insert into public.stock_camion (livreur, produit_libelle, quantite, source_cmd_id, source_tournee_id, charge_at, charge_par,
                                       status, produit_id, piece_id, utilise_par_piece, scinde_de)
      values (sc.livreur, sc.produit_libelle, 1, sc.source_cmd_id, sc.source_tournee_id, sc.charge_at, sc.charge_par,
              'en_camion', sc.produit_id, sc.piece_id, p.id, sc.id)
      returning id into v_unite;
    else
      update public.stock_camion set utilise_par_piece = p.id where id = sc.id;
      v_unite := sc.id;
    end if;
    v_origine := case when sc.achat_id is not null then 'fournisseur' else 'depot' end;
  end if;
  update public.commande_pieces set provenance = p_provenance, origine = v_origine,
         fournisseur_id = case when p_provenance in ('fournisseur', 'tampon') then p_fournisseur_id end, achat_id = v_achat,
         stock_camion_id = case when p_provenance = 'camion' then v_unite end,
         stock_camion_demande = case when p_provenance = 'camion' then v_sc end,
         declare_par = interne.l041_acteur(), declare_at = now()
   where id = p.id;
  perform interne.l041_journal('provenance', c.id, p.id, v_achat, v_prix_prevu,
    jsonb_build_object('provenance', p_provenance, 'fournisseur_id', p_fournisseur_id, 'stock_camion_id', v_unite, 'ligne_camion_choisie', v_sc));
  return json_build_object('ok', true, 'deja', false, 'piece', interne.l041_piece_json(p.id));
end $$;

-- 2e pare-feu : « Enlevé et payé » chez le fournisseur (tout ou rien : achat payé + dépense de la tournée + journal + alertes)
-- v7.5.201 (DÉCISION DE BORHEN CORRIGÉE du 27/11 ~00h55 : « caisse TTC, marge HT ») : le livreur saisit le montant TTC
-- RÉELLEMENT payé (p_montant_ttc) ; le HT de la facture (p_montant_ht) est facultatif. Coût HT retenu = HT saisi, sinon
-- TTC ÷ (1 + TVA). La dépense de la tournée est le TTC payé (espèces déduites de la remise du livreur ; CB à part). L'écart
-- compare le TTC payé au TTC attendu (prix prévu HT × (1 + TVA)).
drop function if exists public.drop_enlever_payer(bigint, numeric, text, text);   -- ancienne signature (HT seul)
create or replace function public.drop_enlever_payer(p_piece_id bigint, p_montant_ttc numeric, p_mode text, p_ticket_path text,
  p_montant_ht numeric default null)
returns json language plpgsql volatile security definer set search_path = public, interne, pg_catalog as $$
declare p record; c record; a record; f record; v_mode text := interne.l041_mode(p_mode); v_dep text; v_ecart numeric;
  v_tva numeric := interne.l041_tva(); v_ttc numeric; v_ht numeric; v_attendu numeric; v_lib text;
begin
  if public.session_role() is null or public.session_role() not in ('admin', 'livreur') then
    return json_build_object('ok', false, 'erreur', 'session_requise'); end if;
  select cmd_id into p from public.commande_pieces where id = p_piece_id;
  if not found or not interne.l041_cmd_autorisee(p.cmd_id, false) then return json_build_object('ok', false, 'erreur', 'piece_introuvable'); end if;
  select id, livreur into c from public.commandes where id = p.cmd_id for update;
  select * into p from public.commande_pieces where id = p_piece_id for update;
  if p.provenance is distinct from 'fournisseur' or p.achat_id is null then return json_build_object('ok', false, 'erreur', 'pas_un_enlevement'); end if;
  select * into a from public.achats_fournisseur where id = p.achat_id for update;
  if a.statut = 'paye' then return json_build_object('ok', true, 'deja', true, 'piece', interne.l041_piece_json(p.id)); end if;
  if a.statut <> 'prevu' then return json_build_object('ok', false, 'erreur', 'achat_annule'); end if;
  if p_montant_ttc is null or p_montant_ttc <= 0 or p_montant_ttc > 5000 then return json_build_object('ok', false, 'erreur', 'montant_invalide'); end if;
  v_ttc := round(p_montant_ttc, 2);
  if p_montant_ht is not null and (p_montant_ht <= 0 or round(p_montant_ht, 2) > v_ttc) then
    return json_build_object('ok', false, 'erreur', 'montant_ht_invalide'); end if;
  v_ht := coalesce(round(p_montant_ht, 2), interne.l041_ht(v_ttc, v_tva));
  if v_mode is null then return json_build_object('ok', false, 'erreur', 'mode_invalide'); end if;
  if p_ticket_path is not null and not interne.l041_chemin_ticket_ok(p_ticket_path, c.livreur, c.id) then
    return json_build_object('ok', false, 'erreur', 'chemin_ticket_invalide'); end if;
  select nom into f from public.fournisseurs where id = a.fournisseur_id;
  v_dep := 'drop-' || a.id;
  v_lib := 'Dropshipping ' || c.id || ' — ' || coalesce(f.nom, '?') || ' — ' || p.libelle || ' (TTC payé ; ' || v_ht || ' € HT)';
  begin
    -- la dépense de la tournée = TTC PAYÉ : Espèces = déduite de ce que le livreur remet à la caisse (PR 24) ; CB = à part
    insert into public.depenses (id, date_depense, cat, montant, livreur, comment, mode_paie, tournee_id)
    values (v_dep, current_date, 'Achat fournisseur', v_ttc, coalesce(c.livreur, ''), v_lib,
            case when v_mode = 'especes' then 'Espèces' else 'CB' end, a.tournee_id);
    update public.achats_fournisseur set statut = 'paye', montant_paye_ht = v_ht, montant_paye_ttc = v_ttc, tva_pct = v_tva, mode = v_mode,
           ticket_path = p_ticket_path, depense_id = v_dep, paye_par = interne.l041_acteur(), paye_at = now()
     where id = a.id;
  exception when others then
    -- point de caisse déjà validé (038b) ou autre refus : RIEN n'est enregistré (ni achat payé, ni dépense)
    return json_build_object('ok', false, 'erreur', case when sqlerrm like '%POINT_CAISSE_VALIDE%' then 'point_caisse_valide' else 'refus_base' end,
                             'detail', left(sqlerrm, 200));
  end;
  v_attendu := interne.l041_ttc(a.prix_prevu_ht, v_tva);
  v_ecart := interne.l041_ecart(v_attendu, v_ttc);          -- TTC payé − TTC attendu
  if v_ecart <> 0 then
    perform interne.l041_alerte('ecart_prix', 'achat:' || a.id, c.id, p.id, a.id,
      'Écart de prix : ' || p.libelle || ' chez ' || coalesce(f.nom, '?') || ' payé ' || v_ttc || ' € TTC au lieu de '
      || v_attendu || ' € TTC attendus (' || a.prix_prevu_ht || ' € HT prévus) (' || c.id || ')', v_ecart);
  end if;
  if p_ticket_path is null then
    perform interne.l041_alerte('ticket_manquant', 'achat:' || a.id, c.id, p.id, a.id,
      'Photo du ticket manquante : ' || p.libelle || ' chez ' || coalesce(f.nom, '?') || ' (' || c.id || ')', v_ttc);
  end if;
  perform interne.l041_journal('enlevement_paye', c.id, p.id, a.id, v_ht,
    jsonb_build_object('mode', v_mode, 'prix_prevu_ht', a.prix_prevu_ht, 'ttc_attendu', v_attendu, 'montant_paye_ttc', v_ttc,
                       'montant_paye_ht', v_ht, 'ht_saisi', p_montant_ht is not null, 'tva_pct', v_tva, 'ecart_ttc', v_ecart,
                       'ticket', p_ticket_path is not null, 'depense_id', v_dep));
  return json_build_object('ok', true, 'deja', false, 'ecart', v_ecart, 'ttc_attendu', v_attendu,
    'montant_paye_ttc', v_ttc, 'montant_paye_ht', v_ht, 'tva_pct', v_tva,
    'depense', json_build_object('id', v_dep, 'date', to_char(current_date, 'YYYY-MM-DD'), 'cat', 'Achat fournisseur', 'montant', v_ttc,
      'livreur', c.livreur, 'modePaie', case when v_mode = 'especes' then 'Espèces' else 'CB' end, 'tourneeId', a.tournee_id, 'comment', v_lib),
    'piece', interne.l041_piece_json(p.id));
end $$;

-- photo du ticket envoyée après coup (l'alerte « ticket manquant » est marquée vue)
create or replace function public.drop_ticket_ajouter(p_piece_id bigint, p_ticket_path text) returns json
language plpgsql volatile security definer set search_path = public, interne, pg_catalog as $$
declare p record; c record; a record;
begin
  if public.session_role() is null or public.session_role() not in ('admin', 'livreur') then
    return json_build_object('ok', false, 'erreur', 'session_requise'); end if;
  select * into p from public.commande_pieces where id = p_piece_id;
  if not found or not interne.l041_cmd_autorisee(p.cmd_id, false) then return json_build_object('ok', false, 'erreur', 'piece_introuvable'); end if;
  select id, livreur into c from public.commandes where id = p.cmd_id;
  select * into a from public.achats_fournisseur where id = p.achat_id and statut = 'paye' for update;
  if not found then return json_build_object('ok', false, 'erreur', 'achat_non_paye'); end if;
  if not interne.l041_chemin_ticket_ok(p_ticket_path, c.livreur, c.id) then return json_build_object('ok', false, 'erreur', 'chemin_ticket_invalide'); end if;
  update public.achats_fournisseur set ticket_path = p_ticket_path where id = a.id;
  update public.drop_alertes set vue_par = interne.l041_acteur(), vue_at = now() where type = 'ticket_manquant' and cle = 'achat:' || a.id;
  perform interne.l041_journal('ticket_ajoute', c.id, p.id, a.id, null, null);
  return json_build_object('ok', true);
end $$;

-- 3e pare-feu : LIVRAISON, pièce par pièce. p_pieces = [{ "id": <pièce>, "livree": true|false }, …] : TOUTES les pièces
create or replace function public.drop_confirmer_livraison(p_cmd_id text, p_pieces jsonb) returns json
language plpgsql volatile security definer set search_path = public, interne, pg_catalog as $$
declare c record; p record; e jsonb; v_liv boolean; v_n integer; v_cout record; v_camion uuid; v_res jsonb := '[]'::jsonb; g record;
begin
  if public.session_role() is null or public.session_role() not in ('admin', 'livreur') then
    return json_build_object('ok', false, 'erreur', 'session_requise'); end if;
  if not interne.l041_cmd_autorisee(p_cmd_id, false) then return json_build_object('ok', false, 'erreur', 'commande_introuvable'); end if;
  if jsonb_typeof(p_pieces) <> 'array' then return json_build_object('ok', false, 'erreur', 'pieces_requises'); end if;
  select id, livreur, lignes, produit, qte into c from public.commandes where id = p_cmd_id for update;
  select count(*) into v_n from public.commande_pieces where cmd_id = c.id;
  if v_n = 0 then return json_build_object('ok', false, 'erreur', 'aucune_piece'); end if;
  -- v7.5.201 (revue Codex P1) : découpage PÉRIMÉ (lignes changées après une déclaration) : rien n'est confirmé tant que
  -- l'administrateur n'a pas réinitialisé les pièces (drop_reinitialiser_pieces) — vaut aussi pour un appareil au cache ancien
  if exists (select 1 from public.commande_pieces where cmd_id = c.id and livraison is null
               and empreinte <> interne.l041_empreinte(c.lignes, c.produit, c.qte)) then
    return json_build_object('ok', false, 'erreur', 'decoupage_perime'); end if;
  -- déjà confirmée (rejeu) : rien n'est refait
  if not exists (select 1 from public.commande_pieces where cmd_id = c.id and livraison is null) then
    return json_build_object('ok', true, 'deja', true); end if;
  -- contrôles AVANT toute écriture : chaque pièce une fois, provenance déclarée, pièce fournisseur payée
  if (select count(distinct (x ->> 'id')) from jsonb_array_elements(p_pieces) x) <> v_n
     or exists (select 1 from jsonb_array_elements(p_pieces) x
                 where not exists (select 1 from public.commande_pieces q where q.cmd_id = c.id and q.id::text = x ->> 'id')
                    or jsonb_typeof(x -> 'livree') <> 'boolean') then
    return json_build_object('ok', false, 'erreur', 'pieces_incompletes'); end if;
  for p in select q.* from public.commande_pieces q where q.cmd_id = c.id order by q.id for update loop
    select x into e from jsonb_array_elements(p_pieces) x where x ->> 'id' = p.id::text limit 1;
    v_liv := (e ->> 'livree')::boolean;
    if v_liv and p.provenance is null then
      return json_build_object('ok', false, 'erreur', 'provenance_manquante', 'piece', p.id, 'libelle', p.libelle); end if;
    if v_liv and p.provenance = 'fournisseur'
       and not exists (select 1 from public.achats_fournisseur a where a.id = p.achat_id and a.statut = 'paye') then
      return json_build_object('ok', false, 'erreur', 'enlevement_non_paye', 'piece', p.id, 'libelle', p.libelle); end if;
    -- v7.5.205 (revue native P1) : une pièce achetée dont l'article est passé dans le STOCK DU CAMION ne se livre plus sous son
    -- achat (l'article serait livré tout en restant proposé à une autre commande) : elle se redéclare « Déjà dans le camion »
    if v_liv and p.provenance = 'fournisseur' and p.achat_id is not null
       and exists (select 1 from public.stock_camion sc where sc.achat_id = p.achat_id) then
      return json_build_object('ok', false, 'erreur', 'achat_au_camion', 'piece', p.id, 'libelle', p.libelle); end if;
    -- v7.5.205 : une pièce « Déjà dans le camion » n'est livrée que si son unité est toujours dans le camion et réservée à elle
    if v_liv and p.provenance = 'camion'
       and not exists (select 1 from public.stock_camion sc where sc.id = p.stock_camion_id and sc.status = 'en_camion'
                         and sc.utilise_par_piece = p.id) then
      return json_build_object('ok', false, 'erreur', 'piece_camion_indisponible', 'piece', p.id, 'libelle', p.libelle); end if;
  end loop;
  -- v7.5.205 (avis chatgpt-review sur 3728fb8, point 3) : STOCK TAMPON ÉPUISÉ entre la déclaration et la livraison. Une pièce
  -- « stock tampon » ne se confirme livrée que si son fournisseur a encore, dans ses lots, une unité qui ne soit pas déjà
  -- promise à une autre pièce livrée en attente de sortie (lots verrouillés dans l'ordre) ; sinon refus : le livreur
  -- redéclare la provenance (Dépôt — stock BMS, fournisseur…) — jamais une pièce du dépôt retirée en silence au revient BMS.
  for g in select q.produit_id, q.fournisseur_id, min(q.libelle) as libelle, count(*)::integer as n
             from public.commande_pieces q join jsonb_array_elements(p_pieces) x on x ->> 'id' = q.id::text
            where q.cmd_id = c.id and q.provenance = 'tampon' and q.livraison is null and (x ->> 'livree')::boolean
            group by q.produit_id, q.fournisseur_id order by q.produit_id, q.fournisseur_id loop
    perform 1 from public.stock_tampon_lots l where l.produit_id = g.produit_id and l.fournisseur_id = g.fournisseur_id order by l.id for update;
    if coalesce((select sum(l.quantite_restante) from public.stock_tampon_lots l where l.produit_id = g.produit_id and l.fournisseur_id = g.fournisseur_id), 0)
       - (select count(*) from public.commande_pieces q2 where q2.cmd_id <> c.id and q2.provenance = 'tampon' and q2.produit_id = g.produit_id
            and q2.fournisseur_id = g.fournisseur_id and q2.livraison = 'livree'
            and not exists (select 1 from public.tampon_sorties ts where ts.piece_id = q2.id and ts.cycle = q2.cycle)) < g.n then
      return json_build_object('ok', false, 'erreur', 'stock_tampon_epuise', 'produit_id', g.produit_id, 'libelle', g.libelle);
    end if;
  end loop;
  for p in select q.* from public.commande_pieces q where q.cmd_id = c.id and q.livraison is null order by q.id loop
    select x into e from jsonb_array_elements(p_pieces) x where x ->> 'id' = p.id::text limit 1;
    v_liv := (e ->> 'livree')::boolean;
    if v_liv then
      if p.provenance is distinct from 'tampon' then   -- tampon : coût figé à la sortie de son lot (deduire_stock_livraison)
        select * into v_cout from interne.l041_cout_piece(p.id);
        insert into public.pieces_couts (piece_id, cycle, cmd_id, cout_ht, source, achat_id)
        values (p.id, p.cycle, c.id, v_cout.cout, v_cout.source, v_cout.achat) on conflict (piece_id, cycle) do nothing;
      end if;
      if p.provenance = 'camion' then
        update public.stock_camion set status = 'livre', retour_at = now(), retour_par = interne.l041_acteur() where id = p.stock_camion_id;
      end if;
      update public.commande_pieces set livraison = 'livree', livraison_par = interne.l041_acteur(), livraison_at = now() where id = p.id;
    else
      -- non livrée : pièce achetée → stock du camion ; pièce du camion → libérée ; achat prévu → annulé
      v_camion := interne.l041_vers_camion(p.id);
      update public.achats_fournisseur set statut = 'annule' where id = p.achat_id and statut = 'prevu';
      update public.stock_camion set utilise_par_piece = null where utilise_par_piece = p.id;
      update public.commande_pieces set livraison = 'non_livree', livraison_par = interne.l041_acteur(), livraison_at = now() where id = p.id;
    end if;
    v_res := v_res || jsonb_build_array(jsonb_build_object('id', p.id, 'livree', v_liv, 'vers_camion', v_camion));
    v_camion := null;
  end loop;
  perform interne.l041_journal('livraison_confirmee', c.id, null, null, null, jsonb_build_object('pieces', v_res));
  return json_build_object('ok', true, 'deja', false, 'pieces', v_res);
end $$;

-- commande NON livrée (reportée, client absent) : achats payés → stock du camion, déclarations remises à zéro (le jour de la
-- nouvelle livraison, le livreur redéclare : « Déjà dans le camion », sans nouvel achat). Rejouable sans effet.
-- v7.5.206 (revue native P2 sur cfbf0fa) : le traitement est commun à drop_commande_non_livree (appli : reporté, absent,
-- annulé) et au déclencheur commandes_annulee_pieces (commande ANNULÉE avant sa livraison, quelle que soit la voie : fiche
-- commande, collaboratrice, ancienne version de l'appli, JARVIS) — un achat payé ne reste jamais attaché à une commande annulée.
create or replace function interne.l041_liberer_non_livrees(p_cmd_id text, p_action text) returns integer
language plpgsql volatile security definer set search_path = public, interne, pg_catalog as $$
declare p record; v_n integer := 0; v_camion uuid;
begin
  for p in select q.* from public.commande_pieces q where q.cmd_id = p_cmd_id and q.livraison is null and q.provenance is not null order by q.id for update loop
    v_camion := interne.l041_vers_camion(p.id);
    update public.achats_fournisseur set statut = 'annule' where id = p.achat_id and statut = 'prevu';
    update public.stock_camion set utilise_par_piece = null where utilise_par_piece = p.id;
    update public.commande_pieces set provenance = null, origine = null, fournisseur_id = null, achat_id = null, stock_camion_id = null,
           stock_camion_demande = null, declare_par = null, declare_at = null where id = p.id;
    v_n := v_n + 1;
  end loop;
  if v_n > 0 then perform interne.l041_journal(p_action, p_cmd_id, null, null, null, jsonb_build_object('pieces', v_n)); end if;
  return v_n;
end $$;
revoke all on function interne.l041_liberer_non_livrees(text, text) from public, anon, authenticated;

create or replace function public.drop_commande_non_livree(p_cmd_id text) returns json
language plpgsql volatile security definer set search_path = public, interne, pg_catalog as $$
declare c record; v_n integer;
begin
  if public.session_role() is null or public.session_role() not in ('admin', 'livreur') then
    return json_build_object('ok', false, 'erreur', 'session_requise'); end if;
  if not interne.l041_cmd_autorisee(p_cmd_id, false) then return json_build_object('ok', false, 'erreur', 'commande_introuvable'); end if;
  select id into c from public.commandes where id = p_cmd_id for update;
  v_n := interne.l041_liberer_non_livrees(c.id, 'commande_non_livree');
  return json_build_object('ok', true, 'pieces', v_n);
end $$;

-- v7.5.206 (revue native P2 sur cfbf0fa) : commande passée « annulé » SANS avoir été livrée (l'annulation après livraison
-- passe par le recrédit, recrediter_stock_livraison) : ses pièces déclarées et non livrées sont libérées comme pour un report
-- (achat payé → stock du camion, achat prévu annulé, unité du camion libérée, déclaration remise à zéro). Rejouable sans
-- effet ; l'appli appelle aussi drop_commande_non_livree (rien de plus n'est fait la 2e fois).
create or replace function interne.l041_annulee_pieces() returns trigger
language plpgsql security definer set search_path = public, interne, pg_catalog as $$
begin
  if coalesce(new.statut, '') in ('annulé', 'annule') and coalesce(old.statut, '') not in ('annulé', 'annule', 'livré', 'livre')
     and exists (select 1 from public.commande_pieces q where q.cmd_id = new.id and q.livraison is null and q.provenance is not null) then
    perform interne.l041_liberer_non_livrees(new.id, 'commande_annulee_non_livree');
  end if;
  return null;
end $$;
revoke all on function interne.l041_annulee_pieces() from public, anon, authenticated;
drop trigger if exists commandes_annulee_pieces on public.commandes;
create trigger commandes_annulee_pieces after update of statut on public.commandes
  for each row execute function interne.l041_annulee_pieces();

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 7. Déduction du stock : seulement les pièces d'origine « Dépôt » (s'appuie sur la 040 révisée, sans la recopier)
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- La fonction de la 040 est CONSERVÉE telle quelle sous le nom interne.l041_deduire_040 (commande sans pièces : GLS, bureau,
-- commandes d'avant ce module → calcul de la 040 inchangé, mêmes journaux, même rejeu). public.deduire_stock_livraison
-- devient une enveloppe : commande découpée en pièces → retrait des seules pièces « Dépôt », avec les MÊMES règles que la
-- 040 (verrou consultatif 'l040|<commande>' puis ligne, idempotence par stock_deduit et rejeu du résultat complet
-- interne.l040_rejeu, produits verrouillés dans l'ordre des identifiants, écriture marquée l040.fonction pour les gardes,
-- journal stock_sorties_livraison et opération stock_operations : le recrédit recrediter_stock_livraison de la 040 rend
-- donc exactement ce qui a été retiré). Rejouable : si la 040 est réappliquée après la 041, la 041 réappliquée déplace de
-- nouveau sa fonction (reconnue à son texte).
do $$
declare v_src text;
begin
  select p.prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'deduire_stock_livraison' and pg_get_function_identity_arguments(p.oid) = 'p_cmd_id text';
  if v_src is null then
    raise exception 'Contrôle 041 : public.deduire_stock_livraison (migration 040) absente — appliquer d''abord la 040. Migration annulée.';
  end if;
  if position('l041_enveloppe' in v_src) = 0 then            -- c'est la fonction de la 040 : la mettre de côté
    execute 'drop function if exists interne.l041_deduire_040(text)';
    execute 'alter function public.deduire_stock_livraison(text) set schema interne';
    execute 'alter function interne.deduire_stock_livraison(text) rename to l041_deduire_040';
  end if;
end $$;
revoke all on function interne.l041_deduire_040(text) from public, anon, authenticated;

create or replace function public.deduire_stock_livraison(p_cmd_id text) returns json
language plpgsql volatile security definer set search_path = public, interne, pg_catalog as $$
-- l041_enveloppe (repère lu par la section ci-dessus : ne pas retirer)
declare
  v_role text := public.session_role();
  v_liv text := public.session_livreur();
  v_acteur text; c record; r record; s record;
  v_ids text[]; v_av integer; v_ap integer; v_ret integer;
  v_retraits jsonb := '[]'::jsonb; v_manques jsonb := '[]'::jsonb; v_res jsonb; v_op bigint; v_touches text[];
  pt record; lot record; v_lots jsonb := '[]'::jsonb; v_cycle integer; v_derog boolean;
begin
  if v_role is null or v_role not in ('admin', 'collab', 'livreur') then
    return json_build_object('ok', false, 'erreur', 'session_requise');
  end if;
  if coalesce(btrim(p_cmd_id), '') = '' then return json_build_object('ok', false, 'erreur', 'commande_requise'); end if;
  -- commande sans pièces : la 040, inchangée — SAUF (v7.5.205, avis chatgpt-review n° 1) une commande CONCERNÉE
  -- (interne.l041_concernee : nos livreurs, livreur attribué, pas déjà livrée à l'activation — v7.5.206) jamais découpée : posée « livré » hors
  -- de l'application, elle ne contourne pas les trois contrôles ; la déduction attend le découpage et la confirmation des
  -- pièces, ou la dérogation de l'administrateur (cycle 1)
  if not exists (select 1 from public.commande_pieces where cmd_id = p_cmd_id) then
    select id, statut, stock_deduit, transporteur, livreur into c from public.commandes where id = p_cmd_id;
    if found and coalesce(c.statut, '') in ('livré', 'livre') and not coalesce(c.stock_deduit, false)
       and interne.l041_concernee(c.transporteur, c.livreur, c.id) and interne.l041_cmd_autorisee(p_cmd_id, true)
       and not exists (select 1 from public.drop_derogations d where d.cmd_id = p_cmd_id and d.cycle = 1) then
      perform interne.l041_alerte('livre_sans_confirmation', 'cmd:' || p_cmd_id, p_cmd_id, null, null,
        'Livré sans découpage en pièces : ' || p_cmd_id || ' — stock NON retiré tant que les pièces ne sont pas découpées et confirmées (ou dérogation de l''administrateur)', null);
      return json_build_object('ok', false, 'erreur', 'decoupage_requis');
    end if;
    return interne.l041_deduire_040(p_cmd_id);
  end if;
  v_acteur := v_role || coalesce(':' || v_liv, '');
  -- mêmes verrous et même ordre que la 040 (consultatif puis ligne) : la déduction et le recrédit s'attendent
  perform pg_advisory_xact_lock(hashtext('l040|' || p_cmd_id));
  select id, statut, stock_deduit into c from public.commandes
   where id = p_cmd_id
     and (v_role <> 'livreur'
          or (v_liv is not null and upper(coalesce(livreur, '')) = v_liv
              and coalesce(date_livraison, '') >= to_char(current_date - 2, 'YYYY-MM-DD')
              and coalesce(date_livraison, '') <= to_char(current_date + 2, 'YYYY-MM-DD')))
   for update;
  if not found then return json_build_object('ok', false, 'erreur', 'commande_introuvable'); end if;
  if coalesce(c.stock_deduit, false) then return interne.l040_rejeu(c.id, 'deduction'); end if;   -- idempotente
  if coalesce(c.statut, '') not in ('livré', 'livre') then
    return json_build_object('ok', false, 'erreur', 'commande_non_livree', 'statut', c.statut);
  end if;
  -- pièces verrouillées (la confirmation de livraison ne change plus pendant le retrait), puis produits dans l'ordre
  perform 1 from public.commande_pieces where cmd_id = c.id order by id for update;
  -- v7.5.201 (revue Codex P1) : une pièce dont la livraison n'est PAS confirmée (livraison NULL) n'est jamais tenue pour
  -- livrée : la déduction ATTEND la confirmation (drop_confirmer_livraison) ; seule une dérogation de l'administrateur
  -- (drop_livre_sans_confirmation, motif journalisé) la laisse partir comme avant (pièces non fournisseur retirées + alerte)
  select max(cycle) into v_cycle from public.commande_pieces where cmd_id = c.id;
  v_derog := exists (select 1 from public.drop_derogations d where d.cmd_id = c.id and d.cycle = v_cycle);
  if exists (select 1 from public.commande_pieces where cmd_id = c.id and livraison is null) and not v_derog then
    perform interne.l041_alerte('livre_sans_confirmation', 'cmd:' || c.id, c.id, null, null,
      'Livré sans confirmation des pièces : ' || c.id || ' — stock NON retiré tant que les pièces ne sont pas confirmées (ou dérogation de l''administrateur)', null);
    return json_build_object('ok', false, 'erreur', 'pieces_non_confirmees');
  end if;
  -- v7.5.205 (avis chatgpt-review sur 3728fb8, point 3) : une pièce « stock tampon » dont le lot est ÉPUISÉ n'est jamais
  -- retirée en silence du stock du dépôt au prix de revient BMS : refus AVANT toute écriture (alerte), jusqu'à la correction
  -- explicite et tracée de l'administrateur (drop_tampon_corriger : la pièce est notée « Dépôt — stock BMS », motif
  -- journalisé) ou sa dérogation (drop_livre_sans_confirmation, motif journalisé)
  if not v_derog then
    perform 1 from public.stock_tampon_lots l
     where (l.produit_id, l.fournisseur_id) in (select q.produit_id, q.fournisseur_id from public.commande_pieces q
                                                 where q.cmd_id = c.id and q.provenance = 'tampon')
     order by l.id for update;
    if exists (select 1 from (select q.produit_id, q.fournisseur_id, min(q.libelle) as libelle, count(*) as n from public.commande_pieces q
                                where q.cmd_id = c.id and q.provenance = 'tampon' and coalesce(q.livraison, 'livree') = 'livree'
                                  and not exists (select 1 from public.tampon_sorties ts where ts.piece_id = q.id and ts.cycle = q.cycle)
                                group by q.produit_id, q.fournisseur_id) g
                where coalesce((select sum(l.quantite_restante) from public.stock_tampon_lots l
                                 where l.produit_id = g.produit_id and l.fournisseur_id = g.fournisseur_id), 0) < g.n) then
      perform interne.l041_alerte('tampon_epuise', 'cmd:' || c.id, c.id, null, null,
        'Stock tampon épuisé à la livraison : ' || c.id || ' — stock NON retiré ; l''administrateur corrige la provenance (« Dépôt — stock BMS », motif) ou déroge', null);
      return json_build_object('ok', false, 'erreur', 'stock_tampon_epuise');
    end if;
  end if;
  select coalesce(array_agg(distinct produit_id order by produit_id), '{}') into v_ids
    from public.commande_pieces where cmd_id = c.id and produit_id is not null;
  perform 1 from public.produits where id = any (v_ids) order by id for update;
  -- SEULES les pièces d'origine « Dépôt » (Dépôt, pièce du camion venue du dépôt, ou provenance non déclarée = comme avant
  -- ce module) ; jamais une pièce fournisseur (ni une pièce du camion achetée), jamais une pièce « pas livrée » ; pas de
  -- substitution (la pièce est un produit précis : un manque est signalé)
  perform set_config('l040.fonction', '1', true);
  for r in select produit_id, min(libelle) as libelle, min(composant_de) as composant_de, count(*)::integer as n
             from public.commande_pieces
            where cmd_id = c.id and coalesce(livraison, 'livree') = 'livree'
              and (provenance is null or provenance in ('depot', 'tampon') or (provenance = 'camion' and origine = 'depot'))
            group by produit_id order by produit_id nulls last loop
    select stock, nom into s from public.produits where id = r.produit_id;
    if r.produit_id is null or not found then
      v_manques := v_manques || jsonb_build_array(jsonb_build_object('produit_id', r.produit_id, 'nom', r.libelle,
        'raison', 'produit_introuvable', 'demande', r.n, 'retire', 0, 'manque', r.n));
      continue;
    end if;
    v_av := s.stock; v_ap := greatest(0, coalesce(v_av, 0) - r.n); v_ret := greatest(0, coalesce(v_av, 0) - v_ap);
    update public.produits set stock = v_ap, updated_at = now() where id = r.produit_id;
    insert into public.stock_sorties_livraison (cmd_id, produit_id, produit_nom, qte_demandee, qte_retiree, stock_avant,
      stock_apres, composant_de, substitue_de, acteur)
    values (c.id, r.produit_id, s.nom, r.n, v_ret, v_av, v_ap, r.composant_de, null, v_acteur);
    v_retraits := v_retraits || jsonb_build_array(jsonb_build_object('produit_id', r.produit_id, 'nom', s.nom, 'qte', v_ret,
      'demande', r.n, 'stock_avant', v_av, 'stock_apres', v_ap, 'composant_de', r.composant_de, 'substitue_de', null));
    if v_ret < r.n then
      v_manques := v_manques || jsonb_build_array(jsonb_build_object('produit_id', r.produit_id, 'nom', s.nom,
        'raison', 'stock_insuffisant', 'demande', r.n, 'retire', v_ret, 'manque', r.n - v_ret));
    end if;
  end loop;
  -- STOCK TAMPON : chaque pièce « tampon » livrée sort de SON lot (premier entré, premier sorti, chez son fournisseur) ;
  -- lots verrouillés dans l'ordre (identifiant), coût figé = prix d'achat réel du lot
  for pt in select q.id, q.produit_id, q.fournisseur_id, q.libelle, q.cycle from public.commande_pieces q
            where q.cmd_id = c.id and q.provenance = 'tampon' and coalesce(q.livraison, 'livree') = 'livree'
              and not exists (select 1 from public.tampon_sorties ts where ts.piece_id = q.id and ts.cycle = q.cycle) order by q.id loop
    select l.id, l.prix_achat_ht into lot from public.stock_tampon_lots l
     where l.produit_id = pt.produit_id and l.fournisseur_id = pt.fournisseur_id and l.quantite_restante > 0
     order by l.date_achat, l.id limit 1 for update;
    if found then
      update public.stock_tampon_lots set quantite_restante = quantite_restante - 1 where id = lot.id;
      insert into public.tampon_sorties (lot_id, piece_id, cycle, cmd_id, prix_achat_ht) values (lot.id, pt.id, pt.cycle, c.id, lot.prix_achat_ht);
      insert into public.pieces_couts (piece_id, cycle, cmd_id, cout_ht, source, lot_id) values (pt.id, pt.cycle, c.id, lot.prix_achat_ht, 'tampon', lot.id)
        on conflict (piece_id, cycle) do nothing;
      v_lots := v_lots || jsonb_build_array(jsonb_build_object('piece_id', pt.id, 'lot_id', lot.id, 'produit_id', pt.produit_id));
    else
      -- plus rien dans le lot (déjà écoulé) : pièce retirée du stock du dépôt, coût au prix de revient, alerte
      insert into public.pieces_couts (piece_id, cycle, cmd_id, cout_ht, source)
      select pt.id, pt.cycle, c.id, r.prix_revient_ht, case when r.prix_revient_ht is null then 'inconnu' else 'revient' end
        from (select (select prix_revient_ht from public.produits_revient where produit_id = pt.produit_id) as prix_revient_ht) r
      on conflict (piece_id, cycle) do nothing;
      perform interne.l041_alerte('tampon_epuise', 'piece:' || pt.id, c.id, pt.id, null,
        'Stock tampon épuisé : ' || pt.libelle || ' (' || c.id || ') déclarée « stock tampon » sans lot restant — à vérifier', null);
    end if;
  end loop;
  update public.commandes set stock_deduit = true, updated_at = now() where id = c.id;
  perform set_config('l040.fonction', '', true);
  if exists (select 1 from public.commande_pieces where cmd_id = c.id and livraison is null) then
    perform interne.l041_alerte('livre_sans_confirmation', 'cmd:' || c.id, c.id, null, null,
      'Livré sans confirmation des pièces (dérogation de l''administrateur) : ' || c.id || ' — stock retiré pour les pièces non fournisseur, à vérifier', null);
  end if;
  v_res := jsonb_build_object('retraits', v_retraits, 'manques', v_manques, 'mode', 'pieces', 'lots_tampon', v_lots);
  insert into public.stock_operations (nature, cmd_id, sortie_max, resultat, acteur)
  values ('deduction', c.id, (select max(id) from public.stock_sorties_livraison where cmd_id = c.id), v_res, v_acteur)
  returning id into v_op;
  select array_agg(x ->> 'produit_id') into v_touches from jsonb_array_elements(v_retraits) x;
  return (v_res || jsonb_build_object('ok', true, 'deja', false, 'stock_deduit', true, 'operation_id', v_op,
    'stocks_actuels', interne.l040_stocks(v_touches)))::json;
end $$;
revoke all on function public.deduire_stock_livraison(text) from public, anon, authenticated;
grant execute on function public.deduire_stock_livraison(text) to anon;   -- session vérifiée DANS la fonction

-- v7.5.201 (revue Codex, réserve n° 4) : ANNULATION / RELIVRAISON. La fonction de recrédit de la 040 est CONSERVÉE telle
-- quelle sous le nom interne.l041_recrediter_040 (elle rend au stock du dépôt exactement ce qui a été retiré) ;
-- public.recrediter_stock_livraison devient une enveloppe qui, dans la MÊME transaction et sous le MÊME verrou :
--   * remet chaque pièce du stock tampon sortie et pas encore rendue dans SON lot d'origine (tampon_retours, une fois par
--     sortie) ;
--   * ouvre un nouveau CYCLE de livraison des pièces (livraison remise à NULL, cycle + 1 ; pièce du camion remise « en
--     camion ») : la relivraison redemande la confirmation, refige les coûts et refait la sortie des lots (rien n'est
--     gardé du cycle précédent ; l'historique reste, ajout seul).
do $$
declare v_src text;
begin
  select p.prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'recrediter_stock_livraison'
     and pg_get_function_identity_arguments(p.oid) = 'p_cmd_id text, p_suppression boolean';
  if v_src is null then
    raise exception 'Contrôle 041 : public.recrediter_stock_livraison (migration 040 révisée) absente — appliquer d''abord la 040. Migration annulée.';
  end if;
  if position('l041_enveloppe_recredit' in v_src) = 0 then   -- c'est la fonction de la 040 : la mettre de côté
    execute 'drop function if exists interne.l041_recrediter_040(text, boolean)';
    execute 'alter function public.recrediter_stock_livraison(text, boolean) set schema interne';
    execute 'alter function interne.recrediter_stock_livraison(text, boolean) rename to l041_recrediter_040';
  end if;
end $$;
revoke all on function interne.l041_recrediter_040(text, boolean) from public, anon, authenticated;

create or replace function public.recrediter_stock_livraison(p_cmd_id text, p_suppression boolean default false) returns json
language plpgsql volatile security definer set search_path = public, interne, pg_catalog as $$
-- l041_enveloppe_recredit (repère lu par la section ci-dessus : ne pas retirer)
declare v jsonb; ts record; v_lots jsonb := '[]'::jsonb; v_n integer := 0; v_op bigint; pq record; v_rd jsonb := '[]'::jsonb; v_cam uuid;
  v_sans_deduction boolean := false;
begin
  if coalesce(btrim(p_cmd_id), '') <> '' then perform pg_advisory_xact_lock(hashtext('l040|' || p_cmd_id)); end if;
  v := interne.l041_recrediter_040(p_cmd_id, p_suppression)::jsonb;
  if not coalesce((v ->> 'ok')::boolean, false) or not exists (select 1 from public.commande_pieces where cmd_id = p_cmd_id) then
    return v::json;   -- refus ou commande sans pièces : la 040 seule
  end if;
  if coalesce((v ->> 'deja')::boolean, false) then
    -- v7.5.206 (revue native P2 sur cfbf0fa) : la 040 répond « deja » dans DEUX cas qu'il faut distinguer :
    --   a) recrédit déjà fait et RÉCONCILIÉ (rejeu) : toutes les pièces ont été rouvertes (livraison NULL) → rien à faire ;
    --   b) livraison CONFIRMÉE pièce par pièce mais déduction JAMAIS faite (encore en attente) puis annulation : aucun stock
    --      à rendre (rien n'a été retiré), mais le cycle confirmé doit être ROUVERT comme après un recrédit — sinon une unité
    --      du camion confirmée livrée resterait « livre » et la relivraison réutiliserait les choix du cycle terminé.
    -- Cas b) seulement si la commande n'est plus « livré » (ou est supprimée) et qu'une pièce du cycle en cours a une issue.
    if not exists (select 1 from public.commande_pieces where cmd_id = p_cmd_id and livraison is not null)
       or (not coalesce(p_suppression, false)
           and exists (select 1 from public.commandes where id = p_cmd_id and coalesce(statut, '') in ('livré', 'livre'))) then
      return v::json;
    end if;
    v_sans_deduction := true;
  end if;
  v_op := nullif(v ->> 'operation_id', '')::bigint;
  if v_sans_deduction then v_op := null; end if;
  perform 1 from public.commande_pieces where cmd_id = p_cmd_id order by id for update;
  -- sorties du stock tampon pas encore rendues : chacune revient dans SON lot (lots verrouillés dans l'ordre)
  for ts in select s.id, s.lot_id, s.piece_id from public.tampon_sorties s
             where s.cmd_id = p_cmd_id and not exists (select 1 from public.tampon_retours r where r.sortie_id = s.id)
             order by s.lot_id, s.id loop
    perform 1 from public.stock_tampon_lots where id = ts.lot_id for update;
    update public.stock_tampon_lots set quantite_restante = least(quantite_initiale, quantite_restante + 1) where id = ts.lot_id;
    insert into public.tampon_retours (sortie_id, lot_id, piece_id, cmd_id, operation_id) values (ts.id, ts.lot_id, ts.piece_id, p_cmd_id, v_op);
    v_lots := v_lots || jsonb_build_array(jsonb_build_object('piece_id', ts.piece_id, 'lot_id', ts.lot_id));
  end loop;
  -- nouveau cycle : la relivraison redemande la confirmation des pièces ; une pièce du camion livrée y revient
  -- (stock_camion.id et commande_pieces.stock_camion_id sont tous deux des uuid : v7.5.205)
  update public.stock_camion sc set status = 'en_camion', retour_at = null, retour_par = null
   where sc.status = 'livre' and exists (select 1 from public.commande_pieces q where q.cmd_id = p_cmd_id and q.provenance = 'camion'
                                           and q.stock_camion_id = sc.id and q.livraison = 'livree');
  -- v7.5.205 (revue native P1) : une pièce « pas livrée » du cycle terminé n'est plus liée à cette commande : achetée, son
  -- article est dans le STOCK DU CAMION (rattaché à son achat, disponible pour toute commande) ; venue du camion, son unité a
  -- été libérée. Sa déclaration est REMISE À ZÉRO (comme drop_commande_non_livree) : à la relivraison, le livreur la
  -- redéclare (« Déjà dans le camion » pour l'article acheté, sans nouvel achat) — jamais livrée sous son ancien achat
  -- pendant que l'article reste proposé à une autre commande.
  for pq in select x.* from public.commande_pieces x where x.cmd_id = p_cmd_id and x.livraison = 'non_livree' order by x.id loop
    v_cam := interne.l041_vers_camion(pq.id);            -- rejouable : l'article acheté est déjà dans le camion (même ligne)
    update public.achats_fournisseur set statut = 'annule' where id = pq.achat_id and statut = 'prevu';
    update public.stock_camion set utilise_par_piece = null where utilise_par_piece = pq.id;
    v_rd := v_rd || jsonb_build_array(jsonb_build_object('piece_id', pq.id, 'provenance', pq.provenance, 'achat_id', pq.achat_id, 'stock_camion_id', v_cam));
  end loop;
  update public.commande_pieces set provenance = null, origine = null, fournisseur_id = null, achat_id = null, stock_camion_id = null,
         stock_camion_demande = null, declare_par = null, declare_at = null
   where cmd_id = p_cmd_id and livraison = 'non_livree';
  update public.commande_pieces set cycle = cycle + 1, livraison = null, livraison_par = null, livraison_at = null where cmd_id = p_cmd_id;
  get diagnostics v_n = row_count;
  perform interne.l041_journal('recredit_pieces', p_cmd_id, null, null, null,
    jsonb_build_object('operation_id', v_op, 'lots_restaures', v_lots, 'pieces_nouveau_cycle', v_n, 'pieces_redeclarer', v_rd,
                       'sans_deduction', v_sans_deduction));
  return (v || jsonb_build_object('lots_tampon_restaures', v_lots, 'pieces_nouveau_cycle', v_n, 'pieces_a_redeclarer', v_rd,
                                  'pieces_rouvertes_sans_deduction', v_sans_deduction))::json;
end $$;
revoke all on function public.recrediter_stock_livraison(text, boolean) from public, anon, authenticated;
grant execute on function public.recrediter_stock_livraison(text, boolean) to anon;   -- session vérifiée DANS la fonction de la 040

-- v7.5.205 (avis chatgpt-review sur 3728fb8, point 3) : CORRECTION EXPLICITE ET TRACÉE de l'administrateur pour une pièce
-- « stock tampon » livrée dont le lot s'est épuisé avant la sortie (la déduction refuse « stock_tampon_epuise ») : la pièce est
-- notée « Dépôt — stock BMS » (elle sort donc du stock du dépôt à la déduction), coût figé au prix de revient, motif
-- obligatoire au journal, alerte vue. Jamais pour une pièce déjà sortie de son lot ni une commande déjà déduite.
create or replace function public.drop_tampon_corriger(p_piece_id bigint, p_motif text) returns json
language plpgsql volatile security definer set search_path = public, interne, pg_catalog as $$
declare p record; c record; v_motif text := btrim(coalesce(p_motif, '')); v_rev numeric;
begin
  if public.session_role() is distinct from 'admin' then return json_build_object('ok', false, 'erreur', 'admin_requis'); end if;
  if length(v_motif) < 5 or length(v_motif) > 500 then return json_build_object('ok', false, 'erreur', 'motif_requis'); end if;
  select cmd_id into p from public.commande_pieces where id = p_piece_id;
  if not found then return json_build_object('ok', false, 'erreur', 'piece_introuvable'); end if;
  perform pg_advisory_xact_lock(hashtext('l040|' || p.cmd_id));
  select id, stock_deduit into c from public.commandes where id = p.cmd_id for update;
  select * into p from public.commande_pieces where id = p_piece_id for update;
  if p.provenance is distinct from 'tampon' or coalesce(p.livraison, '') <> 'livree' then
    return json_build_object('ok', false, 'erreur', 'pas_une_piece_tampon_livree'); end if;
  if coalesce(c.stock_deduit, false) or exists (select 1 from public.tampon_sorties ts where ts.piece_id = p.id and ts.cycle = p.cycle) then
    return json_build_object('ok', false, 'erreur', 'deja_sortie'); end if;
  select prix_revient_ht into v_rev from public.produits_revient where produit_id = p.produit_id;
  update public.commande_pieces set provenance = 'depot', origine = 'depot', fournisseur_id = null where id = p.id;
  insert into public.pieces_couts (piece_id, cycle, cmd_id, cout_ht, source)
  values (p.id, p.cycle, p.cmd_id, v_rev, case when v_rev is null then 'inconnu' else 'revient' end) on conflict (piece_id, cycle) do nothing;
  perform interne.l041_journal('correction_tampon_vers_depot', p.cmd_id, p.id, null, v_rev,
    jsonb_build_object('motif', v_motif, 'fournisseur_id', p.fournisseur_id, 'cycle', p.cycle));
  update public.drop_alertes set vue_par = interne.l041_acteur(), vue_at = now() where type = 'tampon_epuise' and cle = 'cmd:' || p.cmd_id and vue_at is null;
  return json_build_object('ok', true, 'piece', p.id, 'cout_ht', v_rev);
end $$;

-- v7.5.201 (revue Codex, réserve n° 1) : EXCEPTION EXPLICITE de l'administrateur — « livré » accepté sans confirmation des
-- pièces pour le cycle en cours (motif obligatoire, journalisé, alerte) ; la déduction retire alors les pièces non fournisseur
create or replace function public.drop_livre_sans_confirmation(p_cmd_id text, p_motif text) returns json
language plpgsql volatile security definer set search_path = public, interne, pg_catalog as $$
declare v_cycle integer; v_motif text := btrim(coalesce(p_motif, '')); c record;
begin
  if public.session_role() is distinct from 'admin' then return json_build_object('ok', false, 'erreur', 'admin_requis'); end if;
  if length(v_motif) < 5 or length(v_motif) > 500 then return json_build_object('ok', false, 'erreur', 'motif_requis'); end if;
  select id, transporteur, livreur into c from public.commandes where id = p_cmd_id for update;
  if not found then return json_build_object('ok', false, 'erreur', 'commande_introuvable'); end if;
  select max(cycle) into v_cycle from public.commande_pieces where cmd_id = p_cmd_id;
  if v_cycle is null then
    -- v7.5.205 (avis chatgpt-review n° 1) : commande CONCERNÉE jamais découpée : dérogation du cycle 1 (la seule voie pour
    -- la passer « livré » sans découpage) ; une commande non concernée n'a besoin d'aucune dérogation
    if not interne.l041_concernee(c.transporteur, c.livreur, c.id) then
      return json_build_object('ok', false, 'erreur', 'rien_a_deroger'); end if;
    v_cycle := 1;
  elsif not exists (select 1 from public.commande_pieces where cmd_id = p_cmd_id and livraison is null) then
    return json_build_object('ok', false, 'erreur', 'rien_a_deroger'); end if;
  if exists (select 1 from public.drop_derogations where cmd_id = p_cmd_id and cycle = v_cycle) then
    return json_build_object('ok', true, 'deja', true, 'cycle', v_cycle); end if;
  insert into public.drop_derogations (cmd_id, cycle, motif, acteur) values (p_cmd_id, v_cycle, v_motif, interne.l041_acteur());
  perform interne.l041_journal('derogation_livre', p_cmd_id, null, null, null, jsonb_build_object('cycle', v_cycle, 'motif', v_motif));
  perform interne.l041_alerte('livre_sans_confirmation', 'derog:' || p_cmd_id || ':' || v_cycle, p_cmd_id, null, null,
    'Dérogation : ' || p_cmd_id || ' peut passer « livré » sans confirmation des pièces — motif : ' || v_motif, null);
  return json_build_object('ok', true, 'deja', false, 'cycle', v_cycle);
end $$;

-- v7.5.201 (revue Codex, réserve n° 1) : la BASE refuse le passage à « livré » d'une commande dont une pièce n'est pas
-- confirmée (sessions de l'application : livreur, collaboratrice, administrateur), sauf dérogation de l'administrateur.
-- Compatibilité : une commande jamais découpée n'est bloquée que si elle est CONCERNÉE (v7.5.205 : interne.l041_concernee —
-- jamais GLS, ni sans livreur, ni déjà livrée à l'activation du module (v7.5.206), ni encore livrée)
-- ; un upsert (POST merge-duplicates) d'une commande existante est contrôlé par sa branche UPDATE.
create or replace function interne.l041_livre_garde() returns trigger
language plpgsql security definer set search_path = public, interne, pg_catalog as $$
declare v_cycle integer; v_n integer; v_tot integer; v_role text := public.session_role(); v_conc boolean;
begin
  if coalesce(new.statut, '') not in ('livré', 'livre') or v_role is null then return new; end if;
  if tg_op = 'UPDATE' and coalesce(old.statut, '') in ('livré', 'livre') then return new; end if;
  if tg_op = 'INSERT' and exists (select 1 from public.commandes x where x.id = new.id) then return new; end if;   -- upsert : la mise à jour contrôle
  select max(cycle), count(*), count(*) filter (where livraison is null) into v_cycle, v_tot, v_n from public.commande_pieces where cmd_id = new.id;
  if coalesce(v_tot, 0) = 0 then
    -- v7.5.205 (avis chatgpt-review n° 1) : commande jamais découpée. Non concernée (GLS, sans livreur, déjà livrée à
    -- l'activation, v7.5.206) : jamais bloquée, comme avant. CONCERNÉE : « livré » refusé tant qu'elle n'est ni découpée ni confirmée,
    -- sauf dérogation de l'administrateur (cycle 1). Valeurs lues : celles d'AVANT la mise à jour pour le livreur (sa garde
    -- de la 019, qui passe après ce déclencheur, les lui impose de toute façon : il ne peut pas vider le livreur ou changer
    -- le transporteur dans la même écriture pour contourner le contrôle) ; date de création toujours celle d'avant.
    if tg_op = 'UPDATE' then
      v_conc := case when v_role = 'livreur' then interne.l041_concernee(old.transporteur, old.livreur, old.id)
                     else interne.l041_concernee(new.transporteur, new.livreur, old.id) end;
    else
      v_conc := interne.l041_concernee(new.transporteur, new.livreur, new.id);
    end if;
    if not v_conc then return new; end if;
    if exists (select 1 from public.drop_derogations d where d.cmd_id = new.id and d.cycle = 1) then return new; end if;
    raise exception using errcode = 'P0001',
      message = 'DECOUPAGE_REQUIS : la commande ' || new.id || ' (livrée par nos livreurs) n''a pas été découpée en pièces ni confirmée (dropshipping)',
      hint = 'Le livreur ouvre le chargement (pièces) puis indique chaque pièce à la livraison, ou l''administrateur accorde une dérogation motivée.';
  end if;
  if coalesce(v_n, 0) = 0 then return new; end if;
  if exists (select 1 from public.drop_derogations d where d.cmd_id = new.id and d.cycle = v_cycle) then return new; end if;
  raise exception using errcode = 'P0001',
    message = 'PIECES_NON_CONFIRMEES : ' || v_n || ' pièce(s) de la commande ' || new.id || ' sans confirmation de livraison (dropshipping)',
    hint = 'Le livreur indique chaque pièce (livrée ou pas), ou l''administrateur accorde une dérogation motivée.';
end $$;
revoke all on function interne.l041_livre_garde() from public, anon, authenticated;
drop trigger if exists commandes_livre_garde on public.commandes;
create trigger commandes_livre_garde before insert or update of statut on public.commandes
  for each row execute function interne.l041_livre_garde();


-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 8. Administrateur : alertes, marge d'une commande, bilan du jour
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- relève les alertes « pièce achetée restée dans le camion plus de N jours » puis renvoie les alertes non vues
create or replace function public.drop_controler() returns json
language plpgsql volatile security definer set search_path = public, interne, pg_catalog as $$
declare v_jours numeric := coalesce(interne.l041_reglage('drop_camion_alerte_jours'), 3); sc record;
  v_jours_t numeric := coalesce(interne.l041_reglage('drop_tampon_alerte_jours'), 30); lt record;
begin
  if public.session_role() is distinct from 'admin' then return json_build_object('ok', false, 'erreur', 'admin_requis'); end if;
  for sc in select s.id, s.produit_libelle, s.livreur, s.charge_at, s.achat_id, a.montant_paye_ht, a.cmd_id
              from public.stock_camion s join public.achats_fournisseur a on a.id = s.achat_id
             where s.status = 'en_camion' and s.utilise_par_piece is null
               and s.charge_at::timestamptz < now() - make_interval(days => greatest(0, v_jours)::integer) loop
    perform interne.l041_alerte('camion_ancien', 'sc:' || sc.id, sc.cmd_id, null, sc.achat_id,
      'Pièce achetée dans le camion depuis plus de ' || v_jours || ' jours : ' || sc.produit_libelle || ' (' || coalesce(sc.livreur, '?')
      || ', chargée le ' || to_char(sc.charge_at::timestamptz, 'DD/MM/YYYY') || ')', sc.montant_paye_ht);
  end loop;
  for lt in select l.id, l.quantite_restante, l.date_achat, l.prix_achat_ht, x.nom as produit, f.nom as fournisseur
              from public.stock_tampon_lots l join public.fournisseurs f on f.id = l.fournisseur_id left join public.produits x on x.id = l.produit_id
             where l.quantite_restante > 0 and l.date_achat < current_date - greatest(0, v_jours_t)::integer loop
    perform interne.l041_alerte('tampon_ancien', 'lot:' || lt.id, null, null, null,
      'Stock tampon qui dort depuis plus de ' || v_jours_t || ' jours : ' || lt.quantite_restante || ' × ' || coalesce(lt.produit, '?') || ' ('
      || lt.fournisseur || ', acheté le ' || to_char(lt.date_achat, 'DD/MM/YYYY') || ')', round(lt.quantite_restante * lt.prix_achat_ht, 2));
  end loop;
  return json_build_object('ok', true, 'jours', v_jours, 'jours_tampon', v_jours_t, 'alertes', coalesce((select json_agg(row_to_json(a) order by a.cree_at desc)
    from (select id, type, cmd_id, piece_id, achat_id, message, montant, cree_at from public.drop_alertes where vue_at is null) a), '[]'::json));
end $$;

create or replace function public.drop_alerte_vue(p_id bigint) returns json
language plpgsql volatile security definer set search_path = public, interne, pg_catalog as $$
begin
  if public.session_role() is distinct from 'admin' then return json_build_object('ok', false, 'erreur', 'admin_requis'); end if;
  update public.drop_alertes set vue_par = interne.l041_acteur(), vue_at = now() where id = p_id and vue_at is null;
  perform interne.l041_journal('alerte_vue', null, null, null, null, jsonb_build_object('alerte', p_id));
  return json_build_object('ok', true);
end $$;

-- marge d'une commande (fiche, détail de tournée) : pièces, provenance, fournisseur, prix payé, mode, ticket, heure, coût
create or replace function interne.l041_marge(p_cmd_id text) returns jsonb
language plpgsql stable security definer set search_path = public, interne, pg_catalog as $$
declare c record; v_tva numeric := coalesce(interne.l041_reglage('drop_tva_pct'), 20); v_gls numeric := interne.l041_reglage('drop_gls_cout_commande_ht');
  v_pieces jsonb := '[]'::jsonb; p record; v_cout record; v_total numeric := 0; v_inconnu integer := 0; v_estime boolean := false;
  v_c numeric; v_s text; v_fige boolean; d record; v_rev numeric; v_gls_c numeric; v_hb jsonb;
  v_poids_tot numeric := 0; v_poids_liv numeric := 0; v_w numeric; v_n_tot integer := 0; v_n_liv integer := 0; v_vente_ht numeric; v_reconnue numeric;
begin
  select id, prix, statut, transporteur, date_livraison into c from public.commandes where id = p_cmd_id;
  if not found then return null; end if;
  if exists (select 1 from public.commande_pieces where cmd_id = c.id) then
    for p in select q.*, f.nom as fournisseur_nom, a.prix_prevu_ht, a.montant_paye_ht, a.montant_paye_ttc, a.mode, a.ticket_path, a.paye_at, a.statut as achat_statut,
                    pc.cout_ht as cout_fige, pc.source as source_fige
               from public.commande_pieces q
               left join public.fournisseurs f on f.id = q.fournisseur_id
               left join public.achats_fournisseur a on a.id = q.achat_id
               left join public.pieces_couts pc on pc.piece_id = q.id and pc.cycle = q.cycle   -- v7.5.201 : coût du cycle en cours
              where q.cmd_id = c.id order by q.ligne_idx, q.piece_idx loop
      v_fige := p.source_fige is not null;
      if v_fige then v_c := p.cout_fige; v_s := p.source_fige;
      else select * into v_cout from interne.l041_cout_piece(p.id); v_c := v_cout.cout; v_s := v_cout.source; end if;
      -- v7.5.203 (avis chatgpt-review n° 3 sur 77441b6) : LIVRAISON PARTIELLE — part du prix de chaque pièce au prorata du prix
      -- catalogue de son produit (parts égales si aucun prix connu) ; une pièce « pas livrée » n'est comptée ni en vente ni en coût
      v_w := coalesce((select x.prix from public.produits x where x.id = p.produit_id and x.prix > 0), 0);
      v_poids_tot := v_poids_tot + v_w; v_n_tot := v_n_tot + 1;
      if coalesce(p.livraison, 'livree') = 'livree' then
        v_poids_liv := v_poids_liv + v_w; v_n_liv := v_n_liv + 1;
        if v_c is null then v_inconnu := v_inconnu + 1; else v_total := v_total + v_c; end if;
        if not v_fige then v_estime := true; end if;
      end if;
      v_pieces := v_pieces || jsonb_build_array(jsonb_build_object('id', p.id, 'libelle', p.libelle, 'provenance', p.provenance,
        'origine', p.origine, 'fournisseur', p.fournisseur_nom, 'prix_prevu_ht', p.prix_prevu_ht, 'montant_paye_ht', p.montant_paye_ht, 'montant_paye_ttc', p.montant_paye_ttc,
        'mode', p.mode, 'ticket_path', p.ticket_path, 'paye_at', p.paye_at, 'achat_statut', p.achat_statut,
        'declare_par', p.declare_par, 'declare_at', p.declare_at, 'livraison', p.livraison, 'livraison_at', p.livraison_at,
        'cout_ht', v_c, 'source', v_s, 'fige', v_fige));
    end loop;
  else
    -- commande sans pièces (GLS, bureau, avant ce module) : coût ESTIMÉ au prix de revient actuel de chaque pièce théorique
    v_estime := true;
    -- v7.5.201 : quantités hors bornes : pas d'estimation tronquée, coût signalé inconnu
    v_hb := interne.l041_hors_borne((select lignes from public.commandes where id = c.id), (select produit from public.commandes where id = c.id),
                                    (select to_jsonb(qte) from public.commandes where id = c.id));
    if v_hb is not null then v_inconnu := v_inconnu + 1;
      v_pieces := jsonb_build_array(jsonb_build_object('libelle', 'quantité hors bornes', 'provenance', null, 'cout_ht', null, 'source', 'inconnu', 'fige', false, 'hors_borne', v_hb));
    else
    for d in select * from interne.l041_decomposer((select lignes from public.commandes where id = c.id), (select produit from public.commandes where id = c.id),
                                                   (select to_jsonb(qte) from public.commandes where id = c.id)) loop
      select prix_revient_ht into v_rev from public.produits_revient where produit_id = d.produit_id;
      if v_rev is null then v_inconnu := v_inconnu + 1; else v_total := v_total + v_rev; end if;
      v_pieces := v_pieces || jsonb_build_array(jsonb_build_object('libelle', d.libelle, 'provenance', null, 'cout_ht', v_rev,
        'source', case when v_rev is null then 'inconnu' else 'revient' end, 'fige', false));
      v_rev := null;
    end loop;
    end if;
  end if;
  v_gls_c := case when upper(coalesce(c.transporteur, '')) = 'GLS' then v_gls end;
  v_vente_ht := interne.l041_ht(c.prix, v_tva);
  -- vente RECONNUE = part des pièces effectivement livrées (toute la vente si la commande n'est pas découpée en pièces)
  v_reconnue := case when v_n_tot = 0 then v_vente_ht
                     when v_poids_tot > 0 then round(v_vente_ht * v_poids_liv / v_poids_tot, 2)
                     else round(v_vente_ht * v_n_liv / v_n_tot, 2) end;
  return jsonb_build_object('cmd_id', c.id, 'statut', c.statut, 'date_livraison', c.date_livraison, 'transporteur', c.transporteur,
    'vente_ttc', coalesce(c.prix, 0), 'vente_ht_commande', v_vente_ht, 'vente_ht', v_reconnue,
    'vente_non_reconnue_ht', round(v_vente_ht - v_reconnue, 2), 'livraison_partielle', v_n_liv < v_n_tot,
    'pieces_livrees', v_n_liv, 'pieces_total', v_n_tot, 'cout_ht', round(v_total, 2),
    'cout_inconnu', v_inconnu, 'cout_estime', v_estime,
    'gls_ht', v_gls_c, 'gls_non_renseigne', upper(coalesce(c.transporteur, '')) = 'GLS' and v_gls is null,
    'marge_ht', round(v_reconnue - v_total - coalesce(v_gls_c, 0), 2), 'pieces', v_pieces);
end $$;
revoke all on function interne.l041_marge(text) from public, anon, authenticated;

create or replace function public.drop_marge_commande(p_cmd_id text) returns json
language plpgsql stable security definer set search_path = public, interne, pg_catalog as $$
begin
  if public.session_role() is distinct from 'admin' then return json_build_object('ok', false, 'erreur', 'admin_requis'); end if;
  if not exists (select 1 from public.commandes where id = p_cmd_id) then return json_build_object('ok', false, 'erreur', 'commande_introuvable'); end if;
  return (jsonb_build_object('ok', true) || interne.l041_marge(p_cmd_id))::json;
end $$;

-- BILAN DU JOUR : commandes livrées à cette date de livraison (règle du tableau de bord), hors lignes #TEST
create or replace function public.drop_bilan_jour(p_date text) returns json
language plpgsql stable security definer set search_path = public, interne, pg_catalog as $$
declare v_cmds jsonb := '[]'::jsonb; m jsonb; r record; v_ventes numeric := 0; v_cout numeric := 0; v_gls numeric := 0;
  v_inconnu integer := 0; v_gls_nr integer := 0; v_estimes integer := 0; v_fixes numeric := interne.l041_reglage('drop_charges_fixes_jour_ht');
  v_non_rec numeric := 0; v_partielles integer := 0;
  v_resultat numeric;
begin
  if public.session_role() is distinct from 'admin' then return json_build_object('ok', false, 'erreur', 'admin_requis'); end if;
  if p_date is null or p_date !~ '^\d{4}-\d{2}-\d{2}$' then return json_build_object('ok', false, 'erreur', 'date_invalide'); end if;
  for r in select id from public.commandes where date_livraison = p_date and statut in ('livré', 'livre') and id not like '#TEST%' order by id loop
    m := interne.l041_marge(r.id);
    v_ventes := v_ventes + (m ->> 'vente_ht')::numeric;   -- v7.5.203 : vente RECONNUE (pièces livrées)
    v_non_rec := v_non_rec + coalesce((m ->> 'vente_non_reconnue_ht')::numeric, 0);
    if coalesce((m ->> 'livraison_partielle')::boolean, false) then v_partielles := v_partielles + 1; end if;
    v_cout := v_cout + (m ->> 'cout_ht')::numeric;
    v_gls := v_gls + coalesce((m ->> 'gls_ht')::numeric, 0);
    v_inconnu := v_inconnu + (m ->> 'cout_inconnu')::integer;
    if (m ->> 'gls_non_renseigne')::boolean then v_gls_nr := v_gls_nr + 1; end if;
    if (m ->> 'cout_estime')::boolean then v_estimes := v_estimes + 1; end if;
    v_cmds := v_cmds || jsonb_build_array((m - 'pieces') || jsonb_build_object('provenances',
      (select jsonb_object_agg(coalesce(z.prov, 'non_declaree'), z.n)
         from (select x2 ->> 'provenance' as prov, count(*) as n from jsonb_array_elements(m -> 'pieces') x2 group by 1) z)));
  end loop;
  v_resultat := round(v_ventes - v_cout - v_gls, 2);
  return json_build_object('ok', true, 'date', p_date, 'commandes', jsonb_array_length(v_cmds),
    'ventes_ht', round(v_ventes, 2), 'cout_produits_ht', round(v_cout, 2), 'gls_ht', round(v_gls, 2), 'resultat_ht', v_resultat,
    'charges_fixes_ht', v_fixes, 'resultat_net_ht', case when v_fixes is not null then round(v_resultat - v_fixes, 2) end,
    'pieces_cout_inconnu', v_inconnu, 'commandes_gls_non_renseigne', v_gls_nr, 'commandes_cout_estime', v_estimes,
    'ventes_non_reconnues_ht', round(v_non_rec, 2), 'livraisons_partielles', v_partielles,
    'detail', v_cmds::json);
end $$;

-- ENTRÉE DE STOCK TAMPON (administrateur) : p_lignes = [{ "produit_id": …, "qte": n, "prix_ttc": prix PAYÉ TTC par pièce,
-- "prix_ht": HT de la facture par pièce (facultatif) }] — v7.5.201 (caisse TTC, marge HT) : la facture du fournisseur est
-- TTC ; le coût HT d'un lot = HT saisi, sinon TTC ÷ (1 + TVA) ; une ligne ancienne avec prix_ht seul reste acceptée (TTC =
-- HT × (1 + TVA)). Tout ou rien ; le stock du dépôt augmente PAR LA BASE (mouvement_stock_produit de la 040, une clé par
-- ligne) ; rejouée avec la même clé : « deja », rien de plus (la même clé avec un autre fournisseur ou une autre date est
-- refusée : cle_deja_utilisee). Quantité : 1 à 10 000 par ligne, 50 lignes au plus (refus explicite au-delà).
create or replace function public.drop_tampon_entree(p_cle text, p_fournisseur_id bigint, p_date date, p_mode text,
  p_ticket_path text, p_lignes jsonb) returns json
language plpgsql volatile security definer set search_path = public, interne, pg_catalog as $$
declare v_e record; l jsonb; v_q integer; v_px numeric; v_ttc numeric; v_total numeric := 0; v_total_ttc numeric := 0; v_id bigint; v_m json;
  v_lots jsonb := '[]'::jsonb; v_lot bigint; v_tva numeric := interne.l041_tva();
begin
  if public.session_role() is distinct from 'admin' then return json_build_object('ok', false, 'erreur', 'admin_requis'); end if;
  if coalesce(length(p_cle), 0) not between 8 and 80 then return json_build_object('ok', false, 'erreur', 'cle_requise'); end if;
  perform pg_advisory_xact_lock(hashtext('l041t|' || p_cle));
  select id, fournisseur_id, date_achat, total_ht, total_ttc into v_e from public.stock_tampon_entrees where cle = p_cle;
  if found then
    if v_e.fournisseur_id is distinct from p_fournisseur_id or v_e.date_achat is distinct from p_date then
      return json_build_object('ok', false, 'erreur', 'cle_deja_utilisee', 'entree_id', v_e.id); end if;
    return json_build_object('ok', true, 'deja', true, 'entree_id', v_e.id, 'total_ht', v_e.total_ht, 'total_ttc', v_e.total_ttc);
  end if;
  if not exists (select 1 from public.fournisseurs where id = p_fournisseur_id and actif) then return json_build_object('ok', false, 'erreur', 'fournisseur_introuvable'); end if;
  if p_date is null or p_date > current_date or p_date < current_date - 366 then return json_build_object('ok', false, 'erreur', 'date_invalide'); end if;
  if coalesce(p_mode, '') not in ('especes', 'cb', 'virement', 'autre') then return json_build_object('ok', false, 'erreur', 'mode_invalide'); end if;
  if p_ticket_path is not null and (split_part(p_ticket_path, '/', 1) <> 'tampon' or split_part(p_ticket_path, '/', 3) !~ '^[A-Za-z0-9._-]{1,120}$'
     or split_part(p_ticket_path, '/', 4) <> '') then return json_build_object('ok', false, 'erreur', 'chemin_ticket_invalide'); end if;
  if jsonb_typeof(p_lignes) <> 'array' or jsonb_array_length(p_lignes) = 0 or jsonb_array_length(p_lignes) > 50 then
    return json_build_object('ok', false, 'erreur', 'lignes_requises'); end if;
  for l in select x.value from jsonb_array_elements(p_lignes) x loop
    if not exists (select 1 from public.produits where id = l ->> 'produit_id') then return json_build_object('ok', false, 'erreur', 'produit_introuvable', 'produit_id', l ->> 'produit_id'); end if;
    if coalesce(l ->> 'qte', '') !~ '^[0-9]{1,5}$' or (l ->> 'qte')::integer < 1 or (l ->> 'qte')::integer > 10000 then
      return json_build_object('ok', false, 'erreur', 'quantite_invalide'); end if;
    if l ->> 'prix_ttc' is null and l ->> 'prix_ht' is null then return json_build_object('ok', false, 'erreur', 'prix_invalide'); end if;
    if l ->> 'prix_ttc' is not null and (l ->> 'prix_ttc' !~ '^[0-9]{1,6}(\.[0-9]{1,2})?$' or (l ->> 'prix_ttc')::numeric <= 0) then
      return json_build_object('ok', false, 'erreur', 'prix_invalide'); end if;
    if l ->> 'prix_ht' is not null and (l ->> 'prix_ht' !~ '^[0-9]{1,6}(\.[0-9]{1,2})?$' or (l ->> 'prix_ht')::numeric <= 0) then
      return json_build_object('ok', false, 'erreur', 'prix_invalide'); end if;
    v_ttc := coalesce(round((l ->> 'prix_ttc')::numeric, 2), interne.l041_ttc((l ->> 'prix_ht')::numeric, v_tva));
    v_px := coalesce(round((l ->> 'prix_ht')::numeric, 2), interne.l041_ht(v_ttc, v_tva));
    if v_px > v_ttc then return json_build_object('ok', false, 'erreur', 'prix_ht_superieur_ttc'); end if;
    v_total := v_total + (l ->> 'qte')::integer * v_px;
    v_total_ttc := v_total_ttc + (l ->> 'qte')::integer * v_ttc;
  end loop;
  insert into public.stock_tampon_entrees (cle, fournisseur_id, date_achat, mode, ticket_path, total_ht, total_ttc, tva_pct, acteur)
  values (p_cle, p_fournisseur_id, p_date, p_mode, p_ticket_path, round(v_total, 2), round(v_total_ttc, 2), v_tva, interne.l041_acteur()) returning id into v_id;
  for l in select x.value from jsonb_array_elements(p_lignes) with ordinality x(value, o) order by x.o loop
    v_q := (l ->> 'qte')::integer;
    v_ttc := coalesce(round((l ->> 'prix_ttc')::numeric, 2), interne.l041_ttc((l ->> 'prix_ht')::numeric, v_tva));
    v_px := coalesce(round((l ->> 'prix_ht')::numeric, 2), interne.l041_ht(v_ttc, v_tva));
    insert into public.stock_tampon_lots (entree_id, fournisseur_id, produit_id, date_achat, prix_achat_ht, quantite_initiale, quantite_restante)
    values (v_id, p_fournisseur_id, l ->> 'produit_id', p_date, v_px, v_q, v_q) returning id into v_lot;
    -- le stock du dépôt augmente par la fonction de la 040 (verrou, journal stock_operations, gardes)
    v_m := public.mouvement_stock_produit(l ->> 'produit_id', 'entree', v_q, 'Stock tampon dropshipping (lot ' || v_lot || ')', 'tampon:' || p_cle || ':' || v_lot);
    if not coalesce((v_m ->> 'ok')::boolean, false) then
      raise exception 'drop_tampon_entree : mouvement de stock refusé (%)', v_m ->> 'erreur';   -- tout est annulé
    end if;
    v_lots := v_lots || jsonb_build_array(jsonb_build_object('lot_id', v_lot, 'produit_id', l ->> 'produit_id', 'qte', v_q, 'prix_ht', v_px,
      'prix_ttc', v_ttc, 'stock_apres', v_m ->> 'stock_apres'));
  end loop;
  perform interne.l041_journal('tampon_entree', null, null, null, round(v_total, 2),
    jsonb_build_object('entree_id', v_id, 'fournisseur_id', p_fournisseur_id, 'mode', p_mode, 'lots', v_lots, 'ticket', p_ticket_path is not null,
                       'total_ttc', round(v_total_ttc, 2), 'tva_pct', v_tva));
  return json_build_object('ok', true, 'deja', false, 'entree_id', v_id, 'total_ht', round(v_total, 2), 'total_ttc', round(v_total_ttc, 2), 'lots', v_lots);
end $$;

-- STOCK TAMPON RESTANT par fournisseur et par référence, avec sa valeur (prix d'achat réel des lots) ; administrateur
create or replace function public.drop_tampon_etat() returns json
language plpgsql stable security definer set search_path = public, interne, pg_catalog as $$
begin
  if public.session_role() is distinct from 'admin' then return json_build_object('ok', false, 'erreur', 'admin_requis'); end if;
  return json_build_object('ok', true,
    'fournisseurs', coalesce((select json_agg(z order by z.nom) from (
      select f.id as fournisseur_id, f.nom, sum(l.quantite_restante)::integer as restant, round(sum(l.quantite_restante * l.prix_achat_ht), 2) as valeur_ht,
             json_agg(json_build_object('lot_id', l.id, 'produit_id', l.produit_id, 'produit', x.nom, 'restant', l.quantite_restante,
               'initial', l.quantite_initiale, 'prix_ht', l.prix_achat_ht, 'date_achat', l.date_achat, 'jours', current_date - l.date_achat)
               order by l.date_achat, l.id) as lots
        from public.stock_tampon_lots l join public.fournisseurs f on f.id = l.fournisseur_id left join public.produits x on x.id = l.produit_id
       where l.quantite_restante > 0 group by f.id, f.nom) z), '[]'::json),
    'valeur_totale_ht', coalesce((select round(sum(quantite_restante * prix_achat_ht), 2) from public.stock_tampon_lots), 0));
end $$;

do $$
declare f text;
begin
  foreach f in array array['drop_tampon_entree(text, bigint, date, text, text, jsonb)', 'drop_tampon_etat()', 'drop_pieces(text)', 'drop_reinitialiser_pieces(text)', 'drop_declarer(bigint, text, bigint, text)',
    'drop_enlever_payer(bigint, numeric, text, text, numeric)', 'drop_ticket_ajouter(bigint, text)', 'drop_livre_sans_confirmation(text, text)', 'drop_confirmer_livraison(text, jsonb)',
    'drop_commande_non_livree(text)', 'drop_controler()', 'drop_alerte_vue(bigint)', 'drop_marge_commande(text)', 'drop_bilan_jour(text)',
    'drop_tampon_corriger(bigint, text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to anon', f);   -- session vérifiée DANS chaque fonction
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 9. Contrôle à l'application : prérequis présents (038b, 039, 040, tables historiques), rien n'est écrit
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
do $$
declare manque text;
begin
  select string_agg(t || '.' || col, ', ') into manque
    from (values ('commandes', 'id'), ('commandes', 'lignes'), ('commandes', 'produit'), ('commandes', 'qte'), ('commandes', 'prix'),
                 ('commandes', 'livreur'), ('commandes', 'statut'), ('commandes', 'date_livraison'), ('commandes', 'transporteur'),
                 ('commandes', 'stock_deduit'), ('commandes', 'created_at'), ('produits', 'composants'), ('produits', 'stock'),
                 ('produits_revient', 'prix_revient_ht'), ('stock_sorties_livraison', 'cmd_id'), ('stock_operations', 'resultat'),
                 ('stock_camion', 'id'), ('stock_camion', 'livreur'), ('stock_camion', 'produit_libelle'), ('stock_camion', 'quantite'),
                 ('stock_camion', 'source_cmd_id'), ('stock_camion', 'source_tournee_id'), ('stock_camion', 'charge_at'),
                 ('stock_camion', 'charge_par'), ('stock_camion', 'status'), ('stock_camion', 'retour_at'), ('stock_camion', 'retour_par'),
                 ('depenses', 'id'), ('depenses', 'date_depense'), ('depenses', 'cat'), ('depenses', 'montant'), ('depenses', 'livreur'),
                 ('depenses', 'comment'), ('depenses', 'mode_paie'), ('depenses', 'tournee_id'),
                 ('tournees', 'stops'), ('tournees', 'date_tournee'), ('parametres', 'cle'), ('parametres', 'valeur')) as v(t, col)
   where not exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = v.t and column_name = v.col);
  if manque is not null then
    raise exception 'Contrôle 041 : colonnes absentes (%) — appliquer d''abord 038b, 039 et 040. Migration annulée.', manque;
  end if;
  if to_regprocedure('interne.l040_qte(jsonb)') is null or to_regprocedure('interne.l040_trouver_produit(text, text)') is null
     or to_regprocedure('interne.l040_rejeu(text, text)') is null or to_regprocedure('interne.l040_stocks(text[])') is null
     or to_regprocedure('interne.l041_deduire_040(text)') is null or to_regprocedure('interne.l041_recrediter_040(text, boolean)') is null
     or to_regprocedure('public.mouvement_stock_produit(text, text, integer, text, text)') is null then
    raise exception 'Contrôle 041 : fonctions de la 040 révisée absentes — appliquer d''abord la 040 (PR 29, v7.5.198). Migration annulée.';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 10. Auto-contrôle à l'application : règles PURES (valeurs fictives, rien n'est écrit)
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
do $$
declare f text := null;
begin
  if interne.l041_mode('Espèces') is distinct from 'especes' then f := 'mode espèces'; end if;
  if f is null and interne.l041_mode('CB') is distinct from 'cb' then f := 'mode cb'; end if;
  if f is null and interne.l041_mode('chèque') is not null then f := 'mode inconnu'; end if;
  if f is null and interne.l041_ht(120, 20) <> 100 then f := 'HT 120 TTC'; end if;
  if f is null and interne.l041_ht(100, 20) <> 83.33 then f := 'HT arrondi'; end if;
  if f is null and interne.l041_ecart(100, 105.5) <> 5.5 then f := 'écart'; end if;
  if f is null and interne.l041_ecart(100, 100) <> 0 then f := 'écart nul'; end if;
  -- v7.5.201 : caisse TTC, marge HT
  if f is null and interne.l041_ttc(160, 20) <> 192 then f := 'TTC attendu'; end if;
  if f is null and interne.l041_ttc(83.33, 20) <> 100 then f := 'TTC arrondi'; end if;
  if f is null and interne.l041_ht(198, 20) <> 165 then f := 'HT de TTC payé'; end if;
  if f is null and interne.l041_qte_ligne_max() <> 50 or interne.l041_qte_composant_max() <> 20 or interne.l041_pieces_max() <> 200 then f := 'bornes'; end if;
  if f is null and not interne.l041_chemin_ticket_ok('livreur-x/123/ticket-1.jpg', 'LIVREUR-X', '#123') then f := 'chemin valide'; end if;
  if f is null and interne.l041_chemin_ticket_ok('autre/123/ticket-1.jpg', 'LIVREUR-X', '#123') then f := 'chemin autre livreur'; end if;
  if f is null and interne.l041_chemin_ticket_ok('livreur-x/124/ticket-1.jpg', 'LIVREUR-X', '#123') then f := 'chemin autre commande'; end if;
  if f is null and interne.l041_chemin_ticket_ok('livreur-x/123/../x.jpg', 'LIVREUR-X', '#123') then f := 'chemin remontée'; end if;
  if f is null and interne.l041_empreinte('[{"qte":1}]', null, 1) = interne.l041_empreinte('[{"qte":2}]', null, 1) then f := 'empreinte'; end if;
  if f is not null then
    raise exception 'Auto-contrôle 041 en échec : cas « % ». Migration annulée.', f;
  end if;
end $$;
