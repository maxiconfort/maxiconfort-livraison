// ════════════════════════════════════════════════════════════════════
// MAXICONFORT — Agent d'impression automatique des étiquettes GLS
// ════════════════════════════════════════════════════════════════════
// Tourne en permanence sur le PC du bureau (tâche Windows au démarrage).
// Toutes les 15 s : cherche dans Supabase les commandes GLS dont
// l'étiquette vient d'être créée (tracking rempli, PDF présent) et pas
// encore imprimée (gls_etiquette_imprimee_at NULL), imprime le PDF sur
// l'imprimante thermique Phomemo PM-344-WF, puis marque la commande.
// L'impression est 100 % Windows (imprimer-pdf.ps1) : ni Adobe, ni logiciel tiers.
//
// Garde-fous :
//  - ne touche JAMAIS à l'API GLS (lecture seule du PDF déjà en base)
//  - n'imprime que les étiquettes créées à partir de DATE_MISE_EN_SERVICE
//  - 3 échecs d'impression max par commande (puis alerte dans le journal)
//  - aucune dépendance npm : Node 18+ (fetch natif)
//
// Lancement : node print-agent\agent-impression.js
// Secrets   : lus dans ..\.env (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
// ════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ── Réglages ────────────────────────────────────────────────────────
const IMPRIMANTE = process.env.IMPRIMANTE_GLS || 'PM-344-WF (WiFi)';
const DATE_MISE_EN_SERVICE = process.env.DATE_MISE_EN_SERVICE || '2026-09-16'; // étiquettes plus anciennes ignorées
const INTERVALLE_MS = Number(process.env.INTERVALLE_MS || 15000);
const MAX_ECHECS = 3;

const RACINE = path.resolve(__dirname, '..');
const DOSSIER_SPOOL = path.join(__dirname, 'spool');
const DOSSIER_JOURNAL = path.join(__dirname, 'journal');
const FICHIER_ETAT = path.join(__dirname, 'etat.json');

for (const d of [DOSSIER_SPOOL, DOSSIER_JOURNAL]) fs.mkdirSync(d, { recursive: true });

// ── .env (jamais commité) ───────────────────────────────────────────
function lireEnv() {
  const cfg = {};
  const chemin = path.join(RACINE, '.env');
  if (!fs.existsSync(chemin)) throw new Error(`.env introuvable : ${chemin}`);
  for (const ligne of fs.readFileSync(chemin, 'utf8').split(/\r?\n/)) {
    const m = ligne.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m) cfg[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return cfg;
}
const ENV = lireEnv();
const SUPABASE_URL = (ENV.SUPABASE_URL || '').replace(/\/$/, '');
const CLE = ENV.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !CLE) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquants dans .env');

// ── Journal ─────────────────────────────────────────────────────────
function horodatage() {
  return new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris', hour12: false });
}
function log(msg) {
  const ligne = `[${horodatage()}] ${msg}`;
  console.log(ligne);
  const fichier = path.join(DOSSIER_JOURNAL, `agent-${new Date().toISOString().slice(0, 7)}.log`);
  fs.appendFileSync(fichier, ligne + '\n');
}

// ── État local (tentatives par commande) ────────────────────────────
function lireEtat() {
  try { return JSON.parse(fs.readFileSync(FICHIER_ETAT, 'utf8')); } catch { return { echecs: {}, derniere_verif: null }; }
}
function ecrireEtat(etat) {
  fs.writeFileSync(FICHIER_ETAT, JSON.stringify(etat, null, 2));
}

// ── Supabase REST ───────────────────────────────────────────────────
const ENTETES = {
  apikey: CLE,
  Authorization: `Bearer ${CLE}`,
  'Content-Type': 'application/json',
};
async function rest(chemin, options = {}) {
  const rep = await fetch(`${SUPABASE_URL}/rest/v1/${chemin}`, { ...options, headers: { ...ENTETES, ...(options.headers || {}) } });
  if (!rep.ok) throw new Error(`Supabase ${rep.status} ${rep.statusText} — ${chemin.slice(0, 120)} — ${(await rep.text()).slice(0, 200)}`);
  return rep;
}
// Les id de commande contiennent '#' → obligatoire de l'encoder (%23)
const filtreId = (id) => `id=eq.${encodeURIComponent(id)}`;

