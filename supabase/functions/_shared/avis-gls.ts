// ════════════════════════════════════════════════════════════════════
// Vérification GLS « en direct » avant une demande d'avis (28/09/2026)
// ════════════════════════════════════════════════════════════════════
// Les commandes GLS déjà « livré » ne sont plus scannées par gls-sync :
// leur gls_livraison_etat peut être vide alors que GLS montre une
// livraison partielle ou un retour (faux « livré » d'avant la v15).
// Juste avant d'envoyer une demande/relance d'avis à un client GLS, on
// relit donc ses colis chez GLS : partiel / retour / non pris en charge
// → pas de demande. Si GLS ne répond pas (historique expiré ~60 j) : on
// se fie à gls_livraison_etat (pas de blocage supplémentaire).
// Lecture seule : aucune écriture en base.
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { suivreColisGLS } from './gls-suivi.ts';
import { analyserColis, analyserCommande, colisErreur, numerosColis } from './gls-analyse.ts';

export async function livraisonGlsContestee(c: any): Promise<string | null> {
  if (!/gls/i.test(String(c.transporteur || ''))) return null;
  const ids = numerosColis(c.tracking_transporteur);
  if (!ids.length) return null;
  const colis = [];
  for (const t of ids) {
    const r = await suivreColisGLS(t);
    colis.push(r.ok ? analyserColis(t, r.data) : colisErreur(t, r.erreur));
  }
  const a = analyserCommande(colis);
  if (a.etat === 'livre' || a.etat === 'erreur') return null;
  return `GLS ${a.etat} (${a.detail})`;
}
