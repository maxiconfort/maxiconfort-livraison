// Test RÉEL du motif d'annulation côté base (migration 030), sur des commandes de TEST dédiées uniquement.
// Usage : node outils/test-annulation-base.js
// Il lit le fichier .env local (clé serveur + jeton d'administration, jamais affichés) et n'écrit que dans les lignes
// « #TEST-ANNULATION » (fictive, Leboncoin) et « #TEST-PAIEMENT » (fictive, payée en ligne), laissées « annulé » à la fin.
// Le journal des annulations étant en ajout seul, chaque passage y ajoute des lignes « #TEST… » (à exclure des bilans).
const fs = require('fs'), path = require('path');
const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8'); const val = k => (env.match(new RegExp(k + '\\s*=\\s*"?([^\\s"]+)')) || [])[1];
const SBU = val('SUPABASE_URL'), SBK = val('SUPABASE_SERVICE_ROLE_KEY'), PAT = val('SUPABASE_ACCESS_TOKEN'), PUB = val('SUPABASE_PUBLISHABLE_KEY');
const H = { apikey: SBK, Authorization: 'Bearer ' + SBK, 'User-Agent': 'maxiconfort-claude/1.0', 'Content-Type': 'application/json' };
const rest = async (method, p, body, prefer, headers) => { const r = await fetch(SBU + '/rest/v1/' + p, { method, headers: Object.assign({}, headers || H, prefer ? { Prefer: prefer } : {}), body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {} return { status: r.status, json: j, texte: t }; };
const sql = async q => { const r = await fetch('https://api.supabase.com/v1/projects/jmvfjtnmebstkzcfnlgp/database/query', { method: 'POST', headers: { Authorization: 'Bearer ' + PAT, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {} return { ok: r.ok, json: j, texte: t }; };
const lire = async id => (await rest('GET', 'commandes?select=id,statut,paie,stpaie,montant_enc,payment_source,annulation_motif,annulation_commentaire,annulation_par,annulation_at&id=eq.' + encodeURIComponent(id))).json[0];
const journal = async id => (await rest('GET', 'journal_annulations?select=*&cmd_id=eq.' + encodeURIComponent(id) + '&order=id.asc')).json;
let ok = 0, ko = 0; const test = (nom, cond, det) => { if (cond) { ok++; console.log('  OK    ' + nom); } else { ko++; console.log('  ÉCHEC ' + nom + (det ? ' — ' + (typeof det === 'string' ? det : JSON.stringify(det)) : '')); } };
const T = '#TEST-ANNULATION', A = '#TEST-PAIEMENT', E = encodeURIComponent, fin = l => [l.paie, l.stpaie, Number(l.montant_enc || 0)].join(' / ');
const fiche = plus => Object.assign({ id: T, client: 'TEST MOTIF ANNULATION (ne pas livrer)', tel: '', email: '', adresse: 'ADRESSE DE TEST 75000 Paris', produit: 'TEST', qte: 1, prix: 1, prix_brut: 1, livreur: 'TESTLIVREUR', statut: 'en-attente', date_livraison: '', transporteur: 'RANOU', paie: 'Espèces', stpaie: 'Non payé', montant_enc: 0, instr: 'Ligne technique, à ignorer.', origine: 'LeBonCoin', ref_marketplace: '' }, plus);
const majStatut = (st, plus) => rest('PATCH', 'commandes?id=eq.' + E(T), Object.assign({ statut: st }, plus || {}));
// Écriture faite avec une SESSION simulée (créée, utilisée et supprimée dans la même opération de la base ; le jeton n'en sort jamais).
const session = (ecriture, roleS, livreur) => sql(`do $$ declare tk text := encode(extensions.gen_random_bytes(32), 'hex'); begin
    insert into public.sessions_app (jeton_hash, role, livreur, expire_at, appareil) values (encode(extensions.digest(tk, 'sha256'), 'hex'), '${roleS}', ${livreur ? "'" + livreur + "'" : 'null'}, now() + interval '2 minutes', 'test-automatique');
    perform set_config('request.headers', json_build_object('x-app-secret', (select valeur from public.secrets_serveur where cle = 'app_secret_courant'), 'x-session-token', tk)::text, true);
    ${ecriture};
    perform set_config('request.headers', '', true);
    delete from public.sessions_app where appareil = 'test-automatique';
  end $$`);

(async () => {
  const avant = await sql("select count(*)::int n from public.commandes where statut = 'annulé' and annulation_motif is not null and id not like '#TEST%'");
  await rest('POST', 'commandes', fiche(), 'resolution=merge-duplicates,return=minimal'); await majStatut('en-attente');
  let c = await lire(T), j0 = (await journal(T)).length, j, r;

  console.log('\n1. ANNULATION AVEC MOTIF');
  test('commande en cours : aucune information d\'annulation', c.statut === 'en-attente' && c.annulation_motif === null && c.annulation_at === null, c);
  r = await majStatut('annulé', { annulation_motif: 'Client injoignable' }); c = await lire(T); j = await journal(T);
  test('l\'annulation fonctionne toujours', r.status < 300 && c.statut === 'annulé', r.texte.slice(0, 200));
  test('motif, personne, date et heure enregistrés sur la commande', c.annulation_motif === 'Client injoignable' && c.annulation_par === 'serveur' && !!c.annulation_at, c);
  const l = j[j.length - 1] || {};
  test('une ligne (une seule) ajoutée au journal des annulations', j.length === j0 + 1, j.length - j0);
  test('la ligne porte numéro, canal, produit, montant, zone, motif, personne', l.cmd_id === T && l.origine === 'LeBonCoin' && l.produit === 'TEST' && Number(l.montant) === 1 && l.zone === 'Île-de-France' && l.motif === 'Client injoignable' && l.enregistre_par === 'serveur' && l.statut_avant === 'en-attente', l);

  console.log('\n2. UNE ANNULATION ENREGISTRÉE NE SE RÉÉCRIT PAS');
  await rest('PATCH', 'commandes?id=eq.' + E(T), { annulation_motif: 'Rupture de stock', annulation_commentaire: 'x', annulation_par: 'quelqu un', instr: 'Ligne technique, à ignorer. (modifiée)' }); c = await lire(T);
  test('changer le motif d\'une commande déjà annulée : sans effet', c.annulation_motif === 'Client injoignable' && c.annulation_commentaire === null && c.annulation_par === 'serveur', c);
  test('aucune nouvelle ligne au journal', (await journal(T)).length === j0 + 1);
  r = await sql(`update public.journal_annulations set motif = 'x' where cmd_id = '${T}'`); test('modifier le journal : refusé par la base', !r.ok && /ajout seul/.test(r.texte), r.texte.slice(0, 160));
  r = await sql(`delete from public.journal_annulations where cmd_id = '${T}'`); test('supprimer une ligne du journal : refusé par la base', !r.ok && /ajout seul/.test(r.texte), r.texte.slice(0, 160));

  console.log('\n3. REMISE EN COURS, PUIS NOUVELLE ANNULATION');
  await majStatut('en-attente'); c = await lire(T);
  test('commande remise « en attente » : la fiche repart sans motif', c.annulation_motif === null && c.annulation_par === null && c.annulation_at === null, c);
  test('le journal garde la trace de l\'annulation passée', (await journal(T)).length === j0 + 1);
  await rest('PATCH', 'commandes?id=eq.' + E(T), { annulation_motif: 'Délai trop long' }); c = await lire(T);
  test('un motif envoyé sur une commande NON annulée est ignoré', c.annulation_motif === null, c);
  await majStatut('annulé'); c = await lire(T); j = await journal(T);
  test('annulation SANS motif (ancienne version, programme) : acceptée et notée « Non renseigné »', c.statut === 'annulé' && c.annulation_motif === 'Non renseigné' && j.length === j0 + 2 && j[j.length - 1].motif === 'Non renseigné', c);
  await majStatut('en-attente');
  await majStatut('annulé', { annulation_motif: 'Autre', annulation_commentaire: '  client parti en vacances  ' }); c = await lire(T);
  test('motif « Autre » : le commentaire est conservé', c.annulation_motif === 'Autre' && c.annulation_commentaire === 'client parti en vacances', c);

  console.log('\n4. ENREGISTREMENT COMPLET DE LA FICHE, COMME LE FAIT L\'APPLICATION');
  await majStatut('en-attente'); const n4 = (await journal(T)).length;
  r = await rest('POST', 'commandes', fiche({ statut: 'annulé', annulation_motif: 'Rupture de stock', annulation_commentaire: null }), 'resolution=merge-duplicates,return=minimal'); c = await lire(T); j = await journal(T);
  test('fiche enregistrée avec statut « annulé » + motif : motif posé', r.status < 300 && c.annulation_motif === 'Rupture de stock', r.texte.slice(0, 200));
  test('une seule ligne de journal pour cet enregistrement', j.length === n4 + 1, j.length - n4);
  r = await rest('POST', 'commandes', fiche({ statut: 'annulé' }), 'resolution=merge-duplicates,return=minimal'); c = await lire(T);
  test('ré-enregistrer la fiche d\'une commande annulée (sans motif dans l\'envoi) : le motif reste', c.annulation_motif === 'Rupture de stock' && (await journal(T)).length === n4 + 1, c);

  console.log('\n5. PERSONNE AYANT ENREGISTRÉ L\'ANNULATION (sessions simulées)');
  for (const [roleS, liv, attendu] of [['collab', null, 'collab'], ['admin', null, 'admin'], ['livreur', 'TESTLIVREUR', 'livreur:TESTLIVREUR']]) {
    await majStatut('en-attente');
    r = await session(`update public.commandes set statut = 'annulé', annulation_motif = 'Client a changé d''avis' where id = '${T}'`, roleS, liv); c = await lire(T); j = await journal(T);
    test(`annulation par une session « ${roleS} » : enregistrée au nom de « ${attendu} », depuis l'application`, r.ok && c.annulation_par === attendu && j[j.length - 1].enregistre_par === attendu && j[j.length - 1].origine_action === 'application', r.ok ? c.annulation_par : r.texte.slice(0, 200)); }

  console.log('\n6. PAIEMENT : UNE COMMANDE PAYÉE EN LIGNE GARDE SON PAIEMENT QUAND ON L\'ANNULE');
  let a = await lire(A);
  if (!a) test('ligne de test « #TEST-PAIEMENT » présente (lancer d\'abord node outils/test-paiement-base.js)', false);
  else { const pai0 = fin(a), src0 = a.payment_source;
    await rest('PATCH', 'commandes?id=eq.' + E(A), { statut: 'en-attente' });
    await rest('PATCH', 'commandes?id=eq.' + E(A), { statut: 'annulé', annulation_motif: 'Doublon / erreur de commande', paie: 'Espèces', stpaie: 'Non payé', montant_enc: 0 }); a = await lire(A);
    test('annulée avec motif', a.statut === 'annulé' && a.annulation_motif === 'Doublon / erreur de commande', a);
    test('mode, statut et montant payé inchangés (' + pai0 + '), origine du paiement inchangée', fin(a) === pai0 && a.payment_source === src0, fin(a) + ' / ' + a.payment_source); }

  console.log('\n7. ACCÈS');
  if (PUB) { r = await rest('GET', 'journal_annulations?select=id&limit=5', null, null, { apikey: PUB, Authorization: 'Bearer ' + PUB });
    test('journal illisible depuis un navigateur sans session', r.status >= 400 || (Array.isArray(r.json) && r.json.length === 0), r.texte.slice(0, 120)); }
  const apres = await sql("select count(*)::int n from public.commandes where statut = 'annulé' and annulation_motif is not null and id not like '#TEST%'");
  test('aucune annulation réelle n\'a été touchée par ces tests', avant.ok && apres.ok && avant.json[0].n === apres.json[0].n, [avant.json, apres.json]);
  await rest('PATCH', 'commandes?id=eq.' + E(T), { statut: 'annulé' });
  const reste = await sql("select (select count(*) from public.sessions_app where appareil = 'test-automatique')::int as sessions, (select statut from public.commandes where id = '#TEST-ANNULATION') as statut");
  test('aucune session de test ne reste ; la ligne de test est laissée « annulé »', reste.ok && reste.json[0].sessions === 0 && reste.json[0].statut === 'annulé', reste.json);

  console.log(`\nRésultat : ${ok} tests réussis, ${ko} échec(s)`); process.exitCode = ko ? 1 : 0;
})().catch(e => { console.error('ERREUR :', e.message); process.exit(1); });
