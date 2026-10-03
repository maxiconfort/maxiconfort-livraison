-- 028 (03/10/2026) : PAIEMENT — encaissement par carte à la livraison : preuve obligatoire CÔTÉ BASE.
-- Jusqu'ici le ticket CB était exigé par l'application (v7.5.114) mais pas par la base : une
-- ancienne version en cache pouvait encore enregistrer « CB / Payé » sans référence.
-- Règle (demande de Borhen du 03/10/2026) : un encaissement par carte à la livraison n'est
-- enregistré QUE s'il porte : référence du ticket, montant, livreur, date et heure.
-- Sinon : le paiement N'EST PAS enregistré (la commande garde son statut de paiement
-- précédent, donc reste « Non payé »), la tentative est notée au journal financier et une
-- alerte est envoyée. Le reste de l'écriture (statut de livraison, signature…) est conservé :
-- aucune livraison n'est perdue, aucune validation silencieuse n'est possible.
-- Procédure exceptionnelle : l'action administrateur public.modifier_paiement (motif obligatoire).
-- Aucune donnée existante n'est modifiée par cette migration.

alter table public.commandes add column if not exists encaisse_tournee text;   -- tournée de l'encaissement, si connue

create or replace function public._paiement_verrou() returns trigger
language plpgsql security definer set search_path = public, interne, pg_catalog as $$
declare fin_ok boolean := coalesce(current_setting('app.fin_ok', true), '') = '1';
        manque text;
begin
  if tg_op = 'INSERT' then
    -- la base classe TOUJOURS elle-même la commande : une valeur fournie par l'appelant est ignorée
    new.payment_source := interne._payment_source_derive(new.origine, new.ref_marketplace, new.stpaie, new.instr);
    if public.session_role() is not null then new.payment_transactions := null; end if;
    return new;
  end if;
  if fin_ok then return new; end if;
  if old.payment_source is not null then
    new.payment_source := old.payment_source;
  else
    new.payment_source := interne._payment_source_derive(new.origine, new.ref_marketplace, new.stpaie, new.instr);
  end if;
  if old.payment_transactions is not null or public.session_role() is not null then
    new.payment_transactions := old.payment_transactions;
  end if;

  -- (a) commande payée en ligne : paiement non modifiable par une écriture ordinaire
  if old.payment_source = 'SHOPIFY_ONLINE' then
    if new.paie is distinct from old.paie or new.stpaie is distinct from old.stpaie
       or coalesce(new.montant_enc, 0) is distinct from coalesce(old.montant_enc, 0) then
      insert into public.journal_financier (cmd_id, action, ancien, nouveau, montant, reste_du, utilisateur, origine_action, motif)
      values (old.id, 'tentative_bloquee',
        jsonb_build_object('paie', old.paie, 'stpaie', old.stpaie, 'montant_enc', old.montant_enc),
        jsonb_build_object('paie', new.paie, 'stpaie', new.stpaie, 'montant_enc', new.montant_enc),
        old.montant_enc, 0, interne._acteur_paiement(),
        case when public.session_role() is null then 'serveur' else 'application' end,
        'Commande payée en ligne : paiement non modifiable par une sauvegarde ordinaire');
      new.paie := old.paie; new.stpaie := old.stpaie; new.montant_enc := old.montant_enc;
    end if;
    new.ticket_cb := old.ticket_cb; new.encaisse_par := old.encaisse_par; new.encaisse_at := old.encaisse_at; new.encaisse_tournee := old.encaisse_tournee;
    return new;
  end if;

  -- (b) encaissement par carte à la livraison : preuve obligatoire
  --     « à la livraison » = écriture faite par une session livreur, ou commande livrée.
  if new.paie in ('CB', 'Mixte') and new.stpaie in ('Payé', 'Partiel')
     and (new.paie is distinct from old.paie or new.stpaie is distinct from old.stpaie
          or coalesce(new.montant_enc, 0) is distinct from coalesce(old.montant_enc, 0))
     and (public.session_role() = 'livreur' or new.statut = 'livré') then
    manque := concat_ws(', ',
      case when coalesce(btrim(new.ticket_cb), '') = '' then 'référence du ticket' end,
      case when coalesce(new.montant_enc, 0) <= 0 then 'montant' end,
      case when coalesce(btrim(new.encaisse_par), '') = '' then 'livreur' end,
      case when new.encaisse_at is null then 'date et heure' end);
    if manque <> '' then
      insert into public.journal_financier (cmd_id, action, ancien, nouveau, montant, reste_du, utilisateur, origine_action, motif)
      values (old.id, 'tentative_bloquee',
        jsonb_build_object('paie', old.paie, 'stpaie', old.stpaie, 'montant_enc', old.montant_enc),
        jsonb_build_object('paie', new.paie, 'stpaie', new.stpaie, 'montant_enc', new.montant_enc, 'ticket_cb', new.ticket_cb, 'encaisse_par', new.encaisse_par),
        old.montant_enc,
        case when old.stpaie = 'Payé' then 0 else greatest(0, coalesce(new.prix, 0) - coalesce(old.montant_enc, 0)) end,
        interne._acteur_paiement(),
        case when public.session_role() is null then 'serveur' else 'application' end,
        'Encaissement par carte refusé : il manque ' || manque || '. Paiement non enregistré.');
      new.paie := old.paie; new.stpaie := old.stpaie; new.montant_enc := old.montant_enc;
      new.ticket_cb := old.ticket_cb; new.encaisse_par := old.encaisse_par; new.encaisse_at := old.encaisse_at; new.encaisse_tournee := old.encaisse_tournee;
      perform interne.appel_fonction('paiement-suivi', jsonb_build_object('action', 'alerte_cb_refuse', 'cmdId', old.id, 'manque', manque), 8000);
    end if;
  end if;
  return new;
