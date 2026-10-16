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
// Secrets   : lus dans ..\.env (SUPABASE_URL, PRINT_AGENT_SUPABASE_KEY)
// ════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

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
// 27/09/2026 : clé secrète DÉDIÉE à l'agent (révocable seule dans Supabase → Settings → API Keys → « print_agent »).
// Repli sur SUPABASE_SERVICE_ROLE_KEY (clé « scripts_locaux ») si la variable dédiée est absente.
const CLE = ENV.PRINT_AGENT_SUPABASE_KEY || ENV.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !CLE) throw new Error('SUPABASE_URL / PRINT_AGENT_SUPABASE_KEY manquants dans .env');

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
// 16/10/2026 : enquête sur les « tours interrompus » (1 à 6 par jour début octobre,
// 22 à 45 par jour ensuite, avec des trous de 16 à 33 min sans impression).
// Ce n'est NI la veille du PC (désactivée sur secteur), NI le Wi-Fi (Windows
// n'enregistre quasi aucune déconnexion, et la liaison mesurée est à 0 % de perte) :
// Node réutilise ses connexions réseau. Quand le serveur a fermé une connexion restée
// inactive, la requête suivante part sur une ligne morte -> ECONNRESET / UND_ERR_SOCKET,
// ou attente jusqu'au délai maximum. Un simple nouvel essai repart sur une connexion neuve.
const DELAI_REQUETE_MS = 20000; // 45 s était trop long : un appel mort bloquait le tour
const ESSAIS_RESEAU = 3;
const STATS_RESEAU = { reprises: 0, echecs: 0 };
function estErreurReseau(e) {
  if (!e) return false;
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return true;
  const codes = [e.code, e.cause && e.cause.code, e.cause && e.cause.name].filter(Boolean).map(String);
  if (codes.some((c) => ['ECONNRESET', 'UND_ERR_SOCKET', 'ECONNABORTED', 'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE'].includes(c))) return true;
  return /fetch failed|terminated|socket hang up/i.test(e.message || '');
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function rest(chemin, options = {}) {
  let derniere = null;
  for (let essai = 1; essai <= ESSAIS_RESEAU; essai++) {
    // 16/10/2026 : minuteur explicite (et annulé) au lieu de AbortSignal.timeout, qui
    // laissait un compteur en suspens -> Node s'arrêtait en erreur interne à la sortie
    // (assertion libuv) quand l'agent se terminait pendant une requête.
    const ctrl = new AbortController();
    const minuteur = setTimeout(() => ctrl.abort(Object.assign(new Error('délai de ' + (DELAI_REQUETE_MS / 1000) + ' s dépassé'), { name: 'TimeoutError' })), DELAI_REQUETE_MS);
    try {
      const rep = await fetch(`${SUPABASE_URL}/rest/v1/${chemin}`, {
        ...options,
        signal: ctrl.signal,
        headers: { ...ENTETES, ...(options.headers || {}) },
      }).finally(() => clearTimeout(minuteur));
      if (!rep.ok) throw new Error(`Supabase ${rep.status} ${rep.statusText} — ${chemin.slice(0, 120)} — ${(await rep.text()).slice(0, 200)}`);
      if (essai > 1) STATS_RESEAU.reprises++; // réussi grâce au nouvel essai
      return rep;
    } catch (e) {
      clearTimeout(minuteur);
      derniere = e;
      // on ne réessaie que les incidents réseau, et jamais un POST (risque de doublon) ;
      // l'agent n'envoie que des GET et un PATCH d'horodatage, rejouable sans risque.
      const methode = String(options.method || 'GET').toUpperCase();
      if (!estErreurReseau(e) || methode === 'POST' || essai === ESSAIS_RESEAU) break;
      await pause(1500 * essai);
    }
  }
  STATS_RESEAU.echecs++;
  throw derniere;
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
// 29/09/2026 : l'impression était lancée en spawnSync — donc BLOQUANTE. Le 29/09 à 10h09
// le PowerShell d'impression a disparu sans rendre la main : spawnSync n'est jamais
// revenu (son délai de 5 min n'a rien tué), l'agent est resté figé, et comme le chien de
// garde est un timer, il ne pouvait pas se déclencher non plus (boucle d'événements
// bloquée) — la surveillance externe ne voyait qu'un process node bien vivant.
// Désormais : spawn ASYNCHRONE + arrêt forcé de l'arbre de processus (taskkill /T /F).
// L'agent garde la main, donc le chien de garde peut faire son travail.
const DELAI_IMPRESSION_MS = 300000; // 5 min (PC chargé = rendu PDF lent)
function imprimerPdf(fichier) {
  if (!moteurImpression()) return Promise.reject(new Error(`Script d'impression introuvable : ${SCRIPT_IMPRESSION}`));
  return new Promise((resolve, reject) => {
    const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_IMPRESSION, '-Fichier', fichier, '-Imprimante', IMPRIMANTE], { windowsHide: true });
    let sortie = '';
    let fini = false;
    p.stdout.on('data', (d) => { sortie += d; });
    p.stderr.on('data', (d) => { sortie += d; });
    const terminer = (fn, arg) => { if (fini) return; fini = true; clearTimeout(minuteur); clearTimeout(grace); fn(arg); };
    // Un petit-fils qui garde le tuyau ouvert empêcherait 'close' : on se base sur 'exit'
    // (déclenché dès que le processus se termine) avec 2 s pour ramasser la sortie.
    let grace = null;
    p.on('exit', (code) => {
      grace = setTimeout(() => {
        const txt = sortie.trim();
        if (code !== 0 || !/^OK /m.test(txt)) return terminer(reject, new Error(`impression Windows code ${code} : ${txt.slice(0, 300)}`));
        log(`   ${txt.split(/\r?\n/).find((l) => l.startsWith('OK '))}`);
        terminer(resolve, 'Windows natif');
      }, 2000);
    });
    p.on('error', (e) => terminer(reject, e));
    const minuteur = setTimeout(() => {
      try { spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true }); } catch (_e) { /* rien */ }
      // Si même 'exit' n'arrive pas après le taskkill, on abandonne quand même.
      setTimeout(() => terminer(reject, new Error(`impression bloquée plus de ${DELAI_IMPRESSION_MS / 60000} min — processus arrêté de force`)), 10000);
    }, DELAI_IMPRESSION_MS);
  });
}

