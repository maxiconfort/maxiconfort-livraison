// ════════════════════════════════════════════════════════════════════
// Traitement de la porte lbc-action (sans Deno ni réseau : la base est passée en paramètre → testé sous Node).
// Réserves Codex Livraison #6 (2e passage) :
//  1. l'aperçu montre les lignes RENVOYÉES par la base avec leurs empreintes (même instantané) ; si l'une ne passe plus le
//     filtre ou les protections (publiée, bloquée, jour passé…) entre la lecture et l'enregistrement → 409, refaire l'aperçu ;
//  2. la confirmation transmet les cibles demandées (produitId / ids) à la base, qui les refuse si elles ne sont pas celles
//     du jeton ; la relecture porte sur les cibles RENVOYÉES par la transaction ;
//  3. la relecture est VÉRIFIÉE (valeurs attendues) ; toute incertitude (réseau, réponse illisible, relecture impossible ou
//     différente) = 502 INDÉTERMINÉ, jamais « rien n'a été modifié ». Seule une erreur SQL certaine (code SQLSTATE) = 500
//     « annulé par la base ».
// ════════════════════════════════════════════════════════════════════
// deno-lint-ignore-file no-explicit-any
import { ACTIONS_PRODUIT, MAX_ANNONCES, controlerDemande, dansFiltre, parametres, patchAnnonce, patchProduit, refusAnnonce, trouverProduits, verifierAnnonces, verifierProduit, vueAnnonce, vueProduit, type AnnonceLbc, type DemandeLbc, type ProduitLbc } from './lbc-action-logique.ts';

export const COL_PROD = 'id,nom,dim,actif,boost_pct,boost_until,poids_idf,poids_prov';
export const COL_ANN = 'id,date_pub,heure,ville,dept,collab_id,produit,dim,validation,statut,lien';
export type Reponse = { code: number; corps: Record<string, unknown> };
const r = (code: number, corps: Record<string, unknown>): Reponse => ({ code, corps });
const INDETERMINE = (detail: string) => r(502, { ok: false, code: 'INDETERMINE', erreur: 'résultat non vérifié : l’ordre a peut-être été appliqué. Regarde le planning dans l’outil LBC avant de recommencer. (' + detail + ')' });
/** Erreur renvoyée par Postgres (transaction annulée, certain) ou incertitude de transport ? */
// Réserve Codex #6 (5e passage) : seules les erreurs qui prouvent une ANNULATION de la transaction sont « certaines ».
// 08xxx (connexion perdue, dont 08007 : résolution de transaction inconnue), 40003 (achèvement inconnu), 57P0x (arrêt du
// serveur), XX (erreur interne) et tout code inconnu = INCERTAIN → 502 INDÉTERMINÉ.
const CLASSES_ANNULATION = ['22', '23', '25', '42', '53', '54', '55', 'P0'];
const CODES_ANNULATION = ['40001', '40P01', '57014'];
export const erreurSqlCertaine = (e: any) => {
  if (!e || typeof e.code !== 'string' || !/^[0-9A-Z]{5}$/.test(e.code)) return false;
  return CODES_ANNULATION.includes(e.code) || CLASSES_ANNULATION.includes(e.code.slice(0, 2));
};

async function enregistrer(sb: any, d: DemandeLbc, ids: string[], fige: Record<string, unknown> = {}): Promise<{ jeton: string; lignes: any[] } | null> {
  const { data, error } = await sb.rpc('lbc_action_enregistrer_apercu', { p_action: d.action, p_demande: { ...parametres(d), ...fige }, p_ids: ids });
  if (error || !data || typeof data.jeton !== 'string' || !Array.isArray(data.lignes) || data.lignes.length !== ids.length) return null;
  return { jeton: data.jeton, lignes: data.lignes };
}

export async function traiter(d: DemandeLbc, sb: any, maintenant: number): Promise<Reponse> {
  const forme = controlerDemande(d, maintenant); if (forme) return r(422, { ok: false, erreur: forme });
  return d.confirme === true ? confirmer(d, sb, maintenant) : apercu(d, sb, maintenant);
}

