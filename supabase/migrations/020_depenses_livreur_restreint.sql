-- 020 (28/09/2026) : dépenses masquées au rôle livreur, sauf ses propres frais d'hier et d'aujourd'hui.
-- Avant : politique sess_livreur (ALL) = le livreur lisait tout l'historique de ses dépenses (145 lignes).
-- Après :
--   - lecture : uniquement SES frais datés d'hier ou d'aujourd'hui (nécessaire au récapitulatif de caisse
--     du jour et à l'enregistrement « ajout ou mise à jour » utilisé par l'app, qui exige un droit de lecture) ;
--   - ajout / correction : uniquement SES frais d'hier ou d'aujourd'hui ;
--   - aucune suppression, aucun accès aux frais des autres ni à l'historique.
-- Tests du 28/09 10:06 : ajout du jour OK, correction OK, autre livreur refusé, J-10 refusé,
-- écrasement d'un ancien frais refusé (ligne intacte), lecture = frais du jour uniquement.

drop policy if exists sess_livreur on public.depenses;

create policy sess_livreur_ajout on public.depenses for insert to anon
  with check ( (select public.session_role()) = 'livreur'
               and upper(coalesce(livreur,'')) = (select public.session_livreur())
               and date_depense::date >= (current_date - 1) );

create policy sess_livreur_maj on public.depenses for update to anon
  using      ( (select public.session_role()) = 'livreur'
               and upper(coalesce(livreur,'')) = (select public.session_livreur())
               and date_depense::date >= (current_date - 1) )
  with check ( (select public.session_role()) = 'livreur'
               and upper(coalesce(livreur,'')) = (select public.session_livreur())
               and date_depense::date >= (current_date - 1) );

create policy sess_livreur_lecture_recente on public.depenses for select to anon
  using ( (select public.session_role()) = 'livreur'
          and upper(coalesce(livreur,'')) = (select public.session_livreur())
          and date_depense::date >= (current_date - 1) );
