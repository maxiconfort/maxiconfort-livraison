// ════════════════════════════════════════════════════════════════════
// Edge Function : whatsapp-receive
// ════════════════════════════════════════════════════════════════════
// Webhook recevant les messages WhatsApp via Twilio.
// Parse avec Claude Haiku 4.5, cree une commande Supabase.
//
// Features :
// - Multi-produits par commande (array)
// - Detection origine auto (TikTok, LeBoncoin, Amazon, etc.)
// - Auto-paye pour modes prepayes (sauf LeBoncoin IDF)
// - Transporteur RANOU/GLS auto selon CP
// - Livreur auto (RANOU si IDF, GLS sinon)
// - Dedoublonnage 48h par tel + produit
// - Commande "?" renvoie le template
// - Matching produit v2 : algorithme + IA fallback (Option C)
//   * Score base sur dimensions (40pt) + categorie (20pt) + mots (30pt) + prix (10pt)
//   * Si confiance < 70 et candidats trouves -> appel Claude pour choisir
// - Securite : seul ALLOWED_WHATSAPP_FROM autorise
//
// Secrets requis :
// - ANTHROPIC_API_KEY
// - SUPABASE_SERVICE_ROLE_KEY (auto)
// - SUPABASE_URL (auto)
// - ALLOWED_WHATSAPP_FROM (ex: whatsapp:+33751563113)
// ════════════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';
const SB_URL    = Deno.env.get('SUPABASE_URL') || '';
const SB_SR_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const ALLOWED   = Deno.env.get('ALLOWED_WHATSAPP_FROM') || '';

const ORIGINES_PREPAYE = ['TikTok Shop', 'LeBonCoin', 'Amazon', 'Cdiscount', 'Manomano', 'Fnac Darty', 'Rakuten', 'Rue du Commerce', 'Site Maxiconfort'];
const DEPS_IDF = ['75', '77', '78', '91', '92', '93', '94', '95'];

