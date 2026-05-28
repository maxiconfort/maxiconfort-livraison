# Maxiconfort Livraison Pro

PWA de gestion des tournees et livraisons Maxiconfort Ile-de-France.

URL prod : https://livraison.maxiconfort.fr

## Stack

- Frontend monolithe : `maxiconfort-v7.html` (vanilla JS, ~12 000 lignes)
- Backend / DB : Supabase (16 tables, realtime sur commandes, tournees, depenses, produits, gps_positions)
- Cartographie : Leaflet + OpenStreetMap
- SMS : Brevo (via Supabase Edge Function)
- PWA : `manifest.json` + `service-worker.js` (cache offline, GPS background)

## Roles (PIN code)

- **Admin** : tout
- **CV** (chef vehicule) : gestion tournees
- **LV** (livreur) : interface mobile, SAS demarrage, signature, paie

## Modules

Dashboard - Commandes - Tournees - Livreur (mobile) - Finance - Optimisation - Notifications/SMS - GPS - Stock camion - Parametres

## Arborescence

```
index.html               Redirection vers maxiconfort-v7.html
maxiconfort-v7.html      Application principale
manifest.json            PWA manifest
service-worker.js        Cache offline + GPS background
favicon.png              Favicon
icon-180/192/512.png     Icones PWA
CNAME                    livraison.maxiconfort.fr
```

## Deploiement

GitHub Pages branch `main`, domaine custom via `CNAME`.
Chaque push sur `main` redeploie automatiquement (30s a 3 min).

## Version

v7.1.7
