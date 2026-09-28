// Tests unitaires de supabase/functions/_shared/gls-analyse.ts
// Lancer : node --test supabase/tests/   (Node >= 22.6, types TypeScript retirés automatiquement)
// Historiques construits sur le modèle réel ShipIT-FARM (aucune donnée client).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyserColis, analyserCommande, colisErreur, numerosColis, exclusionSansScan,
} from '../functions/_shared/gls-analyse.ts';

const ev = (Date, StatusCode, Description, LocationCode = 'FR0093', Location = 'GARONOR GLS France FR0093') =>
  ({ Date, StatusCode, Description, LocationCode, Location });
const colis = (zip, History, Service = []) => ({ UnitDetail: { Consignee: { Address: { ZIPCode: zip, CountryCode: 'FR' } }, Service, History } });

const CREE = ev('2026-09-01T10:00:00+02:00', 'DATA_RECEIVED', 'The parcel data was entered into the GLS IT system; the parcel was not yet handed over to GLS.');
const REMIS = ev('2026-09-01T17:00:00+02:00', 'HUB', 'The parcel was handed over to GLS.');
const DEPOT_DEST = ev('2026-09-02T06:00:00+02:00', 'DELIVERY_DEPOT', 'The parcel has reached the parcel center.', 'FR0069', 'Lyon FR0069');
const EN_LIV = ev('2026-09-02T07:30:00+02:00', 'IN_DELIVERY', 'The parcel is expected to be delivered during the day.', 'FR0069', 'Lyon FR0069');
const LIVRE = ev('2026-09-02T11:15:00+02:00', 'DELIVERED', 'The parcel has been delivered.', 'FR0069', 'Lyon FR0069');

test('livré simple : 1 colis livré au client', () => {
  const a = analyserColis('00TEST01', colis('69003', [CREE, REMIS, DEPOT_DEST, EN_LIV, LIVRE]));
  assert.equal(a.etat, 'livre');
  assert.equal(a.livreClient, true);
  assert.equal(a.priseEnCharge, true);
  assert.equal(a.priseEnChargeAt, new Date('2026-09-01T17:00:00+02:00').toISOString());
  const c = analyserCommande([a]);
  assert.equal(c.etat, 'livre');
  assert.equal(c.dateLivraison, '2026-09-02');
});

test('étiquette jamais remise à GLS : seulement DATA_RECEIVED', () => {
  const a = analyserColis('00TEST02', colis('69003', [CREE]));
  assert.equal(a.etat, 'donnees_seules');
  assert.equal(a.priseEnCharge, false);
  assert.equal(a.creationAt, new Date('2026-09-01T10:00:00+02:00').toISOString());
  assert.equal(analyserCommande([a]).etat, 'non_pris_en_charge');
});

test('multi-colis : tous livrés → livré (date = dernier colis)', () => {
  const l2 = ev('2026-09-03T09:00:00+02:00', 'DELIVERED', 'The parcel has been delivered / dropped off.', 'FR0069', 'Lyon FR0069');
  const a = analyserColis('00TEST03', colis('69003', [CREE, REMIS, DEPOT_DEST, LIVRE]));
  const b = analyserColis('00TEST04', colis('69003', [CREE, REMIS, DEPOT_DEST, l2]));
  const c = analyserCommande([a, b]);
  assert.equal(c.etat, 'livre');
  assert.equal(c.nbLivres, 2);
  assert.equal(c.dateLivraison, '2026-09-03');
});

test('multi-colis partiel : 2/3 livrés → partiel, jamais livré', () => {
  const a = analyserColis('00TEST05', colis('13001', [CREE, REMIS, LIVRE]));
  const b = analyserColis('00TEST06', colis('13001', [CREE, REMIS, LIVRE]));
  const c3 = analyserColis('00TEST07', colis('13001', [CREE]));
  const c = analyserCommande([a, b, c3]);
  assert.equal(c.etat, 'partiel');
  assert.equal(c.detail, 'livraison partielle 2/3');
  assert.equal(c.dateLivraison, null);
});

test('retour à l\'expéditeur puis « delivered » au dépôt Garonor → retour, non livré (cas #1561)', () => {
  const H = [
    CREE, REMIS,
    ev('2026-08-18T05:57:00+02:00', 'DELIVERY_DEPOT', 'The parcel has reached the parcel center.', 'FR0098', 'Frejus FR0098'),
    ev('2026-08-18T13:27:00+02:00', 'DELIVERY_DEPOT', 'The parcel could not be delivered as the consignee was absent.', 'FR0098', 'Frejus FR0098'),
    ev('2026-08-25T14:18:00+02:00', 'DELIVERY_DEPOT', 'The parcel has been returned to sender.', 'FR0098', 'Frejus FR0098'),
    ev('2026-08-27T06:12:00+02:00', 'HUB', 'The parcel has reached the parcel center.'),
    ev('2026-08-27T11:45:00+02:00', 'DELIVERED', 'The parcel has been delivered.'),
  ];
  const a = analyserColis('00TEST08', colis('83200', H));
  assert.equal(a.etat, 'retour');
  assert.equal(a.livreClient, false);
  assert.ok(a.livreExpediteurAt);
  const c = analyserCommande([a]);
  assert.equal(c.etat, 'retour');
  assert.notEqual(c.etat, 'livre');
});

