// ════════════════════════════════════════════════════════════════════
// Vérification GLS « en direct » avant une demande d'avis (28/09/2026)
// ════════════════════════════════════════════════════════════════════
// Les commandes GLS déjà « livré » ne sont plus scannées par gls-sync :
// leur gls_livraison_etat peut être vide alors que GLS montre une
// livraison partielle ou un retour (faux « livré » d'avant la v15).
// Juste avant d'envoyer une demande/relance d'avis à un client GLS, on
// relit donc ses colis chez GLS : partiel / retour / non pris en charge
// → pas de demande. v2.1 (02/10/2026) : verdict dans avis-garde.ts motifGls()
// (testé) ; colis jamais scanné, sans n° de colis, ou GLS illisible alors que
// la base ne dit pas « livre » → pas de demande (réessai au cron suivant).
// Lecture seule : aucune écriture en base.
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { suivreColisGLS } from './gls-suivi.ts';
import { analyserColis, analyserCommande, colisErreur, numerosColis } from './gls-analyse.ts';
import { motifGls } from './avis-garde.ts';

export async function livraisonGlsContestee(c: any): Promise<string | null> {
  if (!/gls/i.test(String(c.transporteur || ''))) return null;
  const ids = numerosColis(c.tracking_transporteur);
  if (!ids.length) return motifGls(null, c);
  const colis = [];
  for (const t of ids) {
    const r = await suivreColisGLS(t);
    colis.push(r.ok ? analyserColis(t, r.data) : colisErreur(t, r.erreur));
  }
  return motifGls(analyserCommande(colis), c);
}
