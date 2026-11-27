-- 042 (27/11/2026, v7.5.211) : « LIVRÉ » D'UNE COMMANDE NON CONCERNÉE JAMAIS BLOQUÉE PAR DES PIÈCES JAMAIS DÉCLARÉES.
-- Défaut observé en production (v7.5.210, commande fictive sans livreur, transporteur RANOU, statut en attente) : l'ouverture de
-- sa fiche appelait drop_pieces, qui la découpait (1 pièce, provenance vide) ; son passage à « livré » était ensuite refusé
-- (PIECES_NON_CONFIRMEES) alors que la 041 elle-même la dit NON CONCERNÉE (interne.l041_concernee : sans livreur = retrait ou
-- vente du bureau ; une commande GLS non plus ; ni une commande déjà livrée à l'activation du module).
-- La 041 est DÉJÀ appliquée : elle n'est pas modifiée. Cette migration :
--   1. remplace interne.l041_livre_garde() (déclencheur commandes_livre_garde) : une commande NON concernée dont les pièces
--      n'ont JAMAIS été déclarées (aucune provenance, aucune issue de livraison, aucun achat — même règle que le redécoupage de
--      drop_pieces) passe « livré » sans blocage ; tout le reste est inchangé (commande concernée : toujours refusée tant que
--      ses pièces ne sont pas confirmées, sauf dérogation ; commande non concernée dont une pièce A été déclarée : contrôlée
--      comme avant, pour qu'on ne puisse pas contourner le contrôle en retirant le livreur ; une commande qui ÉTAIT concernée
--      avant l'écriture reste contrôlée, même si la même écriture retire le livreur ou passe en GLS — livreur comme
--      administrateur : valeurs d'avant ET d'après) ;
--   2. enveloppe public.deduire_stock_livraison : pour cette même commande (non concernée, pièces jamais déclarées), la
--      déduction est celle de la 040 (lignes de la commande), sinon celle de la 041, inchangée — sans quoi la déduction
--      refuserait « pieces_non_confirmees » après un « livré » désormais accepté ;
--   3. ajoute public.drop_pieces_lire (avis chatgpt-review sur adf71bb, point 5) : lecture SANS création des pièces d'une
--      commande, utilisée par l'appli pour une commande déjà livrée (pièces déclarées sur un autre appareil consultables sur un
--      appareil neuf, sans jamais découper ni redécouper la commande).
-- Aucune ligne n'est créée, modifiée ni supprimée (fonctions seulement). Rejouable. Une seule transaction.
-- Prérequis : 041 appliquée. Si la 041 est REJOUÉE après la 042, rejouer la 042 ensuite (la 041 remet sa propre déduction).
--
-- RETOUR ARRIÈRE (à exécuter tel quel dans l'éditeur SQL si besoin ; aucune donnée touchée) :
--   begin;
--   -- a) déduction : remettre celle de la 041 (conservée telle quelle sous le nom interne.l042_deduire_041)
--   drop function if exists public.deduire_stock_livraison(text);
--   alter function interne.l042_deduire_041(text) set schema public;
--   alter function public.l042_deduire_041(text) rename to deduire_stock_livraison;
--   revoke all on function public.deduire_stock_livraison(text) from public, anon, authenticated;
--   grant execute on function public.deduire_stock_livraison(text) to anon;
--   -- b) garde du « livré » : rejouer le bloc « create or replace function interne.l041_livre_garde() … end $$; » de
--   --    041_dropshipping_provenance.sql (section 7, juste avant « drop trigger if exists commandes_livre_garde »), tel quel ;
--   -- c) drop function if exists interne.l042_pieces_jamais_declarees(text);
--   -- d) drop function if exists public.drop_pieces_lire(text);   (l'appli v7.5.211 revient alors à « aucune pièce lue » pour
--   --    une commande déjà livrée inconnue de l'appareil)
--   commit;

begin;

-- 0. Prérequis : la 041 est en place
do $$
begin
  if to_regclass('public.commande_pieces') is null or to_regprocedure('interne.l041_concernee(text, text, text)') is null
     or to_regprocedure('interne.l041_livre_garde()') is null or to_regprocedure('interne.l041_deduire_040(text)') is null
     or to_regprocedure('public.deduire_stock_livraison(text)') is null then
    raise exception 'Contrôle 042 : migration 041 absente — appliquer d''abord la 041. Migration annulée.';
  end if;
end $$;

-- 1. Pièces d'une commande JAMAIS déclarées : aucune provenance, aucune issue de livraison, aucun achat (même règle que le
--    redécoupage automatique de drop_pieces dans la 041). Vrai aussi s'il n'y a aucune pièce.
create or replace function interne.l042_pieces_jamais_declarees(p_cmd_id text) returns boolean
language sql stable security definer set search_path = public, interne, pg_catalog as $$
  select not exists (
    select 1 from public.commande_pieces q
     where q.cmd_id = p_cmd_id
       and (q.provenance is not null or q.livraison is not null or q.achat_id is not null
            or exists (select 1 from public.achats_fournisseur a where a.piece_id = q.id))) $$;
