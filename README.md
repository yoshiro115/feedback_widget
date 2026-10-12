# Widget Grist « Retours & suggestions »

Un widget Grist personnalisé pour recueillir les retours d'une équipe : bugs et suggestions, groupés par statut (Nouveau / Vu / Traité), avec fil de réponses, pièces jointes (captures d'écran comprises), historique des modifications et filtres.

Fichiers : `index.html` + `widget.js` + `logo.webp` (le widget ; le logo se remplace ou se retire dans `index.html`), `setup_grist_feedback.py` (création des tables).

## 1. Créer les tables

```bash
export GRIST_URL="https://grist.exemple.fr/o/mon-org"   # ou https://docs.getgrist.com
export GRIST_DOC_ID="..."                               # identifiant du document
export GRIST_API_KEY="..."                              # Profil > Clé API
python3 setup_grist_feedback.py --dry-run               # voir le plan
python3 setup_grist_feedback.py                         # l'appliquer
```

Le script est idempotent (il ne crée que ce qui manque, ne supprime rien) et n'a aucune dépendance.
Il crée `Feedback`, `FeedbackReponses`, `FeedbackHistorique`, `FeedbackReponsesHistorique`, et ajoute `Admin_feedback` (Interrupteur) à `Utilisateurs` — table créée si elle n'existe pas. Dans une table `Utilisateurs` existante, `Email` doit être une colonne texte contenant l'email de connexion Grist de chaque personne.

Option `--tz Europe/Paris` pour le fuseau des dates ; `--pas-auteur-auto` pour ne pas poser la formule d'initialisation `user.Email` / `user.Name` sur les colonnes `Auteur_*` (filet de sécurité si le widget ne reconnaît pas une personne).

## 2. Ajouter le widget

1. Publier `index.html` et `widget.js` ensemble (par exemple avec GitHub Pages).
2. Dans Grist : ajouter un widget **Personnalisé**, URL du `index.html`, accès **Accès complet**, table `Feedback`.

Plusieurs documents peuvent utiliser la même URL : le widget s'adresse toujours au document qui le charge.

## 3. Droits

- **Admin** = coche `Admin_feedback` sur la ligne de la personne dans `Utilisateurs`. Un admin change le statut d'un retour et répond à tous les retours, mais ne peut **ni modifier ni supprimer** les retours et réponses des autres.
- Tant que la colonne `Admin_feedback` n'existe pas, personne n'est admin, sauf l'email indiqué dans `ADMIN_EMAIL` (voir plus bas).
- Pour tout le monde, admins compris : on modifie ou supprime ses propres retours tant qu'ils sont « Nouveau », et ses propres réponses sans condition. Répondre est réservé à l'auteur du retour et aux admins.
- **Owner du document** : l'Owner voit tous les emails de `Utilisateurs` en clair, donc le widget ne peut pas deviner quelle ligne est la sienne. Pour qu'il soit reconnu, renseigner son email dans `ADMIN_EMAIL` (en haut de `widget.js`) ou dans l'URL du widget : `…/index.html?admin=owner@exemple.fr`. Cet email ne donne aucun droit en soi : il sert seulement à retrouver sa ligne. Un Editor n'a pas ce problème.

## 4. Règles d'accès (recommandées)

Le widget applique les droits à l'écran ; seules les Règles d'accès Grist les garantissent côté serveur. Ces règles ne sont pas posées par le script (une erreur peut verrouiller le document) : à ajouter à la main dans « Règles d'accès ».

**a. Attribut utilisateur** — « Ajouter des attributs utilisateur » :
- Nom : `Moi`
- Attribut à rechercher : `Email`
- Table de recherche : `Utilisateurs`
- Colonne de recherche : `Email`

`user.Moi.Admin_feedback` vaut alors vrai pour les admins, et faux pour les autres, y compris une personne absente de `Utilisateurs`.

**b. Statut réservé aux admins** — table `Feedback`, colonne `Statut`, règle placée avant les règles par défaut :
- Condition : `rec.id != 0 and not user.Moi.Admin_feedback`
- Permissions : Mise à jour **refusée**

(`rec.id != 0` laisse la création d'un retour, avec son statut « Nouveau », se faire normalement.)

**c. Seul l'auteur modifie ou supprime ses messages** — tables `Feedback` et `FeedbackReponses`, colonnes `Type`, `Message`, `Pieces_Jointes`, `Images_Jointes`, `Supprime_masque_du_widget_`, `Date_de_suppression` (une règle par table, avec ces colonnes) :
- Condition : `rec.id != 0 and rec.Auteur_email_ != user.Email`
- Permissions : Mise à jour **refusée**

(Les admins n'ont donc aucun droit d'édition sur les messages des autres, même en contournant le widget. Cette règle suppose que `Auteur_email_` soit bien renseigné — d'où la formule `user.Email` posée par le script.)

**d. Personne ne s'auto-promeut admin** — table `Utilisateurs`, colonne `Admin_feedback` :
- Condition : `user.Access != OWNER`
- Permissions : Création et Mise à jour **refusées**

**e. Email masqué (optionnel)** — pour que chacun ne voie que son propre email dans `Utilisateurs` : colonne `Email`, condition `rec.Email != user.Email`, lecture refusée. Le widget fonctionne dans les deux cas.

Après les avoir posées, tester avec un compte non admin : changer un statut doit échouer.

## 5. Pièces jointes

Les nouveaux fichiers vont dans la colonne **Pièces jointes** (`Pieces_Jointes`) : envoi par l'API de Grist, fichiers cliquables dans la table. Les images sont réduites dans le navigateur avant envoi ; autres fichiers jusqu'à 10 Mo, 10 fichiers par message. Si l'envoi échoue, le widget se replie sur la colonne texte `Images_Jointes` (stockage en base64, 600 Ko max par fichier).

Si l'envoi échoue sur votre instance : relever dans la console l'erreur « Envoi vers les pièces jointes Grist impossible ». Cause connue sur certaines instances auto-hébergées : `getAccessToken()` renvoie un identifiant de document court alors que le jeton contient l'identifiant canonique — le widget le corrige déjà (`buildApiBase`).

## 6. Colonnes utilisées

| Table | Colonnes |
|---|---|
| `Feedback` | `Type`, `Message`, `Date_d_envoi`, `Statut`, `Auteur_email_`, `Auteur_nom_`, `Supprime_masque_du_widget_`, `Date_de_suppression`, `Pieces_Jointes`, `Images_Jointes` |
| `FeedbackReponses` | `FeedbackId` (Réf → Feedback), `Message`, `Date_d_envoi`, `Auteur_*`, `Supprime_masque_du_widget_`, `Date_de_suppression`, `Pieces_Jointes`, `Images_Jointes` |
| `FeedbackHistorique` / `FeedbackReponsesHistorique` | référence vers le retour / la réponse, `Ancien_message`, `Date_de_modification`, `Auteur_de_la_modification_*` |
| `Utilisateurs` | `Email`, `Nom`, `Admin_feedback` |

Les suppressions sont « douces » : une ligne n'est jamais effacée, le widget la masque via `Supprime_masque_du_widget_`.
