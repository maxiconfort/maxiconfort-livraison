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

  console.log('\n8. ENCAISSEMENT PAR CARTE À LA LIVRAISON : PREUVE OBLIGATOIRE CÔTÉ BASE (migration 028)');
  const pai = x => [x.paie, x.stpaie, Number(x.montant_enc || 0)].join(' / ');
  const dernier = async id => { const x = await journal(id); return x[x.length - 1]; };
  // a) ancienne version de l'application : enregistrement complet « livré / CB / Payé » sans aucune référence
  await rest('POST', 'commandes', base(B, { statut: 'livré', paie: 'CB', stpaie: 'Payé', montant_enc: 1, origine: 'Site Maxiconfort', ref_marketplace: '999999999902', instr: 'Commande site #TEST-LIV. 💵 PAIEMENT À LA LIVRAISON : 1 € à encaisser (espèces ou CB). Ligne technique, à ignorer.' }), 'resolution=merge-duplicates,return=minimal'); b = await lire(B); lb = await dernier(B);
  test('ancienne version (CB sans référence) : le paiement N\'EST PAS enregistré, la commande reste « Non payé »', pai(b) === 'Espèces / Non payé / 0', pai(b));
  test('la livraison, elle, est bien enregistrée (aucune livraison perdue)', b.statut === 'livré', b.statut);
  test('la tentative est notée au journal avec ce qui manque (aucune validation silencieuse)', lb.action === 'tentative_bloquee' && /référence du ticket/.test(lb.motif) && /livreur/.test(lb.motif) && /date et heure/.test(lb.motif) && Number(lb.reste_du) === 1, lb);
  await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(B), { statut: 'livré', paie: 'CB', stpaie: 'Payé', montant_enc: 1, ticket_cb: 'T-1' }); b = await lire(B); lb = await dernier(B);
  test('ticket présent mais livreur et heure absents : refusé', pai(b) === 'Espèces / Non payé / 0' && !b.ticket_cb && lb.action === 'tentative_bloquee' && /livreur/.test(lb.motif) && !/référence du ticket/.test(lb.motif), lb.motif);
  await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(B), { paie: 'CB', stpaie: 'Payé', montant_enc: 0, ticket_cb: 'T-1', encaisse_par: 'RANOU', encaisse_at: new Date().toISOString() }); b = await lire(B); lb = await dernier(B);
  test('montant absent : refusé', pai(b) === 'Espèces / Non payé / 0' && /montant/.test(lb.motif), lb.motif);
  await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(B), { paie: 'Mixte', stpaie: 'Payé', montant_enc: 1, encaisse_par: 'RANOU', encaisse_at: new Date().toISOString() }); b = await lire(B);
  test('« Espèces + CB » sans référence de ticket : refusé aussi', pai(b) === 'Espèces / Non payé / 0', pai(b));
  await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(B), { paie: 'CB', stpaie: 'Payé', montant_enc: 1, ticket_cb: 'T-7781', encaisse_par: 'RANOU', encaisse_at: new Date().toISOString(), encaisse_tournee: 'T-TEST' }); b = await lire(B); lb = await dernier(B);
  test('avec ticket, montant, livreur, date et heure : accepté', pai(b) === 'CB / Payé / 1' && b.ticket_cb === 'T-7781' && b.encaisse_par === 'RANOU' && !!b.encaisse_at, b);
  test('journal : commande → livreur → montant → ticket → tournée', lb.action === 'modification' && lb.nouveau.ticket_cb === 'T-7781' && lb.nouveau.encaisse_par === 'RANOU' && lb.nouveau.encaisse_tournee === 'T-TEST' && Number(lb.montant) === 1 && Number(lb.reste_du) === 0, lb);
  await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(B), { paie: 'Espèces', stpaie: 'Non payé', montant_enc: 0, ticket_cb: null, encaisse_par: null, encaisse_at: null, encaisse_tournee: null, statut: 'livré' });
  await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(B), { paie: 'Espèces', stpaie: 'Payé', montant_enc: 1, encaisse_par: 'RANOU', encaisse_at: new Date().toISOString() }); b = await lire(B);
  test('encaissement en ESPÈCES : aucun ticket exigé', pai(b) === 'Espèces / Payé / 1', pai(b));
  // b) autre origine (Leboncoin) : même règle dès qu'une carte est encaissée à la livraison
  await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(C), { statut: 'livré', paie: 'CB', stpaie: 'Payé', montant_enc: 1 }); c = await lire(C); let lc = await dernier(C);
  test('commande Leboncoin livrée, CB sans référence : refusé, reste « Non payé »', pai(c) === 'Espèces / Non payé / 0' && c.statut === 'livré' && lc.action === 'tentative_bloquee', pai(c));
  // c) procédure administrateur exceptionnelle : motif obligatoire, journalisée
  r = await sql(`select interne.modifier_paiement('${C}', 'CB', 'Payé', 1, 'Test : ticket retrouvé après coup par le gérant', 'admin(test)', 'TK-ADMIN') as r`); c = await lire(C); lc = await dernier(C);
  test('procédure administrateur avec motif (et ticket) : acceptée et journalisée', r.ok && r.json[0].r.ok && pai(c) === 'CB / Payé / 1' && c.ticket_cb === 'TK-ADMIN' && lc.action === 'modification_admin' && /ticket retrouvé/.test(lc.motif) && lc.utilisateur === 'admin(test)', lc);
  r = await sql(`select interne.modifier_paiement('${C}', 'CB', 'Payé', 1, '', 'admin(test)', null) as r`);
  test('procédure administrateur sans motif : refusée', r.ok && r.json[0].r.ok === false && r.json[0].r.erreur === 'motif_obligatoire');
  // d) paiement par carte AVANT livraison, écrit par un programme serveur (sans session) : hors de cette règle (le bureau, lui, relève de la section 9)
  await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(C), { statut: 'annulé', paie: 'Espèces', stpaie: 'Non payé', montant_enc: 0, ticket_cb: null });
  await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(C), { paie: 'CB', stpaie: 'Payé', montant_enc: 1 }); c = await lire(C);
  test('carte écrite par un programme serveur sur une commande non livrée : acceptée (ce n\'est pas un encaissement à la livraison) et journalisée', pai(c) === 'CB / Payé / 1' && (await dernier(C)).action === 'modification', pai(c));
  await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(C), { paie: 'Espèces', stpaie: 'Non payé', montant_enc: 0 });
  await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(B), { paie: 'Espèces', stpaie: 'Non payé', montant_enc: 0, encaisse_par: null, encaisse_at: null, statut: 'annulé' });
  // e) le verrou « payée en ligne » est inchangé
  await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(A), { paie: 'CB', stpaie: 'Payé', montant_enc: 1, ticket_cb: 'T-9', encaisse_par: 'RANOU', encaisse_at: new Date().toISOString(), statut: 'livré' }); a = await lire(A);
  test('commande payée en ligne : même avec un ticket, aucun encaissement livreur possible', fin(a) === 'Site Maxiconfort / Payé / 1' && !a.ticket_cb && !a.encaisse_par, a);
  r = await rest('POST', 'rpc/modifier_paiement', { p_cmd: A, p_mode: 'CB', p_statut: 'Payé', p_montant: 1, p_motif: 'tentative sans session administrateur', p_ticket: 'X' });
  test('action administrateur (nouvelle forme, avec ticket) sans session administrateur : refusée', r.json && r.json.ok === false && r.json.erreur === 'session_admin_requise', r.texte.slice(0, 200));

  console.log('\n9. « PAYÉ » EN ESPÈCES OU CARTE AVANT LA LIVRAISON, DEPUIS LE BUREAU : ADMINISTRATEUR + MOTIF (migration 029)');
  // Écriture faite avec une SESSION DE BUREAU simulée : la session est créée, utilisée et supprimée dans la même
  // opération de la base (le jeton est tiré au hasard dans la base, il n'en sort jamais).
  const bureau = ecriture => sql(`do $$ declare tk text := encode(extensions.gen_random_bytes(32), 'hex'); begin
    insert into public.sessions_app (jeton_hash, role, expire_at, appareil) values (encode(extensions.digest(tk, 'sha256'), 'hex'), 'admin', now() + interval '2 minutes', 'test-automatique');
    perform set_config('request.headers', json_build_object('x-app-secret', (select valeur from public.secrets_serveur where cle = 'app_secret_courant'), 'x-session-token', tk)::text, true);
    ${ecriture};
    perform set_config('request.headers', '', true);
    delete from public.sessions_app where appareil = 'test-automatique';
  end $$`);
  const maj = (id, champs) => `update public.commandes set ${champs} where id = '${id}'`;
  await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(C), { statut: 'annulé', paie: 'Espèces', stpaie: 'Non payé', montant_enc: 0, ticket_cb: null, adresse: 'ADRESSE DE TEST 75000 Paris' });
  r = await bureau(maj(C, "stpaie = 'Payé', montant_enc = 1")); c = await lire(C); lc = await dernier(C);
  test('la session de bureau simulée fonctionne (l\'écriture est bien vue comme venant du bureau)', r.ok && lc.utilisateur === 'admin', r.ok ? lc.utilisateur : r.texte.slice(0, 200));
  test('fiche enregistrée « Espèces / Payé » sur une commande non livrée : paiement NON enregistré, reste « Non payé »', pai(c) === 'Espèces / Non payé / 0', pai(c));
  test('la tentative est notée au journal (aucune validation silencieuse)', lc.action === 'tentative_bloquee' && /avant la livraison/.test(lc.motif) && Number(lc.reste_du) === 1, lc);
  r = await bureau(maj(C, "paie = 'CB', stpaie = 'Payé', montant_enc = 1, ticket_cb = 'T-1'")); c = await lire(C);
  test('« CB / Payé » avant livraison depuis le bureau : refusé', r.ok && pai(c) === 'Espèces / Non payé / 0' && !c.ticket_cb, pai(c));
  r = await bureau(maj(C, "stpaie = 'Partiel', montant_enc = 0.5")); c = await lire(C);
  test('« Partiel » en espèces avant livraison depuis le bureau : refusé', r.ok && pai(c) === 'Espèces / Non payé / 0', pai(c));
  r = await bureau(maj(C, "stpaie = 'Payé', montant_enc = 1, adresse = 'ADRESSE DE TEST MODIFIÉE 75000 Paris'")); c = await lire(C);
  test('le reste de la fiche (adresse) est bien enregistré, seul le paiement est refusé', r.ok && pai(c) === 'Espèces / Non payé / 0' && /MODIFIÉE/.test(c.adresse), c.adresse);
  r = await bureau(maj(C, "paie = 'Virement', stpaie = 'Payé', montant_enc = 1")); c = await lire(C);
  test('« Virement / Payé » avant livraison : accepté (règle limitée aux espèces et à la carte)', r.ok && pai(c) === 'Virement / Payé / 1', pai(c));
  await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(C), { paie: 'Espèces', stpaie: 'Non payé', montant_enc: 0 });
  r = await bureau(maj(C, "statut = 'livré', stpaie = 'Payé', montant_enc = 1")); c = await lire(C);
  test('commande LIVRÉE, « Espèces / Payé » : accepté (l\'encaissement à la livraison n\'est pas touché)', r.ok && pai(c) === 'Espèces / Payé / 1', pai(c));
  await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(C), { statut: 'annulé', paie: 'Espèces', stpaie: 'Non payé', montant_enc: 0 });
  r = await sql(`select interne.modifier_paiement('${C}', 'Espèces', 'Payé', 1, 'Test : client venu payer au dépôt avant la livraison', 'admin(test)') as r`); c = await lire(C); lc = await dernier(C);
  test('action administrateur avec motif : acceptée et journalisée', r.ok && r.json[0].r.ok && pai(c) === 'Espèces / Payé / 1' && lc.action === 'modification_admin' && /venu payer au dépôt/.test(lc.motif), lc);
  const nC9 = (await journal(C)).length;
  r = await bureau(maj(C, "adresse = 'ADRESSE DE TEST 75000 Paris'")); c = await lire(C);
  test('ensuite, une simple sauvegarde de la fiche ne défait pas ce paiement et n\'ajoute rien au journal', r.ok && pai(c) === 'Espèces / Payé / 1' && (await journal(C)).length === nC9, pai(c));
  await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(C), { paie: 'Espèces', stpaie: 'Non payé', montant_enc: 0 });
  // création depuis le bureau : la ligne est créée puis supprimée dans la même opération ; le journal (en ajout seul) garde la preuve
  const D = '#TEST-PAIEMENT-AV', S = '#TEST-PAIEMENT-SAV';
  const creer = (id, origine, prix, paie, stpaie, enc) => `insert into public.commandes (id, client, tel, email, adresse, produit, qte, prix, prix_brut, livreur, statut, date_livraison, transporteur, paie, stpaie, montant_enc, origine, ref_marketplace, instr) values ('${id}', 'TEST CORRECTIF PAIEMENT (ne pas livrer)', '', '', 'ADRESSE DE TEST 75000 Paris', 'TEST', 1, ${prix}, ${prix}, '', 'annulé', '', 'RANOU', '${paie}', '${stpaie}', ${enc}, '${origine}', '', 'Ligne technique, à ignorer.'); delete from public.commandes where id = '${id}'`;
  const nD = (await journal(D)).length, nS = (await journal(S)).length;
  r = await bureau(creer(D, 'LeBonCoin', 1, 'Espèces', 'Payé', 1)); let jd = (await journal(D)).slice(nD);
  test('CRÉATION d\'une commande « Espèces / Payé » depuis le bureau : créée « Non payé », tentative notée', r.ok && jd.length === 2 && jd[0].action === 'tentative_bloquee' && /avant la livraison/.test(jd[0].motif) && jd[1].action === 'creation' && jd[1].nouveau.stpaie === 'Non payé' && Number(jd[1].nouveau.montant_enc || 0) === 0, r.ok ? jd : r.texte.slice(0, 300));
  r = await bureau(creer(S, 'SAV - Reprise + Remboursement', 0, 'Espèces', 'Payé', -1)); let js = (await journal(S)).slice(nS);
  test('remboursement SAV (0 €, montant négatif) : non concerné, créé tel quel', r.ok && js.length === 1 && js[0].action === 'creation' && js[0].nouveau.stpaie === 'Payé' && Number(js[0].nouveau.montant_enc) === -1, r.ok ? js : r.texte.slice(0, 300));
  const reste = await sql("select (select count(*) from public.sessions_app where appareil = 'test-automatique') as sessions, (select count(*) from public.commandes where id in ('#TEST-PAIEMENT-AV', '#TEST-PAIEMENT-SAV')) as lignes");
  test('aucune session de test ni ligne temporaire ne reste dans la base', reste.ok && Number(reste.json[0].sessions) === 0 && Number(reste.json[0].lignes) === 0, reste.json);

  // ── remise au propre
  await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(A), { statut: 'annulé', livreur: '', date_livraison: '', adresse: 'ADRESSE DE TEST 75000 Paris', instr: 'Ligne technique de test du correctif paiement. Peut être supprimée.' });
  for (const id of [B, C]) await rest('PATCH', 'commandes?id=eq.' + encodeURIComponent(id), { statut: 'annulé' });
  const f = [await lire(A), await lire(B), await lire(C)];
  console.log('\nétat final des lignes de test : ' + f.map(x => `${x.id} ${fin(x)} ${x.statut} ${x.payment_source}`).join(' | '));
  console.log(`\nRÉSULTAT DU TEST DE LA BASE : ${ok} réussis, ${ko} échec(s)`); process.exitCode = ko ? 1 : 0;
})().catch(e => { console.error('ERREUR', e); process.exitCode = 2; });