revoke all on function interne.l042_pieces_jamais_declarees(text) from public, anon, authenticated;

-- 2. Garde du « livré » (déclencheur commandes_livre_garde, inchangé) — l042 : commande NON concernée aux pièces jamais
--    déclarées → jamais bloquée. Le reste est la fonction de la 041 telle quelle.
create or replace function interne.l041_livre_garde() returns trigger
language plpgsql security definer set search_path = public, interne, pg_catalog as $$
-- l042_garde (repère lu par l'auto-contrôle de la 042 : ne pas retirer)
declare v_cycle integer; v_n integer; v_tot integer; v_role text := public.session_role(); v_conc boolean;
begin
  if coalesce(new.statut, '') not in ('livré', 'livre') or v_role is null then return new; end if;
  if tg_op = 'UPDATE' and coalesce(old.statut, '') in ('livré', 'livre') then return new; end if;
  if tg_op = 'INSERT' and exists (select 1 from public.commandes x where x.id = new.id) then return new; end if;   -- upsert : la mise à jour contrôle
  -- commande concernée ? Pour une mise à jour, elle l'est si elle l'ÉTAIT AVANT l'écriture OU si elle l'est APRÈS, quel que
  -- soit le rôle : ni le livreur ni l'administrateur ne peuvent vider le livreur ou passer en GLS dans la même écriture que le
  -- « livré » pour contourner le contrôle (il faut une dérogation, qui est journalisée) ; date de création toujours celle
  -- d'avant (041). Retirer le livreur dans une écriture SÉPARÉE, avant, reste possible : la commande devient alors non concernée.
  if tg_op = 'UPDATE' then
    v_conc := interne.l041_concernee(old.transporteur, old.livreur, old.id)
              or interne.l041_concernee(new.transporteur, new.livreur, old.id);
  else
    v_conc := interne.l041_concernee(new.transporteur, new.livreur, new.id);
  end if;
  -- 042 : NON concernée et aucune pièce déclarée (découpage fait à la simple ouverture de la fiche) → jamais bloquée
  if not v_conc and interne.l042_pieces_jamais_declarees(new.id) then return new; end if;
  select max(cycle), count(*), count(*) filter (where livraison is null) into v_cycle, v_tot, v_n from public.commande_pieces where cmd_id = new.id;
  if coalesce(v_tot, 0) = 0 then
    -- jamais découpée : non concernée → déjà acceptée plus haut ; CONCERNÉE → refusée sauf dérogation (cycle 1) — 041
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
-- déclencheur de la 041 (inchangé) : recréé à l'identique s'il manquait
do $$
begin
  if not exists (select 1 from pg_trigger t where t.tgrelid = 'public.commandes'::regclass and t.tgname = 'commandes_livre_garde' and not t.tgisinternal) then
    execute 'create trigger commandes_livre_garde before insert or update of statut on public.commandes for each row execute function interne.l041_livre_garde()';
  end if;
end $$;

-- 3. Déduction du stock : la fonction de la 041 est mise de côté telle quelle (interne.l042_deduire_041) ; l'enveloppe ci-dessous
--    choisit la 040 pour une commande non concernée aux pièces jamais déclarées. Reconnue à son texte (repère l042_enveloppe) :
--    rejouable, et de nouveau mise de côté si la 041 a été rejouée entre-temps.
do $$
declare v_src text;
begin
  select p.prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'deduire_stock_livraison' and pg_get_function_identity_arguments(p.oid) = 'p_cmd_id text';
  if v_src is null then raise exception 'Contrôle 042 : public.deduire_stock_livraison absente. Migration annulée.'; end if;
  if position('l042_enveloppe' in v_src) = 0 then              -- c'est la fonction de la 041 : la mettre de côté
    if position('l041_enveloppe' in v_src) = 0 then
      raise exception 'Contrôle 042 : public.deduire_stock_livraison n''est pas celle de la 041 — appliquer d''abord la 041. Migration annulée.';
    end if;
    execute 'drop function if exists interne.l042_deduire_041(text)';
    execute 'alter function public.deduire_stock_livraison(text) set schema interne';
    execute 'alter function interne.deduire_stock_livraison(text) rename to l042_deduire_041';
  end if;
end $$;
revoke all on function interne.l042_deduire_041(text) from public, anon, authenticated;

create or replace function public.deduire_stock_livraison(p_cmd_id text) returns json
language plpgsql volatile security definer set search_path = public, interne, pg_catalog as $$
-- l041_enveloppe l042_enveloppe (repères lus par la 041 et la 042 : ne pas retirer)
declare c record;
begin
  if coalesce(btrim(p_cmd_id), '') <> '' and exists (select 1 from public.commande_pieces where cmd_id = p_cmd_id) then
    perform pg_advisory_xact_lock(hashtext('l040|' || p_cmd_id));   -- même verrou que la 040 / 041 (rentrant)
    select id, transporteur, livreur into c from public.commandes where id = p_cmd_id;
    if found and not interne.l041_concernee(c.transporteur, c.livreur, c.id) and interne.l042_pieces_jamais_declarees(p_cmd_id) then
      return interne.l041_deduire_040(p_cmd_id);   -- non concernée, pièces jamais déclarées : déduction de la 040 (lignes)
    end if;
  end if;
  return interne.l042_deduire_041(p_cmd_id);       -- tous les autres cas : la 041, inchangée
end $$;
revoke all on function public.deduire_stock_livraison(text) from public, anon, authenticated;
grant execute on function public.deduire_stock_livraison(text) to anon;   -- session vérifiée DANS les fonctions appelées

-- 4. Lecture SANS création des pièces d'une commande (avis chatgpt-review sur adf71bb, point 5) : pour une commande DÉJÀ livrée,
--    l'appli ne demande plus drop_pieces (qui découpe la commande quand elle n'a pas de pièces, ou la redécoupe) ; elle lit
--    seulement les pièces DÉJÀ déclarées, par exemple sur un autre appareil. Mêmes droits et même réponse que drop_pieces
--    (session, commande visible par la session, pièces au même format) ; aucune ligne créée, modifiée ni supprimée, aucun journal.
create or replace function public.drop_pieces_lire(p_cmd_id text) returns json
language plpgsql stable security definer set search_path = public, interne, pg_catalog as $$
-- l042_lecture (repère lu par l'auto-contrôle de la 042 : ne pas retirer)
declare c record; v_emp text;
begin
  if public.session_role() is null or public.session_role() not in ('admin', 'collab', 'livreur') then
    return json_build_object('ok', false, 'erreur', 'session_requise'); end if;
  if not interne.l041_cmd_autorisee(p_cmd_id, true) then return json_build_object('ok', false, 'erreur', 'commande_introuvable'); end if;
  select id, lignes, produit, qte into c from public.commandes where id = p_cmd_id;
  v_emp := interne.l041_empreinte(c.lignes, c.produit, c.qte);
  return json_build_object('ok', true, 'cmd_id', c.id, 'lecture_seule', true,
    'perime', exists (select 1 from public.commande_pieces where cmd_id = c.id and empreinte <> v_emp),
    'tva_pct', interne.l041_tva(),
    'derogation', exists (select 1 from public.drop_derogations d where d.cmd_id = c.id
                            and d.cycle = (select max(q.cycle) from public.commande_pieces q where q.cmd_id = c.id)),
    'pieces', coalesce((select json_agg(interne.l041_piece_json(p.id) order by p.ligne_idx, p.piece_idx)
                          from public.commande_pieces p where p.cmd_id = c.id), '[]'::json));
end $$;
revoke all on function public.drop_pieces_lire(text) from public, anon, authenticated;
grant execute on function public.drop_pieces_lire(text) to anon;   -- session vérifiée DANS la fonction

-- 5. Auto-contrôle (rien n'est écrit) : fonctions en place, repères présents, déclencheur branché sur la bonne fonction
do $$
declare f text := null;
begin
  if to_regprocedure('public.drop_pieces_lire(text)') is null
     or position('l042_lecture' in (select prosrc from pg_proc where oid = 'public.drop_pieces_lire(text)'::regprocedure)) = 0
     or position('insert' in lower((select prosrc from pg_proc where oid = 'public.drop_pieces_lire(text)'::regprocedure))) > 0
     or position('delete' in lower((select prosrc from pg_proc where oid = 'public.drop_pieces_lire(text)'::regprocedure))) > 0 then
    f := 'lecture des pièces sans création';
  end if;
  if f is null and position('l042_garde' in (select prosrc from pg_proc where oid = 'interne.l041_livre_garde()'::regprocedure)) = 0 then f := 'garde du livré'; end if;
  if f is null and position('l042_enveloppe' in (select prosrc from pg_proc where oid = 'public.deduire_stock_livraison(text)'::regprocedure)) = 0 then f := 'enveloppe de la déduction'; end if;
  if f is null and to_regprocedure('interne.l042_deduire_041(text)') is null then f := 'déduction de la 041 mise de côté'; end if;
  if f is null and position('l041_enveloppe' in (select prosrc from pg_proc where oid = 'interne.l042_deduire_041(text)'::regprocedure)) = 0 then f := 'déduction mise de côté = celle de la 041'; end if;
  if f is null and not exists (select 1 from pg_trigger t where t.tgrelid = 'public.commandes'::regclass and t.tgname = 'commandes_livre_garde'
                                 and t.tgfoid = 'interne.l041_livre_garde()'::regprocedure) then f := 'déclencheur commandes_livre_garde'; end if;
  if f is null and not interne.l042_pieces_jamais_declarees('#042-AUTO-CONTROLE-INEXISTANTE') then f := 'commande sans pièces = jamais déclarées'; end if;
  if f is null and interne.l041_concernee('GLS', 'Livreur', '#042-AUTO-CONTROLE-INEXISTANTE') then f := 'GLS non concernée'; end if;
  if f is null and interne.l041_concernee('RANOU', '', '#042-AUTO-CONTROLE-INEXISTANTE') then f := 'sans livreur non concernée'; end if;
  if f is null and not interne.l041_concernee('', 'Livreur', '#042-AUTO-CONTROLE-INEXISTANTE') then f := 'RANOU avec livreur concernée'; end if;
  if f is not null then raise exception 'Auto-contrôle 042 en échec : « % ». Migration annulée.', f; end if;
end $$;

commit;