async function confirmer(d: DemandeLbc, sb: any, maintenant: number): Promise<Reponse> {
  const produit = ACTIONS_PRODUIT.includes(d.action);
  const ids = produit ? [String(d.produitId)] : (d.ids || []).map(String);
  let res: any;
  try { res = await sb.rpc('lbc_action_appliquer', { p_jeton: d.jeton, p_action: d.action, p_demande: parametres(d), p_ids: ids }); }
  catch (_e) { return INDETERMINE('réponse de la base perdue'); }
  const { data, error } = res || {};
  if (error) return erreurSqlCertaine(error) ? r(500, { ok: false, erreur: 'écriture annulée par la base (rien n’a été modifié)' }) : INDETERMINE('réponse de la base incomplète');
  if (!data || typeof data !== 'object') return INDETERMINE('réponse de la base illisible');
  if (!data.ok) return r(409, { ok: false, code: data.code || 'CHANGE', erreur: String(data.motif || 'refusé').slice(0, 200), problemes: Array.isArray(data.problemes) ? data.problemes.slice(0, 20) : undefined });
  const cibles: string[] = Array.isArray(data.cibles) ? data.cibles.map(String) : [];
  if (!cibles.length || [...cibles].sort().join('|') !== [...ids].sort().join('|')) return INDETERMINE('cibles traitées non confirmées par la base');
  // Relecture VÉRIFIÉE sur les cibles renvoyées par la transaction
  try {
    if (produit) {
      const { data: relu, error: e2 } = await sb.from('lbc_produits').select(COL_PROD).eq('id', cibles[0]).maybeSingle();
      if (e2) return INDETERMINE('relecture impossible');
      const attendu = patchProduit(d, maintenant, '');
      // Boost : l'échéance attendue est celle FIGÉE dans l'aperçu (renvoyée par la base depuis le jeton), pas un recalcul.
      if (d.action === 'boost') { if (typeof data.jusqu !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.jusqu)) return INDETERMINE('échéance du boost non confirmée par la base'); attendu.boost_until = data.jusqu; }
      if (!verifierProduit(relu as ProduitLbc, attendu)) return INDETERMINE('relecture différente de la demande');
      return r(200, { ok: true, action: d.action, confirme: true, fait: true, verifie: true, produit: vueProduit(relu as ProduitLbc), modifiees: data.modifiees });
    }
    const { data: apres, error: e2 } = await sb.from('lbc_annonces').select(COL_ANN).in('id', cibles);
    if (e2 || !Array.isArray(apres)) return INDETERMINE('relecture impossible');
    if (!verifierAnnonces(apres as AnnonceLbc[], cibles, patchAnnonce(d, ''))) return INDETERMINE('relecture différente de la demande');
    return r(200, { ok: true, action: d.action, confirme: true, fait: true, verifie: true, modifiees: data.modifiees, annonces: (apres as AnnonceLbc[]).map(vueAnnonce) });
  } catch (_e) { return INDETERMINE('relecture impossible'); }
}