end $$;

-- Journal : l'instantané garde aussi le livreur et la tournée de l'encaissement (recherche dans l'écran d'historique)
create or replace function public._paiement_journal() returns trigger
language plpgsql security definer set search_path = public, interne, pg_catalog as $$
declare fin_ok boolean := coalesce(current_setting('app.fin_ok', true), '') = '1';
        du numeric;
begin
  du := case when new.stpaie = 'Payé' then 0 else greatest(0, coalesce(new.prix, 0) - coalesce(new.montant_enc, 0)) end;
  if tg_op = 'INSERT' then
    insert into public.journal_financier (cmd_id, action, ancien, nouveau, montant, reste_du, utilisateur, origine_action)
    values (new.id, 'creation', null,
      jsonb_build_object('paie', new.paie, 'stpaie', new.stpaie, 'montant_enc', new.montant_enc, 'prix', new.prix, 'payment_source', new.payment_source, 'livreur', new.livreur),
      new.montant_enc, du, interne._acteur_paiement(),
      case when public.session_role() is null then 'serveur' else 'application' end);
    return null;
  end if;
  if new.paie is distinct from old.paie or new.stpaie is distinct from old.stpaie
     or coalesce(new.montant_enc, 0) is distinct from coalesce(old.montant_enc, 0)
     or coalesce(new.prix, 0) is distinct from coalesce(old.prix, 0)
     or new.payment_source is distinct from old.payment_source
     or new.ticket_cb is distinct from old.ticket_cb then
    insert into public.journal_financier (cmd_id, action, ancien, nouveau, montant, reste_du, utilisateur, origine_action, motif)
    values (new.id, case when fin_ok then 'modification_admin' else 'modification' end,
      jsonb_build_object('paie', old.paie, 'stpaie', old.stpaie, 'montant_enc', old.montant_enc, 'prix', old.prix, 'payment_source', old.payment_source, 'ticket_cb', old.ticket_cb),
      jsonb_build_object('paie', new.paie, 'stpaie', new.stpaie, 'montant_enc', new.montant_enc, 'prix', new.prix, 'payment_source', new.payment_source, 'ticket_cb', new.ticket_cb,
        'encaisse_par', new.encaisse_par, 'encaisse_at', new.encaisse_at, 'encaisse_tournee', new.encaisse_tournee, 'livreur', new.livreur),
      new.montant_enc, du, interne._acteur_paiement(),
      case when fin_ok then 'action_admin' when public.session_role() is null then 'serveur' else 'application' end,
      nullif(current_setting('app.fin_motif', true), ''));
  end if;
  if new.payment_source = 'DELIVERY' and new.statut = 'livré' and coalesce(new.stpaie, '') <> 'Payé'
     and (old.statut is distinct from 'livré' or old.stpaie is distinct from new.stpaie) then
    perform interne.appel_fonction('paiement-suivi', jsonb_build_object('action', 'alerte_non_encaisse', 'cmdId', new.id), 8000);
  end if;
  return null;
