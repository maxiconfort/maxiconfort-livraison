-- 022 (28/09/2026) : contrôles GLS v2 (enlèvement du soir, instance/blocage 48 h)
-- et suivi des remboursements dus. AUCUN paiement automatique : simple liste.

-- 1. Suivi des remboursements (initiales seulement, aucune coordonnée)
create table if not exists public.remboursements_suivi (
  id bigserial primary key,
  cmd_id text not null,             -- ex. '#1561 / site #1071'
  client_initiales text,
  montant numeric(10,2) not null,
  moyen text,                       -- Shopify (carte), PayPal, espèces, virement…
  motif text,
  preuve text,                      -- d'où vient l'obligation (rétractation, SAV, mise en demeure…)
  echeance date,                    -- date limite (14 j après rétractation / retour)
  statut text not null default 'a_faire' check (statut in ('a_faire', 'conditionnel', 'fait', 'annule')),
  fait_le date,
  reference text,                   -- référence du remboursement une fois fait
  cree_at timestamptz not null default now()
);
alter table public.remboursements_suivi enable row level security;
alter table public.remboursements_suivi force row level security;
revoke all on table public.remboursements_suivi from anon, authenticated, public;

-- Les dossiers (initiales, montants) ont ete saisis directement en base le 28/09 :
-- depot public, aucune donnee client ici.

-- 2. Crons (pg_cron en UTC : 2 horaires UTC par créneau, la fonction filtre l'heure de Paris)
select cron.schedule('alerte-gls-enlevement', '30 17,18 * * 1-5',
  $$select interne.appel_fonction('alerte-gls-sans-scan', '{"creneau":true,"controle":"enlevement"}'::jsonb, 150000);$$);
select cron.schedule('alerte-gls-instance', '0 7,8 * * 1-6',
  $$select interne.appel_fonction('alerte-gls-sans-scan', '{"creneau":true,"controle":"instance"}'::jsonb, 150000);$$);
select cron.schedule('suivi-remboursements', '30 6,7 * * 1-6',
  $$select interne.appel_fonction('alerte-gls-sans-scan', '{"creneau":true,"controle":"remboursements"}'::jsonb, 150000);$$);