async function apercu(d: DemandeLbc, sb: any, maintenant: number): Promise<Reponse> {
  if (ACTIONS_PRODUIT.includes(d.action)) {
    let p: ProduitLbc | null = null;
    if (d.produitId) {
      const { data, error } = await sb.from('lbc_produits').select(COL_PROD).eq('id', d.produitId).maybeSingle();
      if (error) return r(502, { ok: false, code: 'LECTURE', erreur: 'catalogue Leboncoin illisible pour l’instant : réessaie' }); // panne ≠ « introuvable »
      p = (data as ProduitLbc) || null;
      if (!p || p.actif === false) return r(422, { ok: false, erreur: 'produit introuvable ou inactif' });
    } else {
      // Catalogue lu EN ENTIER, page par page (la base renvoie 1 000 lignes au plus par requête) : un produit au-delà ne
      // peut plus être ignoré, ni rendre « unique » un produit qui ne l'est pas (réserve Codex #6). Plus de 20 pages : refus.
      const tous: ProduitLbc[] = [];
      for (let page = 0; ; page++) {
        if (page >= 20) return r(422, { ok: false, code: 'CATALOGUE', erreur: 'catalogue trop grand pour une recherche par nom : précise le produit par son identifiant' });
        const { data, error } = await sb.from('lbc_produits').select(COL_PROD).order('id', { ascending: true }).range(page * 1000, page * 1000 + 999);
        if (error || !Array.isArray(data)) return r(502, { ok: false, code: 'LECTURE', erreur: 'catalogue Leboncoin illisible pour l’instant : réessaie' }); // panne ≠ « aucun produit »
        tous.push(...(data as ProduitLbc[])); if (data.length < 1000) break;
      }
      const l = trouverProduits(tous, String(d.produit));
      if (!l.length) return r(422, { ok: false, erreur: 'aucun produit du catalogue Leboncoin ne correspond' });
      if (l.length > 1) return r(200, { ok: true, action: d.action, confirme: false, ambigu: true, candidats: l.slice(0, 12).map(vueProduit) });
      p = l[0];
    }
    // Échéance du boost calculée UNE fois, ici, montrée à Borhen et figée avec le jeton (réserve Codex #6).
    const jusqu = d.action === 'boost' ? new Date(Date.parse(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date(maintenant)) + 'T12:00:00Z') + Number(d.jours) * 864e5).toISOString().slice(0, 10) : null;
    const e = await enregistrer(sb, d, [p.id], jusqu ? { jusqu } : {}); if (!e) return r(502, { ok: false, erreur: 'aperçu non enregistré par la base' });
    const fige = e.lignes[0] as ProduitLbc; // ce que la base a empreint, et donc ce qui sera vérifié à la confirmation
    if (!fige || fige.id !== p.id || fige.actif === false) return r(409, { ok: false, code: 'CHANGE', erreur: 'le produit a changé pendant l’aperçu : refais-le' });
    const apres: Record<string, unknown> = { ...vueProduit(fige) };
    if (d.action === 'boost') { apres.boost_pct = Number(d.pct); apres.boost_until = jusqu; }
    if (d.action === 'fin_boost') { apres.boost_pct = null; apres.boost_until = null; }
    if (d.action === 'poids_zone') apres[d.zone === 'idf' ? 'poids_idf' : 'poids_prov'] = d.poids;
    return r(200, { ok: true, action: d.action, confirme: false, produit: vueProduit(fige), apres, jeton: e.jeton });
  }
  const f = d.filtre!;
  const { data, error } = await sb.from('lbc_annonces').select(COL_ANN).eq('date_pub', f.date).limit(2000);
  if (error || !Array.isArray(data)) return r(502, { ok: false, code: 'LECTURE', erreur: 'planning Leboncoin illisible pour l’instant : réessaie' }); // panne ≠ « aucune annonce »
  const dans = ((data || []) as AnnonceLbc[]).filter((a) => dansFiltre(a, f));
  const ok: AnnonceLbc[] = [], ecartees: Record<string, number> = {};
  for (const a of dans) { const m = refusAnnonce(a, d.action, maintenant); if (m) ecartees[m] = (ecartees[m] || 0) + 1; else ok.push(a); }
  const retenues = ok.slice(0, MAX_ANNONCES);
  if (!retenues.length) return r(200, { ok: true, action: d.action, confirme: false, filtre: f, nouvelleDate: d.nouvelleDate ?? null, trouvees: dans.length, ecartees, trop: false, annonces: [], ids: [], jeton: null });
  const e = await enregistrer(sb, d, retenues.map((a) => a.id)); if (!e) return r(502, { ok: false, erreur: 'aperçu non enregistré par la base' });
  // Les lignes affichées sont celles que la base a empreintes ; elles doivent toujours passer le filtre et les protections.
  const figees = e.lignes as AnnonceLbc[];
  const changees = figees.filter((a) => !dansFiltre(a, f) || refusAnnonce(a, d.action, maintenant));
  if (changees.length) return r(409, { ok: false, code: 'CHANGE', erreur: `le planning a changé pendant l’aperçu (${changees.length} annonce${changees.length > 1 ? 's' : ''}) : refais-le` });
  return r(200, { ok: true, action: d.action, confirme: false, filtre: f, nouvelleDate: d.nouvelleDate ?? null, trouvees: dans.length, ecartees,
    trop: ok.length > MAX_ANNONCES, annonces: figees.map(vueAnnonce), ids: figees.map((a) => a.id), jeton: e.jeton });
}
