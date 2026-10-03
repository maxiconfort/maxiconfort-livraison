-- 029 (03/10/2026) : PAIEMENT — « Payé » en espèces ou par carte AVANT la livraison : administrateur + motif.
-- Constat du 03/10/2026 : une commande Leboncoin à livrer le lendemain était notée « Espèces / Payé »
-- avec 0 € encaissé, parce que la fiche laissait choisir « Payé » sans montant ni preuve.
-- Règle (décision de Borhen du 03/10/2026) : depuis le bureau, une commande NON LIVRÉE ne peut
-- passer « Payé » ou « Partiel » en Espèces / CB / Mixte que par l'action administrateur
-- public.modifier_paiement (motif obligatoire, noté au journal financier).
-- Une écriture ordinaire qui le tente : le paiement n'est PAS enregistré (valeurs précédentes
-- conservées, « Non payé » à la création), la tentative est notée au journal ; le reste de
-- l'écriture (adresse, produits, date…) est conservé.
-- Non concernés : sessions livreur (l'encaissement à la livraison garde ses règles 027/028),
-- commandes livrées, commandes payées en ligne, modes Virement / Déjà payé / plateformes,
-- fiches à 0 € et remboursements SAV (montant négatif), programmes serveur.
-- Aucune donnée existante n'est modifiée par cette migration.

create or replace function public._paiement_verrou() returns trigger
language plpgsql security definer set search_path = public, interne, pg_catalog as $$
declare fin_ok boolean := coalesce(current_setting('app.fin_ok', true), '') = '1';
        manque text;
        role_s text := public.session_role();
        bureau boolean;
begin
  bureau := role_s is not null and role_s <> 'livreur';
  if tg_op = 'INSERT' then
    -- la base classe TOUJOURS elle-même la commande : une valeur fournie par l'appelant est ignorée
    new.payment_source := interne._payment_source_derive(new.origine, new.ref_marketplace, new.stpaie, new.instr);
    if role_s is not null then new.payment_transactions := null; end if;
    -- (c) création depuis le bureau : pas de « Payé » en espèces / carte sur une commande non livrée
    if not fin_ok and bureau and new.payment_source is distinct from 'SHOPIFY_ONLINE'
       and new.paie in ('Espèces', 'CB', 'Mixte') and new.stpaie in ('Payé', 'Partiel')
       and coalesce(new.statut, '') <> 'livré' and coalesce(new.prix, 0) > 0 and coalesce(new.montant_enc, 0) >= 0 then
      insert into public.journal_financier (cmd_id, action, ancien, nouveau, montant, reste_du, utilisateur, origine_action, motif)
      values (new.id, 'tentative_bloquee', null,
        jsonb_build_object('paie', new.paie, 'stpaie', new.stpaie, 'montant_enc', new.montant_enc),
        0, coalesce(new.prix, 0), interne._acteur_paiement(), 'application',
        'Paiement en espèces ou par carte noté avant la livraison : réservé à l''action administrateur avec motif. Commande créée « Non payé ».');
      new.stpaie := 'Non payé'; new.montant_enc := 0;
      new.ticket_cb := null; new.encaisse_par := null; new.encaisse_at := null; new.encaisse_tournee := null;
    end if;
    return new;
  end if;
  if fin_ok then return new; end if;
  if old.payment_source is not null then
    new.payment_source := old.payment_source;
  else
    new.payment_source := interne._payment_source_derive(new.origine, new.ref_marketplace, new.stpaie, new.instr);
  end if;
  if old.payment_transactions is not null or role_s is not null then
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
        case when role_s is null then 'serveur' else 'application' end,
        'Commande payée en ligne : paiement non modifiable par une sauvegarde ordinaire');
      new.paie := old.paie; new.stpaie := old.stpaie; new.montant_enc := old.montant_enc;
    end if;
    new.ticket_cb := old.ticket_cb; new.encaisse_par := old.encaisse_par; new.encaisse_at := old.encaisse_at; new.encaisse_tournee := old.encaisse_tournee;
    return new;
  end if;

  -- (c) depuis le bureau : pas de « Payé » en espèces / carte sur une commande non livrée
  if bureau and new.paie in ('Espèces', 'CB', 'Mixte') and new.stpaie in ('Payé', 'Partiel')
     and coalesce(new.statut, '') <> 'livré' and coalesce(new.prix, 0) > 0 and coalesce(new.montant_enc, 0) >= 0
     and (new.paie is distinct from old.paie or new.stpaie is distinct from old.stpaie
          or coalesce(new.montant_enc, 0) is distinct from coalesce(old.montant_enc, 0)) then
    insert into public.journal_financier (cmd_id, action, ancien, nouveau, montant, reste_du, utilisateur, origine_action, motif)
    values (old.id, 'tentative_bloquee',
      jsonb_build_object('paie', old.paie, 'stpaie', old.stpaie, 'montant_enc', old.montant_enc),
      jsonb_build_object('paie', new.paie, 'stpaie', new.stpaie, 'montant_enc', new.montant_enc),
      old.montant_enc,
      case when old.stpaie = 'Payé' then 0 else greatest(0, coalesce(new.prix, 0) - coalesce(old.montant_enc, 0)) end,
      interne._acteur_paiement(), 'application',
      'Paiement en espèces ou par carte noté avant la livraison : réservé à l''action administrateur avec motif. Paiement non enregistré.');
    new.paie := old.paie; new.stpaie := old.stpaie; new.montant_enc := old.montant_enc;
    new.ticket_cb := old.ticket_cb; new.encaisse_par := old.encaisse_par; new.encaisse_at := old.encaisse_at; new.encaisse_tournee := old.encaisse_tournee;
    return new;
  end if;

  -- (b) encaissement par carte à la livraison : preuve obligatoire
  --     « à la livraison » = écriture faite par une session livreur, ou commande livrée.
  if new.paie in ('CB', 'Mixte') and new.stpaie in ('Payé', 'Partiel')
     and (new.paie is distinct from old.paie or new.stpaie is distinct from old.stpaie
          or coalesce(new.montant_enc, 0) is distinct from coalesce(old.montant_enc, 0))
     and (role_s = 'livreur' or new.statut = 'livré') then
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
        case when role_s is null then 'serveur' else 'application' end,
        'Encaissement par carte refusé : il manque ' || manque || '. Paiement non enregistré.');
      new.paie := old.paie; new.stpaie := old.stpaie; new.montant_enc := old.montant_enc;
      new.ticket_cb := old.ticket_cb; new.encaisse_par := old.encaisse_par; new.encaisse_at := old.encaisse_at; new.encaisse_tournee := old.encaisse_tournee;
      perform interne.appel_fonction('paiement-suivi', jsonb_build_object('action', 'alerte_cb_refuse', 'cmdId', old.id, 'manque', manque), 8000);
    end if;
  end if;
  return new;
end $$;
