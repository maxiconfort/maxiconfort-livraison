-- ════════════════════════════════════════════════════════════════════
-- Migration 005 : Uniformisation noms + dimensions produits
-- ════════════════════════════════════════════════════════════════════
-- DATE : 2026-05-28
-- BUT  : Standardiser la casse (Title Case) et les dimensions
--        (140X190 → 140×190) sur tout le catalogue produits.
--
-- Regles appliquees :
--   1. Dimensions : tout "x" ou "X" entre chiffres → "×" (typo correct)
--   2. Casse : Title Case (1ere lettre majuscule, reste minuscule)
--   3. Marques en MAJUSCULES : DODOCONFORT, OEKO-TEX, PU, DUO, NICO
--   4. Petits mots en minuscules : de, et, du, la, le, +
--   5. Unites en minuscules : cm, mm, ep.
--   6. Espaces : pas de double, espace propre apres "+"
-- ════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────
-- PARTIE 1 : PREVIEW (SELECT seulement — change rien)
-- Decommenter et executer cette partie pour voir le resultat avant
-- ────────────────────────────────────────────────────────────────────
/*
SELECT
  id,
  nom AS nom_actuel,
  -- Calcul du nom uniformise (sans modifier la BD)
  TRIM(REGEXP_REPLACE(
    REGEXP_REPLACE(
      REGEXP_REPLACE(
        REGEXP_REPLACE(
          REGEXP_REPLACE(
            REPLACE(
              REPLACE(
                INITCAP(
                  REGEXP_REPLACE(
                    REGEXP_REPLACE(nom, '([0-9])[xX]([0-9])', '\1×\2', 'g'),
                    '([0-9])[xX]([0-9])', '\1×\2', 'g'
                  )
                ),
                'Dodoconfort', 'DODOCONFORT'
              ),
              'Oeko-Tex', 'OEKO-TEX'
            ),
            '\m(Pu|Duo|Nico|Tpe|Cb|Tva)\M', UPPER('\1'), 'g'
          ),
          '\m(Cm|Mm)\M', LOWER('\1'), 'g'
        ),
        'Ép\.', 'ép.', 'g'
      ),
      '\m(De|Et|Du|La|Le|En)\M', LOWER('\1'), 'g'
    ),
    ' +', ' ', 'g'
  )) AS nom_uniformise
FROM produits
WHERE actif=true
ORDER BY cat, nom;
*/

-- ────────────────────────────────────────────────────────────────────
-- PARTIE 2 : APPLICATION (UPDATE — modifie la BD)
-- Decommenter et executer cette partie une fois le preview valide
-- ────────────────────────────────────────────────────────────────────

-- Etape 1 : Dimensions x/X entre chiffres → × (2 passes pour les triples)
UPDATE produits SET nom = REGEXP_REPLACE(nom, '([0-9])[xX]([0-9])', '\1×\2', 'g');
UPDATE produits SET nom = REGEXP_REPLACE(nom, '([0-9])[xX]([0-9])', '\1×\2', 'g');
UPDATE produits SET dim = REGEXP_REPLACE(dim, '([0-9])[xX]([0-9])', '\1×\2', 'g');
UPDATE produits SET dim = REGEXP_REPLACE(dim, '([0-9])[xX]([0-9])', '\1×\2', 'g');

-- Etape 2 : INITCAP (Title Case)
UPDATE produits SET nom = INITCAP(nom);

-- Etape 3 : Marques et acronymes en MAJUSCULES
UPDATE produits SET nom = REPLACE(nom, 'Dodoconfort', 'DODOCONFORT');
UPDATE produits SET nom = REPLACE(nom, 'Oeko-Tex', 'OEKO-TEX');
UPDATE produits SET nom = REGEXP_REPLACE(nom, '\mPu\M', 'PU', 'g');
UPDATE produits SET nom = REGEXP_REPLACE(nom, '\mDuo\M', 'DUO', 'g');
UPDATE produits SET nom = REGEXP_REPLACE(nom, '\mNico\M', 'NICO', 'g');

-- Etape 4 : Unites en minuscules
UPDATE produits SET nom = REGEXP_REPLACE(nom, '\mCm\M', 'cm', 'g');
UPDATE produits SET nom = REGEXP_REPLACE(nom, '\mMm\M', 'mm', 'g');
UPDATE produits SET nom = REPLACE(nom, 'Ép.', 'ép.');

-- Etape 5 : Petits mots en minuscules
UPDATE produits SET nom = REGEXP_REPLACE(nom, '\mDe\M', 'de', 'g');
UPDATE produits SET nom = REGEXP_REPLACE(nom, '\mDu\M', 'du', 'g');
UPDATE produits SET nom = REGEXP_REPLACE(nom, '\mEt\M', 'et', 'g');
UPDATE produits SET nom = REGEXP_REPLACE(nom, '\mLa\M', 'la', 'g');
UPDATE produits SET nom = REGEXP_REPLACE(nom, '\mLe\M', 'le', 'g');
UPDATE produits SET nom = REGEXP_REPLACE(nom, '\mEn\M', 'en', 'g');
UPDATE produits SET nom = REGEXP_REPLACE(nom, '\mA\M', 'à', 'g');  -- "A Lattes" → "à lattes"

-- Etape 6 : Espaces et ponctuation
UPDATE produits SET nom = REGEXP_REPLACE(nom, ' +', ' ', 'g');
UPDATE produits SET nom = TRIM(nom);
UPDATE produits SET nom = REGEXP_REPLACE(nom, '\+Matelas', '+ Matelas', 'g');
UPDATE produits SET nom = REGEXP_REPLACE(nom, '\+Sommier', '+ Sommier', 'g');
UPDATE produits SET nom = REGEXP_REPLACE(nom, '\+ Matelas', '+ Matelas', 'g'); -- normalisation

-- Etape 7 : Premier mot toujours en majuscule (au cas ou)
UPDATE produits SET nom = INITCAP(SUBSTRING(nom,1,1)) || SUBSTRING(nom,2) WHERE nom !~ '^[A-Z]';

-- Verification finale
SELECT id, nom, dim, cat, stock FROM produits WHERE actif=true ORDER BY cat, nom;
