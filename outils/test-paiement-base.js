// Test RÉEL du verrou de paiement côté base (migration 027), sur des commandes de TEST dédiées uniquement.
// Usage : node outils/test-paiement-base.js
// Il lit le fichier .env local (clé serveur + jeton d'administration, jamais affichés) et n'écrit que dans
// les lignes « #TEST-PAIEMENT », « #TEST-PAIEMENT-LIV » et « #TEST-PAIEMENT-LBC », laissées « annulé » à la fin.
// Les écritures sont faites avec la clé serveur, sans session d'application : ce sont donc des
// « modifications directes », exactement ce que le verrou doit empêcher.
const fs = require('fs'), path = require('path');
const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8'); const val = k => (env.match(new RegExp(k + '\\s*=\\s*"?([^\\s"]+)')) || [])[1];
const SBU = val('SUPABASE_URL'), SBK = val('SUPABASE_SERVICE_ROLE_KEY'), PAT = val('SUPABASE_ACCESS_TOKEN'), PUB = val('SUPABASE_PUBLISHABLE_KEY');
const H = { apikey: SBK, Authorization: 'Bearer ' + SBK, 'User-Agent': 'maxiconfort-claude/1.0', 'Content-Type': 'application/json' };
const rest = async (method, p, body, prefer, headers) => { const r = await fetch(SBU + '/rest/v1/' + p, { method, headers: Object.assign({}, headers || H, prefer ? { Prefer: prefer } : {}), body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {} return { status: r.status, json: j, texte: t }; };
const sql = async q => { const r = await fetch('https://api.supabase.com/v1/projects/jmvfjtnmebstkzcfnlgp/database/query', { method: 'POST', headers: { Authorization: 'Bearer ' + PAT, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {} return { ok: r.ok, json: j, texte: t }; };
const lire = async id => (await rest('GET', 'commandes?select=id,paie,stpaie,montant_enc,prix,statut,date_livraison,livreur,adresse,instr,payment_source,payment_transactions,ticket_cb,encaisse_par,encaisse_at&id=eq.' + encodeURIComponent(id))).json[0];
const journal = async id => (await rest('GET', 'journal_financier?select=id,action,ancien,nouveau,montant,reste_du,utilisateur,origine_action,motif,cree_at&cmd_id=eq.' + encodeURIComponent(id) + '&order=id.asc')).json;
let ok = 0, ko = 0; const test = (nom, cond, det) => { if (cond) { ok++; console.log('  OK    ' + nom); } else { ko++; console.log('  ÉCHEC ' + nom + (det ? ' — ' + (typeof det === 'string' ? det : JSON.stringify(det)) : '')); } };
const fin = l => [l.paie, l.stpaie, Number(l.montant_enc || 0)].join(' / ');
const A = '#TEST-PAIEMENT', B = '#TEST-PAIEMENT-LIV', C = '#TEST-PAIEMENT-LBC';
const base = (id, plus) => Object.assign({ id, client: 'TEST CORRECTIF PAIEMENT (ne pas livrer)', tel: '', email: '', adresse: 'ADRESSE DE TEST 75000 Paris', produit: 'TEST', qte: 1, prix: 1, prix_brut: 1, livreur: '', statut: 'annulé', date_livraison: '', transporteur: 'RANOU' }, plus);

(async () => {
  // ── remise en état de départ des trois lignes de test (par l'action administrateur interne pour la ligne payée en ligne)
  await rest('POST', 'commandes', base(A, { paie: 'Site Maxiconfort', stpaie: 'Payé', montant_enc: 1, instr: 'Commande site #TEST. Ligne technique, à ignorer.', origine: 'Site Maxiconfort', ref_marketplace: '999999999901' }), 'resolution=merge-duplicates,return=minimal');
  await sql(`select interne.modifier_paiement('${A}', 'Site Maxiconfort', 'Payé', 1, 'Remise en état de la ligne de test', 'test-automatique')`);
  await rest('POST', 'commandes', base(B, { paie: 'Espèces', stpaie: 'Non payé', montant_enc: 0, instr: 'Commande site #TEST-LIV. 💵 PAIEMENT À LA LIVRAISON : 1 € à encaisser (espèces ou CB). Ligne technique, à ignorer.', origine: 'Site Maxiconfort', ref_marketplace: '999999999902', payment_source: 'SHOPIFY_ONLINE' }), 'resolution=merge-duplicates,return=minimal');
  await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(B), { paie: 'Espèces', stpaie: 'Non payé', montant_enc: 0, statut: 'annulé', ticket_cb: null, encaisse_par: null, encaisse_at: null });
  await rest('POST', 'commandes', base(C, { paie: 'Espèces', stpaie: 'Non payé', montant_enc: 0, instr: 'Ligne technique, à ignorer.', origine: 'LeBonCoin', ref_marketplace: '' }), 'resolution=merge-duplicates,return=minimal');
  await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(C), { paie: 'Espèces', stpaie: 'Non payé', montant_enc: 0, statut: 'annulé' });

  console.log('\n1. ORIGINE DU PAIEMENT POSÉE PAR LA BASE');
  let a = await lire(A), b = await lire(B), c = await lire(C);
  test('commande du site payée → SHOPIFY_ONLINE', a.payment_source === 'SHOPIFY_ONLINE', a.payment_source);
  test('commande du site en paiement à la livraison → DELIVERY (même si l\'appelant envoie « SHOPIFY_ONLINE »)', b.payment_source === 'DELIVERY', b.payment_source);
  test('commande Leboncoin → LEBONCOIN', c.payment_source === 'LEBONCOIN', c.payment_source);

  console.log('\n2. TENTATIVES DE MODIFICATION DIRECTE D\'UNE COMMANDE PAYÉE EN LIGNE (interdites par la base)');
  const nJ0 = (await journal(A)).length;
  await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(A), { paie: 'Espèces' }); a = await lire(A);
  test('passer le mode en « Espèces » : refusé, la base garde « Site Maxiconfort »', fin(a) === 'Site Maxiconfort / Payé / 1', fin(a));
  await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(A), { paie: 'CB', stpaie: 'Payé' }); a = await lire(A);
  test('passer en « CB à la livraison » : refusé', fin(a) === 'Site Maxiconfort / Payé / 1', fin(a));
  await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(A), { stpaie: 'Non payé' }); a = await lire(A);
  test('passer en « Non payé » : refusé', fin(a) === 'Site Maxiconfort / Payé / 1', fin(a));
  await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(A), { montant_enc: 0 }); a = await lire(A);
  test('remettre un montant à encaisser (montant payé à 0) : refusé', fin(a) === 'Site Maxiconfort / Payé / 1', fin(a));
  await rest('POST', 'commandes', base(A, { paie: 'Espèces', stpaie: 'Non payé', montant_enc: 0, date_livraison: '2026-12-05', statut: 'annulé', origine: 'Site Maxiconfort', ref_marketplace: '999999999901', instr: 'Commande site #TEST. Ligne technique, à ignorer.' }), 'resolution=merge-duplicates,return=minimal'); a = await lire(A);
  test('enregistrement complet façon ancienne version de l\'application (« Espèces / Non payé / 0 ») : paiement intact, la date est bien modifiée', fin(a) === 'Site Maxiconfort / Payé / 1' && a.date_livraison === '2026-12-05', fin(a) + ' ' + a.date_livraison);
  await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(A), { payment_source: 'DELIVERY' }); a = await lire(A);
  test('changer l\'origine du paiement : refusé', a.payment_source === 'SHOPIFY_ONLINE', a.payment_source);
  await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(A), { ticket_cb: '9999', encaisse_par: 'TEST', encaisse_at: new Date().toISOString() }); a = await lire(A);
  test('enregistrer un encaissement livreur (ticket CB) sur une commande payée en ligne : refusé', !a.ticket_cb && !a.encaisse_par && !a.encaisse_at, [a.ticket_cb, a.encaisse_par]);
  let j = await journal(A); const blo = j.filter(x => x.action === 'tentative_bloquee');
  test('chaque tentative est notée dans le journal (5 tentatives bloquées)', j.length - nJ0 === 5 && blo.length >= 5, j.length - nJ0);
  const d = blo[blo.length - 1];
  test('le journal donne l\'ancienne valeur, la valeur refusée, l\'auteur et l\'origine', d && d.ancien.paie === 'Site Maxiconfort' && d.nouveau.paie === 'Espèces' && d.utilisateur === 'serveur' && d.origine_action === 'serveur' && !!d.cree_at, d);

  console.log('\n3. LES MODIFICATIONS ORDINAIRES RESTENT POSSIBLES');
  await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(A), { adresse: 'NOUVELLE ADRESSE 93100 Montreuil', livreur: 'TEST-LIVREUR', statut: 'reporté', instr: 'Commande site #TEST. Commentaire modifié.' }); a = await lire(A);
  test('adresse, livreur, statut de livraison, commentaire : modifiés ; paiement intact', /Montreuil/.test(a.adresse) && a.livreur === 'TEST-LIVREUR' && a.statut === 'reporté' && /Commentaire modifié/.test(a.instr) && fin(a) === 'Site Maxiconfort / Payé / 1', a);
  test('ces modifications ordinaires ne créent aucune ligne dans le journal financier', (await journal(A)).length === j.length);

  console.log('\n4. MODIFICATION FINANCIÈRE VOLONTAIRE (ACTION ADMINISTRATEUR, MOTIF OBLIGATOIRE)');
  let r = await sql(`select interne.modifier_paiement('${A}', 'Virement', 'Payé', 1, '', 'admin(test)') as r`);
  test('sans motif : refusée', r.ok && r.json[0].r.ok === false && r.json[0].r.erreur === 'motif_obligatoire', r.texte.slice(0, 200)); a = await lire(A);
  test('sans motif : rien n\'a changé', fin(a) === 'Site Maxiconfort / Payé / 1', fin(a));
  r = await sql(`select interne.modifier_paiement('${A}', 'Virement', 'Payé', 1, 'Test : remboursement puis virement du client', 'admin(test)') as r`); a = await lire(A);
  test('avec motif : acceptée', r.ok && r.json[0].r.ok === true && fin(a) === 'Virement / Payé / 1', r.texte.slice(0, 200) + ' ' + fin(a));
  j = await journal(A); const dm = j[j.length - 1];
  test('journal : modification_admin, ancienne et nouvelle valeur, auteur, motif, date et heure', dm.action === 'modification_admin' && dm.ancien.paie === 'Site Maxiconfort' && dm.nouveau.paie === 'Virement' && dm.utilisateur === 'admin(test)' && dm.origine_action === 'action_admin' && /remboursement puis virement/.test(dm.motif) && !!dm.cree_at, dm);
  await sql(`select interne.modifier_paiement('${A}', 'Site Maxiconfort', 'Payé', 1, 'Test : retour à la valeur de départ', 'admin(test)')`); a = await lire(A);
  test('le verrou est de nouveau actif après l\'action', fin(a) === 'Site Maxiconfort / Payé / 1' && (await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(A), { paie: 'Espèces' })).status < 300 && fin(await lire(A)) === 'Site Maxiconfort / Payé / 1');
  r = await rest('POST', 'rpc/modifier_paiement', { p_cmd: A, p_mode: 'Espèces', p_statut: 'Non payé', p_montant: 0, p_motif: 'tentative sans session administrateur' });
  test('action administrateur appelée sans session administrateur (clé serveur) : refusée', r.json && r.json.ok === false && r.json.erreur === 'session_admin_requise', r.texte.slice(0, 200));
  if (PUB) { r = await rest('POST', 'rpc/modifier_paiement', { p_cmd: A, p_mode: 'Espèces', p_statut: 'Non payé', p_montant: 0, p_motif: 'tentative depuis un navigateur sans session' }, null, { apikey: PUB, Authorization: 'Bearer ' + PUB, 'Content-Type': 'application/json' });
    test('action administrateur appelée comme un navigateur sans session : refusée', (r.json && r.json.ok === false) || r.status >= 400, r.texte.slice(0, 200)); }
  test('après ces refus : paiement toujours intact', fin(await lire(A)) === 'Site Maxiconfort / Payé / 1');

  console.log('\n5. LE JOURNAL NE PEUT ÊTRE NI MODIFIÉ NI SUPPRIMÉ');
  r = await sql(`update public.journal_financier set motif = 'falsifié' where cmd_id = '${A}'`); test('modification d\'une ligne du journal : refusée par la base', !r.ok && /ajout seul/.test(r.texte), r.texte.slice(0, 160));
  r = await sql(`delete from public.journal_financier where cmd_id = '${A}'`); test('suppression d\'une ligne du journal : refusée par la base', !r.ok && /ajout seul/.test(r.texte), r.texte.slice(0, 160));
  r = await rest('DELETE', 'journal_financier?cmd_id=eq.' + encodeURIComponent(A)); test('suppression par l\'interface de programmation : refusée', r.status >= 400 || (await journal(A)).length === j.length + 1 || (await journal(A)).length >= j.length, r.status);

  console.log('\n6. PAIEMENT À LA LIVRAISON : ENCAISSEMENT, TICKET, HISTORIQUE');
  const nB0 = (await journal(B)).length;
  await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(B), { paie: 'CB', stpaie: 'Payé', montant_enc: 1, ticket_cb: '0042', encaisse_par: 'RANOU', encaisse_at: new Date().toISOString() }); b = await lire(B);
  test('encaissement CB déclaré : accepté, ticket, livreur et heure conservés', fin(b) === 'CB / Payé / 1' && b.ticket_cb === '0042' && b.encaisse_par === 'RANOU' && !!b.encaisse_at, b);
  let jb = await journal(B); let lb = jb[jb.length - 1];
  test('journal : ancienne valeur « Non payé », nouvelle « CB / Payé », ticket, reste dû 0 €', jb.length === nB0 + 1 && lb.action === 'modification' && lb.ancien.stpaie === 'Non payé' && lb.nouveau.paie === 'CB' && lb.nouveau.ticket_cb === '0042' && Number(lb.reste_du) === 0, lb);
  await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(B), { payment_source: 'SHOPIFY_ONLINE' }); b = await lire(B);
  test('l\'origine « paiement à la livraison » ne peut pas être changée en « payée en ligne »', b.payment_source === 'DELIVERY', b.payment_source);
  await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(B), { paie: 'Espèces', stpaie: 'Non payé', montant_enc: 0, ticket_cb: null, encaisse_par: null, encaisse_at: null }); b = await lire(B); jb = await journal(B); lb = jb[jb.length - 1];
  test('retour à « Non payé » : reste dû 1 € noté dans le journal', fin(b) === 'Espèces / Non payé / 0' && Number(lb.reste_du) === 1, lb);

  console.log('\n7. AUTRES ORIGINES : AUCUN VERROU, MAIS HISTORIQUE COMPLET');
  const nC0 = (await journal(C)).length;
  await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(C), { paie: 'Espèces', stpaie: 'Payé', montant_enc: 1 }); c = await lire(C);
  test('commande Leboncoin : encaissement espèces accepté comme avant', fin(c) === 'Espèces / Payé / 1', fin(c));
  test('et noté dans le journal', (await journal(C)).length === nC0 + 1);
  await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(C), { paie: 'Espèces', stpaie: 'Non payé', montant_enc: 0 });

  // ── remise au propre
  await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(A), { statut: 'annulé', livreur: '', date_livraison: '', adresse: 'ADRESSE DE TEST 75000 Paris', instr: 'Ligne technique de test du correctif paiement. Peut être supprimée.' });
  for (const id of [B, C]) await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(id), { statut: 'annulé' });
  const f = [await lire(A), await lire(B), await lire(C)];
  console.log('\nétat final des lignes de test : ' + f.map(x => `${x.id} ${fin(x)} ${x.statut} ${x.payment_source}`).join(' | '));
  console.log(`\nRÉSULTAT DU TEST DE LA BASE : ${ok} réussis, ${ko} échec(s)`); process.exitCode = ko ? 1 : 0;
})().catch(e => { console.error('ERREUR', e); process.exitCode = 2; });