end $$;

-- Procédure administrateur exceptionnelle : même action que 027, avec la référence du ticket en option.
create or replace function interne.modifier_paiement(p_cmd text, p_mode text, p_statut text, p_montant numeric, p_motif text, p_acteur text, p_ticket text default null)
returns json language plpgsql volatile security definer set search_path = public, interne, pg_catalog as $$
declare v record;
begin
  if coalesce(length(btrim(p_motif)), 0) < 5 then return json_build_object('ok', false, 'erreur', 'motif_obligatoire'); end if;
  if p_statut not in ('Payé', 'Non payé', 'Partiel') then return json_build_object('ok', false, 'erreur', 'statut_invalide'); end if;
  if coalesce(btrim(p_mode), '') = '' then return json_build_object('ok', false, 'erreur', 'mode_obligatoire'); end if;
  if p_montant is null or p_montant < 0 then return json_build_object('ok', false, 'erreur', 'montant_invalide'); end if;
  select id, paie, stpaie, montant_enc into v from public.commandes where id = p_cmd;
  if not found then return json_build_object('ok', false, 'erreur', 'commande_introuvable'); end if;
  perform set_config('app.fin_ok', '1', true);
  perform set_config('app.fin_motif', btrim(p_motif), true);
  perform set_config('app.fin_acteur', coalesce(p_acteur, 'admin'), true);
  update public.commandes set paie = p_mode, stpaie = p_statut, montant_enc = p_montant,
         ticket_cb = coalesce(nullif(btrim(p_ticket), ''), ticket_cb), updated_at = now() where id = p_cmd;
  perform set_config('app.fin_ok', '', true);
  perform set_config('app.fin_motif', '', true);
  perform set_config('app.fin_acteur', '', true);
  return json_build_object('ok', true, 'avant', json_build_object('paie', v.paie, 'stpaie', v.stpaie, 'montant_enc', v.montant_enc));
end $$;
drop function if exists interne.modifier_paiement(text, text, text, numeric, text, text);
revoke all on function interne.modifier_paiement(text, text, text, numeric, text, text, text) from public, anon, authenticated;

create or replace function public.modifier_paiement(p_cmd text, p_mode text, p_statut text, p_montant numeric, p_motif text, p_ticket text default null)
returns json language plpgsql volatile security definer set search_path = public, interne, pg_catalog as $$
begin
  if public.session_role() is distinct from 'admin' then return json_build_object('ok', false, 'erreur', 'session_admin_requise'); end if;
  return interne.modifier_paiement(p_cmd, p_mode, p_statut, p_montant, p_motif, 'admin', p_ticket);
end $$;
drop function if exists public.modifier_paiement(text, text, text, numeric, text);
revoke all on function public.modifier_paiement(text, text, text, numeric, text, text) from public, anon, authenticated;
grant execute on function public.modifier_paiement(text, text, text, numeric, text, text) to anon;