test('« delivered » au dépôt d\'origine sans événement de retour, client hors IDF → retour', () => {
  const H = [CREE, REMIS, ev('2026-09-05T10:00:00+02:00', 'DELIVERED', 'The parcel has been delivered.')];
  const a = analyserColis('00TEST09', colis('33000', H));
  assert.equal(a.etat, 'retour');
});

test('client en Île-de-France livré depuis Garonor → livré (pas un retour)', () => {
  const H = [CREE, REMIS,
    ev('2026-09-02T08:54:00+02:00', 'HUB', 'Not delivered awaiting consignee pick up'),
    ev('2026-09-02T08:58:00+02:00', 'DELIVERED', 'The parcel has been delivered.')];
  const a = analyserColis('00TEST10', colis('93190', H));
  assert.equal(a.etat, 'livre');
});

test('ParcelShop : dépôt en relais = pas livré ; retrait (« delivered » simple) = livré', () => {
  const relais = [CREE, REMIS, DEPOT_DEST,
    ev('2026-09-02T11:12:00+02:00', 'DELIVERED', 'Parcel available at ParcelShop.', 'FR0069', 'Lyon FR0069'),
    ev('2026-09-02T11:13:00+02:00', 'DELIVERED', 'The parcel has been delivered at the ParcelShop (see ParcelShop information).', 'FR0069', 'Lyon FR0069')];
  assert.equal(analyserColis('00TEST11', colis('69003', relais)).etat, 'point_relais');
  const retire = [...relais, ev('2026-09-02T16:54:00+02:00', 'DELIVERED', 'The parcel has been delivered.', 'FR0069', 'Lyon FR0069')];
  assert.equal(analyserColis('00TEST11', colis('69003', retire)).etat, 'livre');
});

test('« could not be delivered » ne vaut pas livraison', () => {
  const H = [CREE, REMIS, ev('2026-09-02T13:00:00+02:00', 'DELIVERY_DEPOT', 'The parcel could not be delivered as the consignee was absent.', 'FR0069', 'Lyon FR0069')];
  assert.equal(analyserColis('00TEST12', colis('69003', H)).etat, 'transit');
});

test('service ShopReturn → retour', () => {
  const a = analyserColis('00TEST13', colis('69003', [CREE, REMIS, LIVRE], [{ Service: { ServiceName: 'service_shopreturn' } }]));
  assert.equal(a.etat, 'retour');
});

test('erreur API sur un colis → commande en erreur (aucune conclusion)', () => {
  const a = analyserColis('00TEST14', colis('69003', [CREE, REMIS, LIVRE]));
  const c = analyserCommande([a, colisErreur('00TEST15')]);
  assert.equal(c.etat, 'erreur');
});

test('ordre des événements non trié : tri par date', () => {
  const a = analyserColis('00TEST16', colis('69003', [LIVRE, REMIS, CREE]));
  assert.equal(a.etat, 'livre');
});

test('numerosColis découpe les listes', () => {
  assert.deepEqual(numerosColis('00L2QLV4, 00L2QLV5,00L2QLV6'), ['00L2QLV4', '00L2QLV5', '00L2QLV6']);
  assert.deepEqual(numerosColis(''), []);
});

test('mot-clé SANS SCAN OK', () => {
  assert.equal(exclusionSansScan('Commande site #1071'), null);
  assert.equal(exclusionSansScan('SANS SCAN OK (vu avec GLS le 28/09)'), 'tout');
  assert.deepEqual(exclusionSansScan('sans scan ok 00L2QLV5 etiquette fantome'), ['00L2QLV5']);
  assert.equal(exclusionSansScan('PAS D AVIS\nSANS-SCAN-OK'), 'tout');
});

test('« delivered » parasite à Garonor au moment de l\'enlèvement puis vraie livraison → livré (vu le 02/09)', () => {
  const H = [CREE,
    ev('2026-09-02T16:22:00+02:00', 'HUB', 'The parcel was handed over to GLS.'),
    ev('2026-09-02T16:22:00+02:00', 'DELIVERED', 'The parcel has been delivered.'),
    ev('2026-09-03T06:08:00+02:00', 'DELIVERY_DEPOT', 'The parcel has reached the parcel center.', 'FR0059', 'Lille FR0059'),
    ev('2026-09-03T09:57:00+02:00', 'DELIVERED', 'The parcel has been delivered.', 'FR0059', 'Lille FR0059')];
  const a = analyserColis('00TEST17', colis('59155', H));
  assert.equal(a.etat, 'livre');
  assert.equal(a.livreClientAt, new Date('2026-09-03T09:57:00+02:00').toISOString());
});

test('remise à GLS directement au dépôt de destination (Metz) puis livré → livré', () => {
  const H = [CREE,
    ev('2026-09-04T06:39:00+02:00', 'DELIVERY_DEPOT', 'The parcel was handed over to GLS.', 'FR0057', 'Metz FR0057'),
    ev('2026-09-15T11:08:00+02:00', 'DELIVERED', 'The parcel has been delivered.', 'FR0057', 'Metz FR0057')];
  assert.equal(analyserColis('00TEST18', colis('57280', H)).etat, 'livre');
});
