-- Migration 037 (22/11/2026) : « un client n'est prévenu qu'UNE fois par jour » — réservation ATOMIQUE, tous canaux
-- Problème : le SMS « veille » (cron) et le SMS « prévenir les clients de demain » (JARVIS) lisaient l'historique PUIS envoyaient : entre la lecture et
-- l'envoi, l'autre canal pouvait partir (doublon). La réservation ci-dessous est une insertion unique (clé primaire) : le premier qui réserve envoie,
-- l'autre est refusé. Le SMS qui échoue libère sa réservation (le client reste atteignable).
-- Table interne : RLS active SANS politique (seules les fonctions serveur y accèdent). Aucune donnée client (numéro de commande, jour, canal).

create table if not exists public.sms_prevenir_jour (
  cmd_id   text        not null,
  jour     date        not null,
  canal    text        not null check (canal in ('veille', 'jarvis')),
  cree_at  timestamptz not null default now(),
  primary key (cmd_id, jour)
);
alter table public.sms_prevenir_jour enable row level security;
revoke all on table public.sms_prevenir_jour from public, anon, authenticated;

-- Réserve (cmd, jour) pour un canal. Retourne {reserve:true} ou {reserve:false, canal:<canal qui l'a déjà>}.
create or replace function public.reserver_prevenir(p_cmd text, p_jour date, p_canal text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_catalog as $$
declare v_canal text;
begin
  if p_cmd is null or length(p_cmd) = 0 or p_jour is null or p_canal not in ('veille', 'jarvis') then
    raise exception 'parametres invalides';
  end if;
  insert into public.sms_prevenir_jour (cmd_id, jour, canal) values (p_cmd, p_jour, p_canal) on conflict (cmd_id, jour) do nothing;
  if found then return jsonb_build_object('reserve', true); end if;
  select canal into v_canal from public.sms_prevenir_jour where cmd_id = p_cmd and jour = p_jour;
  return jsonb_build_object('reserve', false, 'canal', v_canal);
end $$;

-- Libère la réservation SEULEMENT si elle appartient au même canal (un envoi échoué ne libère jamais celle d'un autre).
create or replace function public.liberer_prevenir(p_cmd text, p_jour date, p_canal text)
returns boolean language plpgsql volatile security definer set search_path = public, pg_catalog as $$
declare n integer;
begin
  delete from public.sms_prevenir_jour where cmd_id = p_cmd and jour = p_jour and canal = p_canal;
  get diagnostics n = row_count;
  return n > 0;
end $$;

revoke all on function public.reserver_prevenir(text, date, text) from public, anon, authenticated;
revoke all on function public.liberer_prevenir(text, date, text) from public, anon, authenticated;
grant execute on function public.reserver_prevenir(text, date, text) to service_role;
grant execute on function public.liberer_prevenir(text, date, text) to service_role;
-- Nettoyage : les réservations de plus de 7 jours ne servent plus (à lancer à la main ou par cron) :
--   delete from public.sms_prevenir_jour where jour < current_date - 7;
