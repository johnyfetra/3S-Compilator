# 3S Compilator

Éditeur et exécuteur de code en ligne, gratuit, aux couleurs de **SAMSRIAH School (3S)**.
On écrit du code, on l'exécute, on répond aux questions du programme **directement dans la console**, et on peut le suivre **ligne par ligne** en voyant les variables
évoluer (mode « Pas à pas », pour tous les langages).

## Langages

| Langage | Moteur (exécuté dans le navigateur) | Pas à pas |
|---|---|---|
| JavaScript | Web Worker isolé, code instrumenté avec [acorn](https://github.com/acornjs/acorn) | oui |
| Python 3.13 | [Pyodide](https://pyodide.org) 0.29.5 (`sys.settrace`) | oui |
| PHP 8.4 | [php-wasm](https://github.com/seanmorris/php-wasm) 0.2.0 (`declare(ticks=1)`) | oui (variables globales et paramètres) |
| C et C++ | [JSCPP](https://github.com/felixhao28/JSCPP) 2.0.9 (débogueur intégré) | oui |
| Algorithme | Interpréteur maison `js/engines/pseudocode.js` | oui |

Tout s'exécute **dans le navigateur de l'élève** : aucun serveur d'exécution, aucun quota,
aucune clé API. Après une première visite, le service worker garde l'application et les moteurs
en cache : l'outil fonctionne ensuite **hors ligne**.

## Lancer en local

```bash
cp .env.example .env   # puis remplir ADMIN_PASSWORD et SESSION_SECRET
npm install
npm start              # http://localhost:8080  (espace enseignant : /admin)
```

Sans base de données, les devoirs sont enregistrés dans `data/db.json`. Ce mode convient aussi
à un serveur installé dans l'école (réseau local, sans internet).
Ne pas ouvrir `index.html` par double-clic : en `file://`, les workers et les modules sont bloqués.

## Enregistrement des devoirs et espace enseignant

- Un fichier = un exercice. Le bouton **Nouveau** ouvre un exercice vide.
- L'enseignant (ou le super admin) saisit la liste des élèves de chaque classe (bouton **Élèves**).
- L'élève clique sur **Enregistrer** (Ctrl+S), choisit sa classe, puis son nom dans la liste,
  puis nomme l'exercice. Une copie reste sur l'appareil ; l'exercice est envoyé au serveur.
  Un nouvel enregistrement met à jour le même exercice (jeton gardé par l'appareil).
- Le bimestre n'est pas demandé à l'élève : le serveur ajoute le bimestre en cours. Par défaut
  le bimestre I commence le 1er septembre et chaque bimestre dure deux mois ; le super admin peut
  fixer le bimestre en cours (réglages), le décompte repart alors de ce jour jusqu'à la rentrée.
- Bouton **Enseignant** (en haut à droite) ou adresse **/admin** pour se connecter.

| Rôle | Connexion | Droits |
|---|---|---|
| Super admin | `ADMIN_USERNAME` / `ADMIN_PASSWORD` du fichier `.env` | tous les devoirs, gestion des professeurs, des classes et des bimestres |
| Professeur | compte créé par le super admin | uniquement les exercices et les élèves de **ses** classes (liste des élèves, exercices d'un élève, lecture, exécution, téléchargement, suppression) |

Les devoirs sont rangés automatiquement par classe puis par bimestre. Un professeur qui demande
un devoir d'une autre classe reçoit « introuvable », même en appelant l'API directement.

| Variable | Rôle |
|---|---|
| `ADMIN_USERNAME` | identifiant du super admin (par défaut `admin`) |
| `ADMIN_PASSWORD` | mot de passe du super admin (8 caractères minimum) |
| `SESSION_SECRET` | clé de signature des sessions (16 caractères minimum) |
| `DATABASE_URL` | PostgreSQL (Supabase, Neon…) ; sans elle, fichier `data/db.json` |

Sécurité : mots de passe des professeurs hachés (scrypt), comparaison en temps constant, 5 essais
puis blocage de 15 minutes, cookie `HttpOnly` + `SameSite=Strict`, sessions fermées quand le mot de
passe change ou que le compte est supprimé, validation de toutes les entrées, RLS activé sur les
tables PostgreSQL (rien n'est lisible avec la clé publique de Supabase).

### Base de données Supabase

1. Créer un projet sur https://supabase.com/dashboard (choisir un mot de passe de base de données).
2. Bouton **Connect** du projet, onglet **ORMs / Connection string**, mode **Transaction pooler**
   (port 6543), puis remplacer `[YOUR-PASSWORD]` par le mot de passe choisi.
3. Coller cette adresse dans `DATABASE_URL` (fichier `.env` en local, variables du projet sur Vercel).
4. Relancer `npm start` : les tables `settings`, `submissions` et `teachers` sont créées automatiquement.

## Tests

```bash
npm test   # interpréteur Algorithme, instrumentation JavaScript, API et droits d'accès
node scripts/build-jscpp.mjs   # reconstruit vendor/jscpp (après une mise à jour de JSCPP)
```

## Architecture

```
index.html                 Compilateur
admin.html                 Espace enseignant (js/admin.js)
api/_lib/                  Backend : api.js (routes), store.js (fichier JSON ou PostgreSQL), auth.js
api/index.js               Point d'entrée Vercel du backend
server/index.js            Serveur local (npm start) : site + API
css/style.css              Thèmes clair et sombre (bleu et rouge de l'école)
js/app.js                  Point d'entrée : assemble les modules
js/languages.js            Registre des langages (icône, fichier, exemple, worker)
js/editor.js               Monaco (éditeur de VS Code), repli sur <textarea> hors ligne
js/output.js               Console : sortie groupée, erreurs au format console réel
js/runner.js               Workers : un par langage, arrêt et limite de 10 s
js/stepper.js              Lecteur de trace du pas à pas (avant, arrière, variables)
js/store.js                Enregistrement du travail (navigateur aujourd'hui, API demain)
js/engines/                Code pur, testable dans Node : pseudocode, instrumentation JS
js/workers/                Un worker par moteur, même protocole (voir shared.js)
vendor/                    acorn et JSCPP (fichiers locaux, licences incluses)
sw.js                      Cache hors ligne
tests/                     Tests node:test (moteurs et API)
electron/main.js           Version bureau (plus tard)
```

**Ajouter un langage** : une entrée dans `js/languages.js`, un worker dans `js/workers/`
qui respecte le protocole décrit en tête de `js/workers/shared.js`, et une icône dans `assets/icons/`.

**Pas à pas** : le worker exécute tout le programme une fois et enregistre une « trace »
(au plus 5 000 étapes). Chaque étape contient la ligne qui va s'exécuter, les variables et la
longueur de la sortie. L'interface rejoue cette trace : on peut donc avancer **et reculer**.

## Limites connues

- C/C++ : JSCPP couvre un sous-ensemble pédagogique. `std::string` et `<vector>` ne sont pas
  disponibles. Bibliothèques : iostream, iomanip, cmath, cstdio, cstdlib, cstring, cctype, ctime.
- PHP : le pas à pas montre les variables globales et les paramètres des fonctions, pas les
  variables locales. Premier chargement d'environ 12 Mo.
- La saisie dans la console (input, prompt, LIRE, cin, scanf, fgets) demande les en-têtes
  COOP/COEP envoyés par `npm start`, Vercel et Electron (pas par `python3 -m http.server`).
- Python et PHP demandent internet au premier lancement, puis restent en cache.

## Déploiement (Vercel)

Le site est statique et `api/index.js` devient une fonction. Il faut une base PostgreSQL
(`DATABASE_URL`) et les variables `ADMIN_PASSWORD` et `SESSION_SECRET` dans le projet Vercel.

```bash
vercel        # aperçu
vercel --prod # production
```

Penser à changer `VERSION` dans `sw.js` à chaque mise en ligne.

## Version bureau

`electron/main.js` sert les fichiers via un protocole `app://`. Electron 23 et suivants ne
fonctionnent plus sur Windows 7 et 8 : pour ces postes, il faudrait figer Electron 22 (qui ne
reçoit plus de correctifs de sécurité).

## Licences des dépendances

acorn (MIT), JSCPP (MIT), icônes [Devicon](https://devicon.dev) (MIT), Pyodide (MPL-2.0),
php-wasm (Apache-2.0 / GPL-2.0), Monaco Editor (MIT).
