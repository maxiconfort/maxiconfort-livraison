-- 023 (28/09/2026) : exclusion Klaviyo IMMÉDIATE des clients en SAV/litige.
-- Chaque changement utile d'une commande (litige, note, statut, e-mail, téléphone,
-- état de livraison GLS) appelle la fonction klaviyo-exclusion en arrière-plan
-- (pg_net, sans ralentir l'app). Réconciliation complète toutes les 15 min en filet
-- de sécurité, avec suspension des relances après 2 échecs consécutifs.

create table if not exists public.klaviyo_sync_etat (
  id int primary key default 1 check (id = 1),
  echecs_consecutifs int not null default 0,
  flows_suspendus text[] not null default '{}',
  dernier_ok timestamptz,
  derniere_erreur text,
  maj_at timestamptz not null default now()
);
alter table public.klaviyo_sync_etat enable row level security;
alter table public.klaviyo_sync_etat force row level security;
revoke all on table public.klaviyo_sync_etat from anon, authenticated, public;
insert into public.klaviyo_sync_etat (id) values (1) on conflict do nothing;

create or replace function interne._klaviyo_exclusion_commande()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if tg_op = 'INSERT'
     or new.litige_type is distinct from old.litige_type
     or new.litige_statut is distinct from old.litige_statut
     or new.instr is distinct from old.instr
     or new.statut is distinct from old.statut
     or new.email is distinct from old.email
     or new.tel is distinct from old.tel
     or new.gls_livraison_etat is distinct from old.gls_livraison_etat then
    perform interne.appel_fonction('klaviyo-exclusion', jsonb_build_object('cmdId', new.id), 5000);
  end if;
  return null;
end $$;

drop trigger if exists klaviyo_exclusion on public.commandes;
create trigger klaviyo_exclusion after insert or update on public.commandes
  for each row execute function interne._klaviyo_exclusion_commande();

create or replace function interne._klaviyo_exclusion_remboursement()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform interne.appel_fonction('klaviyo-exclusion', '{"reconcile":true}'::jsonb, 5000);
  return null;
end $$;

drop trigger if exists klaviyo_exclusion_remb on public.remboursements_suivi;
create trigger klaviyo_exclusion_remb after insert or update or delete on public.remboursements_suivi
  for each statement execute function interne._klaviyo_exclusion_remboursement();

select cron.schedule('klaviyo-exclusion-reconcile', '*/15 * * * *',
  $$select interne.appel_fonction('klaviyo-exclusion', '{"reconcile":true}'::jsonb, 150000);$$);