async function listerAImprimer() {
  const q = [
    'select=id,client,tracking_transporteur,gls_date_etiquette',
    'transporteur=eq.GLS',
    'tracking_transporteur=not.is.null',
    'tracking_transporteur=neq.',
    'gls_etiquette_imprimee_at=is.null',
    `gls_date_etiquette=gte.${DATE_MISE_EN_SERVICE}`,
    'order=gls_date_etiquette.asc',
    'limit=5',
  ].join('&');
  const rep = await rest(`commandes?${q}`);
  return rep.json();
}
async function recupererPdf(id) {
  const rep = await rest(`commandes?${filtreId(id)}&select=gls_pdf_base64`);
  const rows = await rep.json();
  return rows[0]?.gls_pdf_base64 || null;
}
async function marquerImprimee(id, ok, detail) {
  const body = { gls_etiquette_imprimee_at: new Date().toISOString() };
  if (!ok) body.gls_etiquette_imprimee_at = null; // on ne marque que les succès
  await rest(`commandes?${filtreId(id)}`, { method: 'PATCH', body: JSON.stringify(body), headers: { Prefer: 'return=minimal' } });
  if (detail) log(detail);
}

// ── Impression : 100 % Windows, sans Adobe ni logiciel tiers ────────
// print-agent\imprimer-pdf.ps1 rend le PDF en image avec le composant PDF natif de Windows
// et l'envoie au pilote de l'imprimante sur le papier 4x6". Code 0 + "OK ..." = envoyé au spouleur.
const SCRIPT_IMPRESSION = path.join(__dirname, 'imprimer-pdf.ps1');
function moteurImpression() { return fs.existsSync(SCRIPT_IMPRESSION) ? { nom: 'Windows natif' } : null; }
function imprimerPdf(fichier) {
  if (!moteurImpression()) throw new Error(`Script d'impression introuvable : ${SCRIPT_IMPRESSION}`);
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_IMPRESSION, '-Fichier', fichier, '-Imprimante', IMPRIMANTE], { encoding: 'utf8', timeout: 120000, windowsHide: true });
  const sortie = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.error) throw r.error;
  if (r.status !== 0 || !/^OK /m.test(sortie)) throw new Error(`impression Windows code ${r.status} : ${sortie.slice(0, 300)}`);
  log(`   ${sortie.split(/\r?\n/).find((l) => l.startsWith('OK '))}`);
  return 'Windows natif';
}

// ── Boucle principale ───────────────────────────────────────────────
let enCours = false;
async function tour() {
  if (enCours) return;
  enCours = true;
  const etat = lireEtat();
  try {
    const cmds = await listerAImprimer();
    etat.derniere_verif = new Date().toISOString();
    for (const cmd of cmds) {
      const nbEchecs = etat.echecs[cmd.id] || 0;
      if (nbEchecs >= MAX_ECHECS) continue; // signalé une fois, on n'insiste plus
      const nbColis = String(cmd.tracking_transporteur).split(',').filter(Boolean).length;
      log(`→ ${cmd.id} ${cmd.client || ''} — ${nbColis} colis (${cmd.tracking_transporteur}) — étiquette du ${cmd.gls_date_etiquette}`);
      try {
        const b64 = await recupererPdf(cmd.id);
        if (!b64) { log(`   PDF absent en base pour ${cmd.id}, réessai au prochain tour`); continue; }
        const fichier = path.join(DOSSIER_SPOOL, `GLS_${cmd.id.replace(/[^A-Za-z0-9_-]/g, '')}.pdf`);
        fs.writeFileSync(fichier, Buffer.from(b64, 'base64'));
        const moteur = imprimerPdf(fichier);
        await marquerImprimee(cmd.id, true, `   ✅ imprimée via ${moteur} sur "${IMPRIMANTE}" (${Math.round(fs.statSync(fichier).size / 1024)} Ko)`);
        delete etat.echecs[cmd.id];
      } catch (e) {
        etat.echecs[cmd.id] = nbEchecs + 1;
        log(`   ❌ échec ${etat.echecs[cmd.id]}/${MAX_ECHECS} pour ${cmd.id} : ${e.message}`);
        if (etat.echecs[cmd.id] >= MAX_ECHECS) log(`   ⛔ ${cmd.id} abandonnée après ${MAX_ECHECS} échecs — à imprimer à la main (bouton Réimprimer dans l'app)`);
      }
    }
  } catch (e) {
    log(`⚠️ tour interrompu : ${e.message}`);
  } finally {
    ecrireEtat(etat);
    enCours = false;
  }
}

log(`Agent d'impression GLS démarré — imprimante "${IMPRIMANTE}", moteur ${moteurImpression()?.nom || 'AUCUN'}, étiquettes depuis le ${DATE_MISE_EN_SERVICE}, toutes les ${INTERVALLE_MS / 1000} s`);
if (process.argv.includes('--une-fois')) {
  tour().then(() => process.exit(0));
} else {
  tour();
  setInterval(tour, INTERVALLE_MS);
}
