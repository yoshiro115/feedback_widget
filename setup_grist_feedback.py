#!/usr/bin/env python3
"""
Crée (ou complète) les tables nécessaires au widget Grist « Retours & suggestions ».

Tables :
  - Utilisateurs                 (créée si absente ; sinon on ajoute seulement Admin_feedback)
  - Feedback                     retours (Bug / Suggestion)
  - FeedbackReponses             fil de réponses
  - FeedbackHistorique           journal des anciens messages d'un retour modifié
  - FeedbackReponsesHistorique   idem pour les réponses

Le script est IDEMPOTENT : il ne crée que ce qui manque et ne modifie ni ne
supprime jamais de colonne ou de donnée existante. Aucune dépendance (stdlib).

Utilisation :
    export GRIST_URL="https://grist.exemple.fr/o/mon-org"   # ou https://docs.getgrist.com
    export GRIST_DOC_ID="xxxxxxxxxxxxxxxxxxxxxx"           # identifiant du document
    export GRIST_API_KEY="..."                              # Profil > Clé API
    python3 setup_grist_feedback.py --dry-run               # voir ce qui serait fait
    python3 setup_grist_feedback.py                         # le faire

Options :
    --tz Europe/Paris        fuseau des colonnes date/heure (défaut : Europe/Paris)
    --pas-auteur-auto        ne pas poser la formule d'initialisation user.Email / user.Name
                             sur Auteur_email_ / Auteur_nom_
    --dry-run                n'écrit rien, affiche seulement le plan

Les Règles d'accès (statut réservé aux admins, etc.) ne sont PAS posées par ce
script (risque de verrouiller le document) : voir README.md, section « Règles d'accès ».
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request


# --------------------------------------------------------------------------
# Définition des tables
# --------------------------------------------------------------------------
def choice(*valeurs):
    return json.dumps({"choices": list(valeurs)})


def definitions(tz, auteur_auto):
    dt = "DateTime:" + tz

    def col(id_, label, type_, **extra):
        fields = {"label": label, "type": type_}
        fields.update(extra)
        return {"id": id_, "fields": fields}

    def auteur_cols():
        email = col("Auteur_email_", "Auteur (email)", "Text")
        nom = col("Auteur_nom_", "Auteur (nom)", "Text")
        if auteur_auto:
            # Formule d'initialisation : calculée à la création de la ligne seulement
            # (recalcWhen = 1 : « new records only ») ; une valeur envoyée par le widget
            # a priorité. Filet de sécurité si le widget ne reconnaît pas la personne.
            email["fields"].update({"isFormula": False, "formula": "user.Email", "recalcWhen": 1})
            nom["fields"].update({"isFormula": False, "formula": "user.Name", "recalcWhen": 1})
        return [email, nom]

    suppression = [
        col("Supprime_masque_du_widget_", "Supprimé (masqué du widget)", "Bool"),
        col("Date_de_suppression", "Date de suppression", dt),
    ]
    pieces = [
        col("Pieces_Jointes", "Pièces jointes", "Attachments"),
        col("Images_Jointes", "Images jointes (ancien stockage texte)", "Text"),
    ]

    feedback = [
        col("Type", "Type", "Choice", widgetOptions=choice("Bug", "Suggestion")),
        col("Message", "Message", "Text"),
        col("Date_d_envoi", "Date d'envoi", dt),
        col("Statut", "Statut", "Choice", widgetOptions=choice("Nouveau", "Vu", "Traité")),
    ] + auteur_cols() + suppression + pieces

    reponses = [
        col("FeedbackId", "Feedback concerné", "Ref:Feedback"),
        col("Message", "Message", "Text"),
        col("Date_d_envoi", "Date d'envoi", dt),
    ] + auteur_cols() + suppression + pieces

    def historique(ref_id, ref_label, ref_table):
        return [
            col(ref_id, ref_label, "Ref:" + ref_table),
            col("Ancien_message", "Ancien message", "Text"),
            col("Date_de_modification", "Date de modification", dt),
            col("Auteur_de_la_modification_email_", "Auteur de la modification (email)", "Text"),
            col("Auteur_de_la_modification_nom_", "Auteur de la modification (nom)", "Text"),
        ]

    utilisateurs = [
        col("Nom", "Nom", "Text"),
        col("Email", "Email", "Text"),
        col("Admin_feedback", "Admin feedback", "Bool"),
    ]

    # L'ordre compte : une table référencée doit exister avant celle qui la référence.
    return [
        ("Utilisateurs", utilisateurs),
        ("Feedback", feedback),
        ("FeedbackReponses", reponses),
        ("FeedbackHistorique", historique("Feedback_concerne", "Feedback concerné", "Feedback")),
        ("FeedbackReponsesHistorique", historique("Reponse_concernee", "Réponse concernée", "FeedbackReponses")),
    ]


# --------------------------------------------------------------------------
# Client REST minimal
# --------------------------------------------------------------------------
class Grist:
    def __init__(self, url, doc, key):
        self.base = url.rstrip("/") + "/api/docs/" + doc
        self.key = key

    def _req(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            self.base + path,
            data=data,
            method=method,
            headers={"Authorization": "Bearer " + self.key, "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req) as r:
                raw = r.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")
            sys.exit("Erreur HTTP %s sur %s %s :\n%s" % (e.code, method, path, detail))
        except urllib.error.URLError as e:
            sys.exit("Impossible de joindre le serveur Grist : %s" % e.reason)

    def tables(self):
        return {t["id"] for t in self._req("GET", "/tables")["tables"]}

    def columns(self, table):
        return {c["id"] for c in self._req("GET", "/tables/%s/columns" % table)["columns"]}

    def create_table(self, table, cols):
        self._req("POST", "/tables", {"tables": [{"id": table, "columns": cols}]})

    def add_columns(self, table, cols):
        self._req("POST", "/tables/%s/columns" % table, {"columns": cols})


# --------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default=os.environ.get("GRIST_URL"))
    ap.add_argument("--doc", default=os.environ.get("GRIST_DOC_ID"))
    ap.add_argument("--key", default=os.environ.get("GRIST_API_KEY"))
    ap.add_argument("--tz", default="Europe/Paris")
    ap.add_argument("--pas-auteur-auto", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if not (a.url and a.doc and a.key):
        sys.exit("GRIST_URL, GRIST_DOC_ID et GRIST_API_KEY sont requis (variables d'environnement ou options).")

    g = Grist(a.url, a.doc, a.key)
    existantes = g.tables()
    prefixe = "[simulation] " if a.dry_run else ""
    nb = 0

    for table, cols in definitions(a.tz, not a.pas_auteur_auto):
        if table not in existantes:
            print("%sCréation de la table %s (%d colonnes)" % (prefixe, table, len(cols)))
            if not a.dry_run:
                g.create_table(table, cols)
            existantes.add(table)
            nb += 1
            continue

        presentes = g.columns(table)
        if table == "Utilisateurs":
            # Table du document : on n'y ajoute QUE la colonne d'admin ; Nom/Email doivent
            # déjà exister (ou être créés à la main) — on ne touche pas au reste.
            manquantes = [c for c in cols if c["id"] == "Admin_feedback" and c["id"] not in presentes]
            for requis in ("Email",):
                if requis not in presentes:
                    print("ATTENTION : la table Utilisateurs n'a pas de colonne %s (nécessaire à l'identification)." % requis)
        else:
            manquantes = [c for c in cols if c["id"] not in presentes]

        if manquantes:
            print("%sAjout dans %s : %s" % (prefixe, table, ", ".join(c["id"] for c in manquantes)))
            if not a.dry_run:
                g.add_columns(table, manquantes)
            nb += 1
        else:
            print("%s : rien à faire." % table)

    print()
    print("%s%d opération(s)." % (prefixe, nb))
    print("Étapes suivantes (voir README.md) :")
    print("  1. Cocher Admin_feedback pour les personnes qui peuvent passer un retour en Vu / Traité.")
    print("  2. Poser les Règles d'accès (statut réservé aux admins).")
    print("  3. Ajouter le widget personnalisé (URL GitHub Pages) avec l'accès « Accès complet ».")


if __name__ == "__main__":
    main()