// ── Boucle principale ───────────────────────────────────────────────
// Chien de garde (20/09/2026) : si plus aucune lecture de la base ne réussit
// pendant 15 min, l'agent s'arrête et lancer-agent.cmd le redémarre (20 s).
const CHIEN_DE_GARDE_MS = 15 * 60000;
let dernierSucces = Date.now();
let enCours = false;
async function tour() {
  if (enCours) return;
  enCours = true;
  const etat = lireEtat();
  try {
    const cmds = await listerAImprimer();
    dernierSucces = Date.now();
    etat.derniere_verif = new Date().toISOString();
    for (const cmd of cmds) {
      etat.dernier_echec = etat.dernier_echec || {};
      let nbEchecs = etat.echecs[cmd.id] || 0;
      if (nbEchecs >= MAX_ECHECS) {
        // 21/09/2026 : une commande abandonnée n'était plus jamais réessayée → nouvelle
        // série de tentatives 30 min après le dernier échec (souvent un ralentissement passager).
        const depuis = Date.now() - (etat.dernier_echec[cmd.id] || 0);
        if (depuis < 30 * 60000) continue;
        log(`   ↻ nouvelle série de tentatives pour ${cmd.id} (dernier échec il y a ${Math.round(depuis / 60000)} min)`);
        nbEchecs = 0;
      }
      const nbColis = String(cmd.tracking_transporteur).split(',').filter(Boolean).length;
      log(`→ ${cmd.id} ${cmd.client || ''} — ${nbColis} colis (${cmd.tracking_transporteur}) — étiquette du ${cmd.gls_date_etiquette}`);
      try {
        const b64 = await recupererPdf(cmd.id);
        if (!b64) { log(`   PDF absent en base pour ${cmd.id}, réessai au prochain tour`); continue; }
        const fichier = path.join(DOSSIER_SPOOL, `GLS_${cmd.id.replace(/[^A-Za-z0-9_-]/g, '')}.pdf`);
        fs.writeFileSync(fichier, Buffer.from(b64, 'base64'));
        const moteur = await imprimerPdf(fichier);
        await marquerImprimee(cmd.id, true, `   ✅ imprimée via ${moteur} sur "${IMPRIMANTE}" (${Math.round(fs.statSync(fichier).size / 1024)} Ko)`);
        delete etat.echecs[cmd.id];
      } catch (e) {
        etat.echecs[cmd.id] = nbEchecs + 1;
        etat.dernier_echec[cmd.id] = Date.now();
        log(`   ❌ échec ${etat.echecs[cmd.id]}/${MAX_ECHECS} pour ${cmd.id} : ${e.message}`);
        if (etat.echecs[cmd.id] >= MAX_ECHECS) log(`   ⛔ ${cmd.id} abandonnée après ${MAX_ECHECS} échecs — à imprimer à la main (bouton Réimprimer dans l'app)`);
      }
    }
  } catch (e) {
    const cause = e?.cause?.code || e?.cause?.message || '';
    log(`⚠️ tour interrompu : ${e.message}${cause ? ' (' + cause + ')' : ''}`);
  } finally {
    // 16/10/2026 : bilan réseau d'un jour sur l'autre, écrit une seule fois par jour
    // (avant, chaque incident faisait une ligne : jusqu'à 45 par jour dans le journal).
    const jour = new Date().toISOString().slice(0, 10);
    if (etat.reseau && etat.reseau.jour && etat.reseau.jour !== jour) {
      log(`📶 bilan réseau du ${etat.reseau.jour} : ${etat.reseau.reprises || 0} incident(s) rattrapé(s) au 2e essai, ${etat.reseau.echecs || 0} tour(s) perdu(s)`);
      STATS_RESEAU.reprises = 0; STATS_RESEAU.echecs = 0;
    }
    etat.reseau = { jour, reprises: STATS_RESEAU.reprises, echecs: STATS_RESEAU.echecs };
    ecrireEtat(etat);
    enCours = false;
  }
}

log(`Agent d'impression GLS démarré — imprimante "${IMPRIMANTE}", moteur ${moteurImpression()?.nom || 'AUCUN'}, étiquettes depuis le ${DATE_MISE_EN_SERVICE}, toutes les ${INTERVALLE_MS / 1000} s`);
if (process.argv.includes('--une-fois')) {
  // 16/10/2026 : on ne force plus la sortie (process.exit coupait pendant la fermeture des
  // connexions -> « Assertion failed … uv_handle » de Node, déjà présent avant). On pose le
  // code de sortie et on laisse Node se terminer proprement quelques secondes plus tard.
  tour().then(() => { process.exitCode = 0; });
} else {
  tour();
  setInterval(tour, INTERVALLE_MS);
  setInterval(() => {
    const minutes = Math.round((Date.now() - dernierSucces) / 60000);
    if (Date.now() - dernierSucces > CHIEN_DE_GARDE_MS) {
      log(`⛔ aucune lecture réussie depuis ${minutes} min — redémarrage de l'agent`);
      process.exit(1);
    }
  }, 60000);
}