const sb = createClient(SB_URL, SB_SR_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function twiml(message: string): Response {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response><Message>${escapeXml(message)}</Message></Response>`;
  return new Response(xml, { status: 200, headers: { 'Content-Type': 'text/xml; charset=utf-8' } });
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function nettoyerTel(t: string): string {
  return (t || '').replace(/[\s.()\-+]/g, '');
}

function extraireCPDepuisAdresse(adresse: string): string {
  const match = (adresse || '').match(/\b(\d{5})\b/);
  return match ? match[1] : '';
}

function estCPIDF(cp: string): boolean {
  if (!cp || cp.length !== 5) return false;
  return DEPS_IDF.includes(cp.substring(0, 2));
}

async function chercherDoublon(tel: string, produitNom: string): Promise<any | null> {
  if (!tel) return null;
  const telClean = nettoyerTel(tel);
  const il48h = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const { data } = await sb
    .from('commandes')
    .select('id, client, tel, produit, prix, statut, date_commande, created_at')
    .gte('created_at', il48h)
    .neq('statut', 'annulé');
  if (!data) return null;
  const motProd = produitNom.toLowerCase().split(/\s+/).filter(m => m.length > 3).slice(0, 3);
  for (const c of data) {
    if (nettoyerTel(c.tel || '') === telClean) {
      const prodLow = (c.produit || '').toLowerCase();
      const matchProd = motProd.length > 0 && motProd.every(m => prodLow.includes(m));
      if (matchProd) return c;
    }
  }
  return null;
}

async function nextCmdId(): Promise<string> {
  const { data } = await sb.from('commandes').select('id').order('id', { ascending: false }).limit(50);
  let maxN = 1100;
  (data || []).forEach((r: any) => {
    const m = (r.id || '').match(/^#(\d+)$/);
    if (m) { const n = parseInt(m[1]); if (n > maxN) maxN = n; }
  });
  return '#' + (maxN + 1);
}

async function chargerCatalogue(): Promise<any[]> {
  const { data } = await sb.from('produits').select('id, nom, cat, dim, prix').eq('actif', true).limit(200);
  return data || [];
}

// ════════════════════════════════════════════════════════════
// MATCHING PRODUIT V2 (Option C : algo + IA fallback)
// ════════════════════════════════════════════════════════════

function normaliserTexte(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/×/g, 'x')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function extraireDimensions(s: string): string[] {
  const norm = normaliserTexte(s);
  const matches = norm.match(/\b(\d{2,3})\s*x\s*(\d{2,3})(?:\s*x\s*(\d{1,3}))?\b/g) || [];
  return matches.map(m => m.replace(/\s/g, ''));
}

function detecterCategorie(s: string): string | null {
  const n = normaliserTexte(s);
  if (n.includes('ensemble')) return 'ensemble';
  if (n.includes('matelas') && !n.includes('ensemble')) return 'matelas';
  if (n.includes('lit coffre') || n.includes('coffre')) return 'lit coffre';
  if (n.includes('lit superpose') || n.includes('superpose')) return 'lit superpose';
  if (n.includes('lit nico') || (n.includes('lit') && !n.includes('matelas') && !n.includes('coffre') && !n.includes('superpose'))) return 'lit';
  if (n.includes('sommier')) return 'sommier';
  if (n.includes('canape')) return 'canape';
  return null;
}

function chercherProduit(catalogue: any[], description: string, prixAttendu: number): { produit: any | null, confiance: number, topN: any[] } {
  if (!description) return { produit: null, confiance: 0, topN: [] };
  const descN = normaliserTexte(description);
  const exact = catalogue.find(p => normaliserTexte(p.nom) === descN);
  if (exact) return { produit: exact, confiance: 100, topN: [exact] };

  const dimsDesc = extraireDimensions(description);
  const catDesc = detecterCategorie(description);
  const motsDesc = descN.split(/\s+/).filter(m => m.length > 2);

  const scored = catalogue.map(p => {
    let score = 0;
    const nomN = normaliserTexte(p.nom);
    const motsProd = nomN.split(/\s+/);
    const dimsProd = extraireDimensions(p.nom + ' ' + (p.dim || ''));
    const catProd = detecterCategorie(p.nom);

    if (dimsDesc.length > 0 && dimsProd.length > 0) {
      const matchDim = dimsDesc.some(d => dimsProd.includes(d));
      if (matchDim) score += 40;
    }
    if (catDesc && catProd && catDesc === catProd) score += 20;
    let motsMatch = 0;
    motsDesc.forEach(m => {
      if (motsProd.some((mp: string) => mp.includes(m) || m.includes(mp))) motsMatch++;
    });
    score += Math.min(30, motsMatch * 6);
    if (prixAttendu && p.prix > 0) {
      const ratio = Math.abs(p.prix - prixAttendu) / p.prix;
      if (ratio < 0.05) score += 10;
      else if (ratio < 0.15) score += 5;
    }
    return { produit: p, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const meilleur = scored[0];
  if (!meilleur || meilleur.score === 0) return { produit: null, confiance: 0, topN: [] };

  const confiance = Math.min(100, meilleur.score);
  const topN = scored.slice(0, 8).filter(s => s.score > 10).map(s => s.produit);
  return { produit: meilleur.produit, confiance, topN };
}

async function matcherAvecClaude(description: string, prixAttendu: number, candidats: any[]): Promise<any | null> {
  if (!ANTHROPIC_KEY || !candidats.length) return null;
  const liste = candidats.map((p, i) => `${i + 1}. ${p.nom} (cat: ${p.cat || '?'}, dim: ${p.dim || '?'}, prix catalogue: ${p.prix}€)`).join('\n');
  const sysPrompt = `Tu es un expert en catalogue de meubles. On te donne une description courte de produit et une liste de produits possibles du catalogue. Tu dois choisir lequel correspond le mieux a la description.

Critere principal : les DIMENSIONS (140x190x20) et la CATEGORIE (matelas, ensemble, lit coffre, sommier, lit, lit superpose, canape) doivent matcher EXACTEMENT.
Critere secondaire : les mots-cles (couleur, marque, type de sommier) doivent etre coherents.
Le prix peut etre different du catalogue (negociation, remise) donc ne te base PAS sur le prix pour matcher.

Reponds UNIQUEMENT avec un objet JSON :
{"choix": N}
ou N est le numero du produit choisi (1 a ${candidats.length}), OU 0 si aucun ne correspond vraiment.

Pas de texte avant ou apres. Pas de backticks.`;

  const userMsg = `Description du SMS : "${description}" (prix saisi : ${prixAttendu}€)

Liste des produits possibles :
${liste}

Quel est le numero du meilleur match (1-${candidats.length}) ? Ou 0 si aucun ne correspond ?`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        system: sysPrompt,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const texte = (data?.content?.[0]?.text || '').replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(texte);
    const choix = parseInt(parsed.choix);
    if (choix >= 1 && choix <= candidats.length) return candidats[choix - 1];
    return null;
  } catch (e) {
    console.warn('matcherAvecClaude:', (e as any).message);
    return null;
  }
}

// Wrapper : match local + fallback IA si confiance basse
async function matcherProduitFinal(catalogue: any[], description: string, prixAttendu: number): Promise<{ produit: any | null, source: string }> {
  const result = chercherProduit(catalogue, description, prixAttendu);
  // Si confiance >= 70, on garde le match algo
  if (result.confiance >= 70) {
    return { produit: result.produit, source: 'algo' };
  }
  // Si confiance < 70 mais on a des candidats, fallback IA
  if (result.topN.length > 0) {
    const matchIA = await matcherAvecClaude(description, prixAttendu, result.topN);
    if (matchIA) return { produit: matchIA, source: 'ia' };
    // IA n'a rien trouve : si on avait au moins un candidat moyen, on le garde
    if (result.confiance >= 40) return { produit: result.produit, source: 'algo-faible' };
  }
  return { produit: null, source: 'aucun' };
}

// ════════════════════════════════════════════════════════════
// PARSING IA + TEMPLATE
// ════════════════════════════════════════════════════════════

function templateCommande(): string {
  return `📋 TEMPLATE COMMANDE - copie / remplis / envoie :

Client :
Tel :
Adresse :
Produits :
-
-
Origine :
Paiement :
Date livraison :
Notes :

Obligatoires : Client, Tel, Adresse, au moins 1 Produit avec prix
Optionnels : Origine (TikTok / LBC / Amazon / Site...), Paiement, Date, Notes

📦 1 produit :
Client : Maurice Francoise
Tel : 0761026756
Adresse : 9 rue Chatillon 51290 Giffaumont
Produit : Ensemble 140x190x20 207€
Origine : TikTok Shop

📦📦 Plusieurs produits :
Client : Ruben Mendes
Tel : 0768051784
Adresse : 12 av parc 91900 Solers
Produits :
- 2 x Ensemble 160x200 Lit NICO Blanc 329€
- 1 x Lit Coffre Noir 160x200 379€
- 1 x Matelas 160x200x20 169€
Origine : LeBonCoin`;
}

async function parseAvecClaude(message: string): Promise<any> {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY manquant');
  const sysPrompt = `Tu es un parseur de commandes de livraison de meubles. Tu recois un message texte (libre ou structure avec labels Client/Tel/Adresse/...) et tu extrais les informations au format JSON strict.

Champs a extraire :
- client : nom du client (string)
- tel : numero francais (string)
- adresse : adresse complete CP+ville (string)
- produits : ARRAY d'objets, 1 par produit :
  { "description": "ex Ensemble 140x190x20", "prix": 207, "quantite": 1 }
  Garde TOUJOURS le format complet avec epaisseur (x20, x15)
  Le prix est le prix UNITAIRE (pas le total)
- instructions : notes / instructions ou null
- date_livraison : YYYY-MM-DD ou null
- paiement : "Especes" / "CB" / "Virement" / "TikTok Shop" / "LeBonCoin" / "Deja paye" ou null
- origine : detecte la source :
  * "TikTok Shop" si mention tiktok / tik tok
  * "LeBonCoin" si mention LBC / leboncoin
  * "Site Maxiconfort" si mention site / web / maxiconfort.fr
  * "Amazon", "Cdiscount", "Manomano", "Fnac Darty", "Rakuten", "Rue du Commerce" si mention de la plateforme
  * "Appel direct" si mention appel telephonique
  * "Email direct" si mention email
  * null si non mentionnee

IMPORTANT :
- Le tableau "produits" doit avoir au moins 1 element
- Pour les ensembles avec epaisseur (140x190x20, 140x190x15), garde le format complet
- Ignore les champs vides du template

Reponds UNIQUEMENT avec un objet JSON valide. Pas de texte avant ou apres. Pas de backticks.
Si une info essentielle manque (client, tel, adresse OU aucun produit), reponds : {"erreur": "explication"}`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: sysPrompt,
      messages: [{ role: 'user', content: message }],
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    console.warn('Claude HTTP', resp.status, err);
    throw new Error('Claude API ' + resp.status);
  }
  const data = await resp.json();
  const texte = data?.content?.[0]?.text || '';
  const propre = texte.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  return JSON.parse(propre);
}

// ════════════════════════════════════════════════════════════
// MAIN HANDLER
// ════════════════════════════════════════════════════════════

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  let from = '', body = '';
  try {
    const form = await req.formData();
    from = String(form.get('From') || '');
    body = String(form.get('Body') || '');
  } catch { return twiml('❌ Format de requete invalide'); }
  // v2 : Liste de numeros autorises (separes par virgule)
  if (ALLOWED) {
    const autorisees = ALLOWED.split(',').map(s => s.trim()).filter(Boolean);
    if (!autorisees.includes(from)) {
      console.warn('Refuse from:', from, 'autorises:', autorisees);
      return twiml('🚫 Numero non autorise');
    }
  }

  // Commande "?" -> template
  const bodyTrim = body.trim().toLowerCase();
  if (['?', 'modele', 'modèle', 'template', 'aide', 'help', 'commande'].includes(bodyTrim)) {
    return twiml(templateCommande());
  }

  if (!body || body.trim().length < 10) {
    return twiml('❌ Message trop court. Envoie "?" pour le modele.');
  }
  const bodyLow = body.toLowerCase();
  const forceCreate = bodyLow.includes('confirme') || bodyLow.includes('force') || bodyLow.includes('quand meme');

  let parsed: any;
  try { parsed = await parseAvecClaude(body); }
  catch (e: any) { return twiml('❌ Erreur IA : ' + e.message); }
  if (parsed.erreur) return twiml('❌ Format pas compris : ' + parsed.erreur + '\n\nEnvoie "?" pour le modele.');

  // Compat : si l'IA renvoie "produit" (singulier)
  if (!parsed.produits && parsed.produit) {
    parsed.produits = [{ description: parsed.produit, prix: parsed.prix || 0, quantite: parsed.quantite || 1 }];
  }
  if (!Array.isArray(parsed.produits) || parsed.produits.length === 0) {
    return twiml('❌ Aucun produit detecte.\n\nEnvoie "?" pour le modele.');
  }
  if (!parsed.client || !parsed.tel || !parsed.adresse) {
    const manquants = [];
    if (!parsed.client) manquants.push('client');
    if (!parsed.tel) manquants.push('tel');
    if (!parsed.adresse) manquants.push('adresse');
    return twiml('❌ Manque : ' + manquants.join(', ') + '\n\nEnvoie "?" pour le modele.');
  }

  // Dedoublonnage : check sur le 1er produit
  if (!forceCreate) {
    const doublon = await chercherDoublon(parsed.tel, parsed.produits[0].description || '');
    if (doublon) {
      return twiml(`⚠️ Commande deja existante : ${doublon.id}
👤 ${doublon.client}
📦 ${doublon.produit}
💶 ${doublon.prix} €
Pour creer quand meme, renvoie avec "confirme" a la fin.`);
    }
  }

  const catalogue = await chargerCatalogue();
  const lignes: any[] = [];
  let prixTotal = 0;
  let prodLabels: string[] = [];
  let nbHorsCatalogue = 0;
  let nbIA = 0;

  for (const p of parsed.produits) {
    const desc = p.description || p.nom || '';
    const prixUnit = parseFloat(p.prix) || 0;
    const qte = parseInt(p.quantite) || 1;
    if (!desc || prixUnit <= 0) continue;

    // MATCHING V2 : algo + IA fallback
    const match = await matcherProduitFinal(catalogue, desc, prixUnit);
    const produitNom = match.produit ? match.produit.nom : desc;
    const produitId = match.produit ? match.produit.id : '';
    if (!match.produit) nbHorsCatalogue++;
    if (match.source === 'ia') nbIA++;

    const sousTotal = prixUnit * qte;
    lignes.push({
      produitId, produit: produitNom, qte, prixUnit,
      prixBrut: sousTotal, remiseLigne: 0,
      remiseVal: 0, remiseType: 'pct', sousTotal: sousTotal
    });
    prixTotal += sousTotal;
    prodLabels.push((qte > 1 ? qte + 'x ' : '') + produitNom + ' (' + prixUnit + '€)');
  }
  if (lignes.length === 0) {
    return twiml('❌ Aucun produit valide (prix manquant ou 0).\n\nEnvoie "?" pour le modele.');
  }

  const cmdId = await nextCmdId();
  const todayIso = new Date().toISOString().split('T')[0];
  const origineFinale = parsed.origine || 'WhatsApp';
  const cpAdresse = extraireCPDepuisAdresse(parsed.adresse);
  const lbcEnIDF = origineFinale === 'LeBonCoin' && estCPIDF(cpAdresse);
  const estPrepaye = ORIGINES_PREPAYE.includes(origineFinale) && !lbcEnIDF;
  const paieFinal = estPrepaye ? origineFinale : (parsed.paiement || 'Espèces');
  const stpaieFinal = estPrepaye ? 'Payé' : 'Non payé';
  const montantEncFinal = estPrepaye ? prixTotal : 0;
  const transporteurFinal = estCPIDF(cpAdresse) ? 'RANOU' : 'GLS';
  const livreurFinal = transporteurFinal === 'RANOU' ? 'RANOU' : 'GLS';

  const produitLabel = lignes.length === 1
    ? lignes[0].produit
    : lignes[0].produit + ' (+' + (lignes.length - 1) + ' autre' + (lignes.length > 2 ? 's' : '') + ')';

  const cmd = {
    id: cmdId, client: parsed.client, tel: parsed.tel,
    email: '', adresse: parsed.adresse, etage: '', ascenseur: 'Non', code: '',
    produit: produitLabel, lignes: lignes, qte: lignes.reduce((s: number, l: any) => s + l.qte, 0),
    prix: prixTotal, prix_brut: prixTotal,
    remise_globale: 0, remise_globale_val: 0, remise_globale_type: 'pct', remise_motif: '',
    paie: paieFinal, stpaie: stpaieFinal, montant_enc: montantEncFinal,
    livreur: livreurFinal, statut: 'en-attente',
    date_livraison: parsed.date_livraison || null,
    date_commande: todayIso,
    instr: parsed.instructions || '',
    origine: origineFinale, ref_marketplace: '',
    transporteur: transporteurFinal, tracking_transporteur: null,
  };
  const { error } = await sb.from('commandes').insert(cmd);
  if (error) {
    console.warn('Insert error', error);
    return twiml('❌ Erreur DB : ' + error.message);
  }

  const matchInfo = nbHorsCatalogue === 0
    ? (nbIA > 0 ? '✓ produits catalogue (' + nbIA + ' match IA)' : '✓ produits catalogue')
    : `⚠ ${nbHorsCatalogue} produit(s) hors catalogue`;
  const statutPaie = estPrepaye ? '✅ Deja paye' : `💶 ${paieFinal} - ${stpaieFinal}`;
  const listeProduits = prodLabels.map(l => '• ' + l).join('\n');
  const reponse = `✅ Commande ${cmdId} creee
👤 ${parsed.client}
📞 ${parsed.tel}
📍 ${parsed.adresse}

📦 ${lignes.length} produit${lignes.length > 1 ? 's' : ''} :
${listeProduits}

💶 TOTAL : ${prixTotal} €
🛒 Origine : ${origineFinale}
🚚 ${transporteurFinal} (livreur : ${livreurFinal})
${statutPaie}
${matchInfo}`;
  return twiml(reponse);
});
