// ════════════════════════════════════════════════════════════════════
// Edge Function : whatsapp-receive
// ════════════════════════════════════════════════════════════════════
// Webhook recevant les messages WhatsApp via Twilio.
// Parse le contenu avec Claude Haiku 4.5, cree une commande Supabase,
// repond en TwiML avec recap.
//
// Features :
// - Detection origine auto (TikTok, LeBonCoin, Amazon, etc.)
// - Auto-paye pour les modes prepayes
// - LeBonCoin IDF = paye a la livraison (exception)
// - Transporteur auto : RANOU (IDF) / GLS (hors IDF)
// - Dedoublonnage 48h par tel + produit
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

function chercherProduit(catalogue: any[], description: string, prixAttendu: number): any | null {
  if (!description) return null;
  const desc = description.toLowerCase();
  let match = catalogue.find(p => p.nom.toLowerCase() === desc);
  if (match) return match;
  const motsDesc = desc.split(/\s+/).filter(m => m.length > 2);
  const candidats = catalogue.filter(p => {
    if (prixAttendu && Math.abs(p.prix - prixAttendu) < 0.5) return true;
    const motsProd = p.nom.toLowerCase().split(/\s+/);
    let score = 0;
    motsDesc.forEach(m => {
      if (motsProd.some((mp: string) => mp.includes(m) || m.includes(mp))) score++;
    });
    return score >= 2;
  });
  candidats.sort((a, b) => Math.abs(a.prix - prixAttendu) - Math.abs(b.prix - prixAttendu));
  return candidats[0] || null;
}

async function parseAvecClaude(message: string): Promise<any> {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY manquant');
  const sysPrompt = `Tu es un parseur de commandes de livraison de meubles. Tu recois un message texte court qui decrit une commande et tu extrais les informations au format JSON strict.

Champs a extraire :
- client : nom du client (string)
- tel : numero de telephone au format francais (string)
- adresse : adresse complete avec code postal et ville (string)
- produit : description COMPLETE du produit avec dimensions ET epaisseur si mentionnees (ex "Ensemble 140x190x20" garde le x20)
- quantite : nombre (defaut 1)
- prix : montant en euros (number, sans le symbole)
- instructions : instructions specifiques ou null
- date_livraison : date au format YYYY-MM-DD ou null
- paiement : "Especes" / "CB" / "Virement" / "TikTok Shop" / "LeBonCoin" / "Deja paye" ou null
- origine : detecte la source dans le message :
  * "TikTok Shop" si mention tiktok / tik tok
  * "LeBonCoin" si mention LBC / leboncoin
  * "Site Maxiconfort" si mention site / web / maxiconfort.fr
  * "Amazon", "Cdiscount", "Manomano", "Fnac Darty", "Rakuten", "Rue du Commerce" si mention de la plateforme
  * "Appel direct" si mention appel telephonique
  * "Email direct" si mention email
  * null si aucune source mentionnee

IMPORTANT : pour les ensembles avec epaisseur (140x190x20, 140x190x15), garde le format complet. L'epaisseur (x20, x15) est essentielle pour matcher le bon produit.

Reponds UNIQUEMENT avec un objet JSON valide. Pas de texte avant ou apres. Pas de backticks.
Si une info essentielle manque (client, tel, adresse OU produit), reponds : {"erreur": "explication"}`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
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

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  let from = '', body = '';
  try {
    const form = await req.formData();
    from = String(form.get('From') || '');
    body = String(form.get('Body') || '');
  } catch { return twiml('❌ Format de requete invalide'); }
  if (ALLOWED && from !== ALLOWED) {
    console.warn('Refuse from:', from);
    return twiml('🚫 Numero non autorise');
  }
  if (!body || body.trim().length < 10) {
    return twiml('❌ Message trop court. Envoie : nom, tel, adresse, produit, prix.');
  }
  const bodyLow = body.toLowerCase();
  const forceCreate = bodyLow.includes('confirme') || bodyLow.includes('force') || bodyLow.includes('quand meme');
  let parsed: any;
  try { parsed = await parseAvecClaude(body); }
  catch (e: any) { return twiml('❌ Erreur IA : ' + e.message); }
  if (parsed.erreur) return twiml('❌ Format pas compris : ' + parsed.erreur);
  if (!parsed.client || !parsed.tel || !parsed.adresse || !parsed.produit || !parsed.prix) {
    const manquants = [];
    if (!parsed.client) manquants.push('client');
    if (!parsed.tel) manquants.push('tel');
    if (!parsed.adresse) manquants.push('adresse');
    if (!parsed.produit) manquants.push('produit');
    if (!parsed.prix) manquants.push('prix');
    return twiml('❌ Manque : ' + manquants.join(', '));
  }
  if (!forceCreate) {
    const doublon = await chercherDoublon(parsed.tel, parsed.produit);
    if (doublon) {
      return twiml(`⚠️ Commande deja existante : ${doublon.id}
👤 ${doublon.client}
📦 ${doublon.produit}
💶 ${doublon.prix} €
Pour creer quand meme, renvoie ton message avec "confirme" a la fin.`);
    }
  }
  const catalogue = await chargerCatalogue();
  const prod = chercherProduit(catalogue, parsed.produit, parsed.prix);
  const produitNom = prod ? prod.nom : parsed.produit;
  const produitId = prod ? prod.id : '';
  const prixUnit = parsed.prix;
  const qte = parsed.quantite || 1;
  const cmdId = await nextCmdId();
  const todayIso = new Date().toISOString().split('T')[0];
  const ligne = {
    produitId, produit: produitNom, qte, prixUnit,
    prixBrut: prixUnit * qte, remiseLigne: 0,
    remiseVal: 0, remiseType: 'pct', sousTotal: prixUnit * qte
  };
  const origineFinale = parsed.origine || 'WhatsApp';
  const cpAdresse = extraireCPDepuisAdresse(parsed.adresse);
  const lbcEnIDF = origineFinale === 'LeBonCoin' && estCPIDF(cpAdresse);
  const estPrepaye = ORIGINES_PREPAYE.includes(origineFinale) && !lbcEnIDF;
  const paieFinal = estPrepaye ? origineFinale : (parsed.paiement || 'Espèces');
  const stpaieFinal = estPrepaye ? 'Payé' : 'Non payé';
  const montantEncFinal = estPrepaye ? prixUnit * qte : 0;
  const transporteurFinal = estCPIDF(cpAdresse) ? 'RANOU' : 'GLS';

  const cmd = {
    id: cmdId, client: parsed.client, tel: parsed.tel,
    email: '', adresse: parsed.adresse, etage: '', ascenseur: 'Non', code: '',
    produit: produitNom, lignes: [ligne], qte: qte,
    prix: prixUnit * qte, prix_brut: prixUnit * qte,
    remise_globale: 0, remise_globale_val: 0, remise_globale_type: 'pct', remise_motif: '',
    paie: paieFinal, stpaie: stpaieFinal, montant_enc: montantEncFinal,
    livreur: '', statut: 'en-attente',
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
  const matchInfo = prod ? '✓ produit catalogue' : '⚠ produit hors catalogue';
  const statutPaie = estPrepaye ? '✅ Deja paye' : `💶 ${paieFinal} - ${stpaieFinal}`;
  const reponse = `✅ Commande ${cmdId} creee
👤 ${parsed.client}
📞 ${parsed.tel}
📍 ${parsed.adresse}
📦 ${produitNom}
💶 ${prixUnit * qte} €
🛒 Origine : ${origineFinale}
🚚 ${transporteurFinal}
${statutPaie}
${matchInfo}`;
  return twiml(reponse);
});
