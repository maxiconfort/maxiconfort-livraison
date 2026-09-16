// ════════════════════════════════════════════════════════════════════
// MAXICONFORT — Agent d'impression automatique des étiquettes GLS
// ════════════════════════════════════════════════════════════════════
// Tourne en permanence sur le PC du bureau (tâche Windows au démarrage).
// Toutes les 15 s : cherche dans Supabase les commandes GLS dont
// l'étiquette vient d'être créée (tracking rempli, PDF présent) et pas
// encore imprimée (gls_etiquette_imprimee_at NULL), imprime le PDF sur
// l'imprimante thermique Phomemo PM-344-WF, puis marque la commande.
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
const { spawn, spawnSync, execFileSync } = require('child_process');

// ── Réglages ────────────────────────────────────────────────────────
const IMPRIMANTE = process.env.IMPRIMANTE_GLS || 'PM-344-WF (WiFi)';
const DATE_MISE_EN_SERVICE = process.env.DATE_MISE_EN_SERVICE || '2026-09-16'; // étiquettes plus anciennes ignorées
const INTERVALLE_MS = Number(process.env.INTERVALLE_MS || 15000);
const MAX_ECHECS = 3;

const RACINE = path.resolve(__dirname, '..');
const DOSSIER_SPOOL = path.join(__dirname, 'spool');
const DOSSIER_JOURNAL = path.join(__dirname, 'journal');
const FICHIER_ETAT = path.join(__dirname, 'etat.json');
const SUMATRA = path.join(__dirname, 'bin', 'SumatraPDF.exe');
const ACROBAT_CANDIDATS = [
  'C:\\Program Files\\Adobe\\Acrobat DC\\Acrobat\\Acrobat.exe',
  'C:\\Program Files (x86)\\Adobe\\Acrobat DC\\Acrobat\\Acrobat.exe',
  'C:\\Program Files (x86)\\Adobe\\Acrobat Reader DC\\Reader\\AcroRd32.exe',
];

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

// ── Impression ──────────────────────────────────────────────────────
function moteurImpression() {
  if (fs.existsSync(SUMATRA)) return { nom: 'SumatraPDF', exe: SUMATRA };
  const acro = ACROBAT_CANDIDATS.find((p) => fs.existsSync(p));
  if (acro) return { nom: 'Acrobat', exe: acro };
  return null;
}
function imprimerPdf(fichier) {
  const moteur = moteurImpression();
  if (!moteur) throw new Error('Aucun moteur d\'impression : placer SumatraPDF.exe dans print-agent\\bin ou installer Adobe Acrobat');
  if (moteur.nom === 'SumatraPDF') {
    // -silent : pas de fenêtre ; -print-settings fit : ajuste 100x150 → 4x6" ; ferme à la fin
    const r = spawnSync(moteur.exe, ['-print-to', IMPRIMANTE, '-print-settings', 'fit', '-silent', '-exit-when-done', fichier], { timeout: 120000 });
    if (r.status !== 0) throw new Error(`SumatraPDF code ${r.status} ${String(r.stderr || '').slice(0, 200)}`);
    return moteur.nom;
  }
  // Acrobat : /t <fichier> <imprimante> = impression silencieuse. Acrobat ne se ferme pas tout seul
  // → lancement détaché (sans attendre sa fin), surveillance de la file Windows, puis fermeture forcée.
  const enfant = spawn(moteur.exe, ['/t', fichier, IMPRIMANTE], { detached: true, stdio: 'ignore' });
  enfant.unref();
  const debut = Date.now();
  let travailVu = false, travailFini = false;
  while (Date.now() - debut < 45000) {
    pause(1000);
    const n = travauxEnAttente();
    if (n > 0) travailVu = true;
    else if (travailVu) { travailFini = true; break; }
    if (!travailVu && Date.now() - debut > 20000) break; // petit PDF déjà parti entre deux sondages, ou Acrobat muet
  }
  try { execFileSync('taskkill', ['/IM', 'Acrobat.exe', '/F'], { stdio: 'ignore' }); } catch { /* déjà fermé */ }
  log(`   spouleur : travail ${travailVu ? (travailFini ? 'vu puis transmis à l\'imprimante' : 'vu, encore en cours') : 'non observé (transmis trop vite ou échec silencieux)'} en ${Math.round((Date.now() - debut) / 1000)} s`);
  return moteur.nom;
}
// Pause synchrone sans dépendance
function pause(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function travauxEnAttente() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-PrintJob -PrinterName '${IMPRIMANTE.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Measure-Object).Count`], { encoding: 'utf8', timeout: 20000 });
    return Number(out.trim()) || 0;
  } catch { return 0; }
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
