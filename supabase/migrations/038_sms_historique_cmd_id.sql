-- Migration 038 (22/11/2026) : l'historique SMS retient la COMMANDE d'un envoi JARVIS (revue Codex #20)
-- Problème : l'avertissement « vérifie l'historique SMS de la commande » ne permettait pas d'identifier l'envoi parmi plusieurs commandes du même client (même téléphone).
-- Colonne facultative (NULL pour tout l'existant et pour les envois sans commande) ; aucune donnée client ajoutée (numéro de commande seulement).
alter table public.sms_historique add column if not exists cmd_id text;
create index if not exists sms_historique_cmd_id on public.sms_historique (cmd_id);
