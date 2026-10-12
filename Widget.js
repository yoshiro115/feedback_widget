/* ============================================================
   Retours & suggestions — widget Grist
   ============================================================
   Widget de feedback d'équipe : chacun dépose un Bug / une Suggestion ;
   la liste se groupe par Statut (Nouveau / Vu / Traité),
   avec un fil de réponses par retour.

   Tables Grist attendues :
   - Feedback : Type (Choice), Message (Texte long), Date_d_envoi (epoch
     secondes), Statut (Choice : Nouveau / Vu / Traité), Auteur_email_ /
     Auteur_nom_ (Texte, renseignés par le widget), Supprime_masque_du_widget_
     (Bool, masquage "doux"), Date_de_suppression,
     + Images_Jointes (type TEXTE, facultatif) : pièces jointes du retour.
   - FeedbackReponses : FeedbackId (Référence → Feedback), Message,
     Date_d_envoi, Auteur_email_ / Auteur_nom_, Supprime_masque_du_widget_,
     Date_de_suppression,
     + Images_Jointes (type TEXTE, facultatif) : pièces jointes de la réponse.
   - FeedbackHistorique / FeedbackReponsesHistorique : colonnes repérées
     automatiquement (voir sonderHistoriques()).

   PIECES JOINTES (captures d'écran, images, petits fichiers)
   ------------------------------------------------------------
   Un widget hébergé sur un autre site que Grist ne peut pas envoyer de
   fichiers vers les colonnes "Pièces jointes" de Grist si le serveur
   n'autorise pas l'origine du widget (CORS). Les fichiers sont donc stockés
   DANS la colonne texte Images_Jointes, sous forme d'une liste JSON
   [{ n: nom, t: type, d: "data:...;base64,..." }].
   - Les images sont réduites automatiquement (JPEG, ~350 Ko max chacune).
   - Les autres fichiers (PDF...) sont acceptés jusqu'à 600 Ko.
   - 5 fichiers maximum par message.
   Si la colonne Images_Jointes n'existe pas, la fonctionnalité est cachée
   (l'admin voit une note) et le reste du widget fonctionne comme avant.

   IDENTITE : voir chargerMonUtilisateur() (table Utilisateurs + Règle
   d'accès sur la colonne Email). Ce widget ne crée jamais de ligne dans
   Utilisateurs. Admin = colonne booléenne Utilisateurs.Admin_feedback (repli : ADMIN_EMAIL tant que la colonne n'existe pas ; ADMIN_EMAIL sert aussi à retrouver la ligne de l'Owner du document).
   ============================================================ */

(function () {
  "use strict";

  // Email de l'Owner du document : sert UNIQUEMENT à retrouver sa propre ligne dans
  // Utilisateurs (l'Owner voit tous les emails en clair). Les droits admin viennent de
  // la colonne Utilisateurs.Admin_feedback. À renseigner si l'Owner utilise le widget :
  // soit ici, soit dans l'URL du widget (…/index.html?admin=owner@exemple.fr).
  var ADMIN_EMAIL = (function () {
    try { return new URLSearchParams(window.location.search).get("admin") || ""; } catch (e) { return ""; }
  })();
  var FEEDBACK_TABLE = "Feedback";
  var REPONSES_TABLE = "FeedbackReponses";
  var UTILISATEURS_TABLE = "Utilisateurs";
  var FEEDBACK_HISTORIQUE_TABLE = "FeedbackHistorique";
  var REPONSES_HISTORIQUE_TABLE = "FeedbackReponsesHistorique";

  /* PIÈCES JOINTES (mise à jour 08/10) : si la table contient une colonne de type
     « Pièces jointes » (ID Pieces_Jointes), les nouveaux fichiers y sont envoyés
     par l'API REST de Grist (docId canonique lu dans le jeton, voir buildApiBase).
     En cas d'échec de l'envoi, repli automatique sur la colonne texte Images_Jointes
     (si elle existe). Les anciennes pièces stockées en texte restent affichées. */
  var PJ_COL = "Images_Jointes";
  var PJ_MAX_FICHIERS = 5; // par retour / par réponse
  var PJ_MAX_SOURCE_IMAGE = 25 * 1024 * 1024; // image d'origine acceptée avant réduction
  var PJ_MAX_IMAGE_REDUITE = 350 * 1024; // taille visée après réduction
  var PJ_MAX_AUTRE = 600 * 1024; // PDF et autres fichiers non-image
  var PJ_MAX_CELLULE = 3000000; // caractères max dans la cellule (liste JSON complète)

  var allFeedback = []; // { id, fields }
  var allReponses = []; // { id, fields }
  var feedbackHistoriqueDisponible = false;
  var reponsesHistoriqueDisponible = false;
  var feedbackHistoCols = null;
  var reponsesHistoCols = null;
  var feedbackCols = []; // colonnes réelles de Feedback
  var reponsesCols = []; // colonnes réelles de FeedbackReponses
  var reponsesRefCol = "FeedbackId"; // colonne de liaison réelle de FeedbackReponses (détectée au chargement)

  var openRepliesList = {};
  var openReplyForm = {};
  var editingFeedbackId = null;
  var editingReponseId = null;

  var monEmailActuel = "";
  var monNomActuel = "";
  var adminColPresente = false; // colonne Admin_feedback (Booléen) présente dans Utilisateurs
  var monAdminFlag = false; // ma ligne Utilisateurs a Admin_feedback coché

  // --- Pièces jointes : état ---
  var pjFeedbackDispo = false; // au moins un stockage de fichiers dispo dans Feedback (Pièces jointes Grist et/ou Images_Jointes)
  var pjReponsesDispo = false; // idem dans FeedbackReponses
  var txtFeedbackDispo = false; // colonne texte Images_Jointes présente dans Feedback
  var txtReponsesDispo = false;
  var attColFeedback = null; // colonne Grist de type "Pièces jointes" détectée dans Feedback
  var attColReponses = null; // idem dans FeedbackReponses
  var acces = null; // { base, token, exp } : accès REST pour les pièces jointes Grist
  var metaAtt = {}; // id de pièce jointe -> { n: nom, t: type, s: taille }
  var pendingFiles = {}; // clé de formulaire -> [File] à enregistrer
  var retiresMap = {}; // clé de formulaire d'édition -> [index des pièces existantes à retirer]
  var pickerExistants = {}; // clé de formulaire -> pièces déjà enregistrées (édition)
  var etatChampNouveau = null;

  var STATUTS = ["Nouveau", "Vu", "Traité"];
  var STATUT_LIST_ID = { "Nouveau": "list-nouveau", "Vu": "list-vu", "Traité": "list-traite" };
  var STATUT_COUNT_ID = { "Nouveau": "count-nouveau", "Vu": "count-vu", "Traité": "count-traite" };

  var els = {
    form: document.getElementById("feedback-form"),
    message: document.getElementById("message"),
    submitBtn: document.getElementById("submit-btn"),
    status: document.getElementById("status"),
    countPill: document.getElementById("count-pill"),
    setupNote: document.getElementById("setup-note"),
    fType: document.getElementById("f-type"),
    fSearch: document.getElementById("f-search"),
    fReset: document.getElementById("f-reset"),
  };

  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function typeCourant() {
    var checked = els.form.querySelector('input[name="type"]:checked');
    return checked ? checked.value : "Suggestion";
  }

  /* ==========================
     CSS DES PIECES JOINTES (injecté ici pour ne pas toucher au HTML)
     ========================== */
  (function injecterCss() {
    var css =
      ".pj-label{display:block;margin-bottom:8px;font-size:13px;font-weight:700;}" +
      ".pj-picker{margin:0;}" +
      ".pj-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}" +
      ".pj-input{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;}" +
      ".pj-msg{margin:6px 0 0;font-size:12px;font-weight:600;color:#b3261e;}" +
      ".pj-msg:empty{display:none;}" +
      ".pj-hint{margin:6px 0 0;font-size:12px;color:#59736e;line-height:1.5;}" +
      ".pj-admin-note{margin:0;padding:10px 14px;background:#fdfbce;border:1.5px solid #090c0b;border-radius:10px;font-size:12px;line-height:1.5;}" +
      ".pj-pending{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:6px;}" +
      ".pj-pending:empty{display:none;}" +
      ".pj-pending-item{display:flex;align-items:center;gap:10px;padding:6px 8px;background:#ffffff;border:1.5px solid #090c0b;border-radius:10px;font-size:12px;}" +
      ".pj-pending-thumb{width:40px;height:40px;flex:none;object-fit:cover;border:1px solid #090c0b;border-radius:6px;background:#f2f2f2;}" +
      ".pj-pending-icon{width:40px;height:40px;flex:none;display:flex;align-items:center;justify-content:center;border:1px solid #090c0b;border-radius:6px;background:#f2f2f2;font-size:18px;}" +
      ".pj-name{flex:1;min-width:0;overflow-wrap:anywhere;font-weight:600;}" +
      ".pj-size{color:#59736e;white-space:nowrap;}" +
      ".pj-retired .pj-name{text-decoration:line-through;color:#59736e;}" +
      ".pj-remove{flex:none;padding:4px 10px;background:#ffffff;border:1.5px solid #090c0b;border-radius:100px;font-family:inherit;font-size:11.5px;font-weight:700;color:#090c0b;cursor:pointer;}" +
      ".pj-remove:hover{background:#f2f2f2;}" +
      ".pj-remove:focus-visible,.pj-thumb-link:focus-visible,.pj-file:focus-visible,.pj-lb-btn:focus-visible{outline:3px solid #090c0b;outline-offset:2px;}" +
      ".pj-list{list-style:none;margin:8px 0 12px;padding:0;display:flex;flex-wrap:wrap;gap:10px;align-items:flex-start;}" +
      ".pj-item{display:flex;flex-direction:column;gap:4px;max-width:180px;}" +
      ".pj-thumb-link{display:block;border-radius:8px;cursor:zoom-in;}" +
      ".pj-thumb{display:block;max-width:180px;max-height:120px;object-fit:cover;background:#ffffff;border:1.5px solid #090c0b;border-radius:8px;}" +
      ".pj-caption{font-size:11px;color:#59736e;overflow-wrap:anywhere;}" +
      ".pj-file{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;background:#f2f2f2;border:1.5px solid #090c0b;border-radius:100px;color:#090c0b;font-size:12px;font-weight:600;text-decoration:underline;overflow-wrap:anywhere;}" +
      ".pj-lightbox{position:fixed;inset:0;z-index:1000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:16px;background:rgba(9,12,11,0.85);}" +
      ".pj-lightbox[hidden]{display:none;}" +
      ".pj-lightbox img{max-width:100%;max-height:calc(100vh - 100px);background:#ffffff;border:2px solid #ffffff;border-radius:8px;}" +
      ".pj-lb-actions{display:flex;gap:8px;}" +
      ".pj-lb-btn{padding:8px 16px;background:#ffffff;border:1.5px solid #090c0b;border-radius:100px;font-family:inherit;font-size:13px;font-weight:700;color:#090c0b;text-decoration:none;cursor:pointer;}";
    var style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // Champ "Pièces jointes" du formulaire de nouveau retour, inséré avant les boutons.
  var champNouveau = document.createElement("div");
  champNouveau.className = "field";
  champNouveau.id = "pj-new-field";
  champNouveau.hidden = true;
  els.form.insertBefore(champNouveau, els.form.querySelector(".actions"));

  // Visionneuse plein écran pour agrandir une image.
  var lightbox = document.createElement("div");
  lightbox.className = "pj-lightbox";
  lightbox.hidden = true;
  lightbox.setAttribute("role", "dialog");
  lightbox.setAttribute("aria-modal", "true");
  lightbox.setAttribute("aria-label", "Aperçu de l'image");
  lightbox.innerHTML =
    '<img alt="" />' +
    '<div class="pj-lb-actions">' +
    '<a class="pj-lb-btn pj-lb-download" href="#" download>Télécharger</a>' +
    '<button type="button" class="pj-lb-btn pj-lb-close">Fermer</button>' +
    "</div>";
  document.body.appendChild(lightbox);
  var lastFocus = null;

  function ouvrirLightbox(src, nom) {
    lastFocus = document.activeElement;
    var img = lightbox.querySelector("img");
    img.src = src;
    img.alt = nom;
    var dl = lightbox.querySelector(".pj-lb-download");
    dl.href = src;
    dl.setAttribute("download", nom);
    lightbox.hidden = false;
    lightbox.querySelector(".pj-lb-close").focus();
  }

  function fermerLightbox() {
    lightbox.hidden = true;
    lightbox.querySelector("img").removeAttribute("src");
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  lightbox.addEventListener("click", function (e) {
    if (e.target === lightbox || e.target.classList.contains("pj-lb-close")) fermerLightbox();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !lightbox.hidden) fermerLightbox();
  });

  /* ==========================
     PIECES JOINTES : DONNEES (liste JSON dans une colonne texte)
     ========================== */
  var PJ_MAX_FICHIERS_ATT = 10;
  var PJ_MAX_AUTRE_ATT = 10 * 1024 * 1024;

  // docId canonique lu dans le jeton (le baseUrl renvoyé par getAccessToken
  // contient parfois l'identifiant court, que le serveur refuse ensuite —
  // erreur affichée comme un faux problème CORS).
  function decodeJwtDocId(token) {
    try {
      var payloadB64 = token.split(".")[1];
      var normalized = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
      while (normalized.length % 4) normalized += "=";
      var payload = JSON.parse(atob(normalized));
      return payload && payload.docId ? payload.docId : null;
    } catch (e) {
      return null;
    }
  }

  function buildApiBase(tokenInfo) {
    var canonicalDocId = decodeJwtDocId(tokenInfo.token);
    var m = tokenInfo.baseUrl.match(/^(.*\/api\/docs\/)([^\/?]+)$/);
    if (m && canonicalDocId && m[2] !== canonicalDocId) return m[1] + canonicalDocId;
    return tokenInfo.baseUrl;
  }

  function obtenirAcces() {
    if (acces && Date.now() < acces.exp - 60000) return Promise.resolve(acces);
    return grist.docApi.getAccessToken({ readOnly: false }).then(function (info) {
      acces = { base: buildApiBase(info), token: info.token, exp: Date.now() + (info.ttlMsecs || 300000) };
      return acces;
    });
  }

  function urlAtt(id) {
    if (!acces) return "";
    return acces.base + "/attachments/" + id + "/download?auth=" + encodeURIComponent(acces.token);
  }

  function attIds(val) {
    if (!Array.isArray(val)) return [];
    var arr = val[0] === "L" ? val.slice(1) : val;
    return arr.filter(function (x) { return typeof x === "number"; });
  }

  function cibleDeKey(key) {
    return key.indexOf("reply-") === 0 || key.indexOf("edit-reponse-") === 0 ? "reponses" : "feedback";
  }

  function attDispoPour(cible) {
    return cible === "reponses" ? !!attColReponses : !!attColFeedback;
  }

  // Pièces d'un enregistrement : anciennes (texte JSON) + Pièces jointes Grist.
  function piecesRecord(fields, cible) {
    if (!fields) return [];
    var txt = piecesDe(fields[PJ_COL]).map(function (p) { return { n: p.n, t: p.t, d: p.d, src: "txt" }; });
    var colAtt = cible === "reponses" ? attColReponses : attColFeedback;
    var att = colAtt
      ? attIds(fields[colAtt]).map(function (id) {
          var m = metaAtt[id] || {};
          return { n: m.n || "Fichier " + id, t: m.t || "", att: id, size: m.s || 0, src: "att" };
        })
      : [];
    return txt.concat(att);
  }

  function srcItem(p) {
    return p.att ? urlAtt(p.att) : p.d;
  }

  // Charge nom / type / taille des pièces jointes Grist affichées.
  function preparerPJ() {
    if (!attColFeedback && !attColReponses) return Promise.resolve();
    var besoin = [];
    allFeedback.forEach(function (r) { if (attColFeedback) attIds(r.fields[attColFeedback]).forEach(function (id) { besoin.push(id); }); });
    allReponses.forEach(function (r) { if (attColReponses) attIds(r.fields[attColReponses]).forEach(function (id) { besoin.push(id); }); });
    return obtenirAcces()
      .then(function () {
        var manquants = besoin.filter(function (id) { return !metaAtt[id]; });
        if (!manquants.length) return;
        return grist.docApi
          .fetchTable("_grist_Attachments")
          .then(function (t) {
            if (!t || !t.id) return;
            t.id.forEach(function (id, i) {
              metaAtt[id] = { n: t.fileName ? t.fileName[i] : "", t: t.fileType ? t.fileType[i] : "", s: t.fileSize ? t.fileSize[i] : 0 };
            });
          })
          .catch(function (e) { console.warn("[Feedback] Lecture de _grist_Attachments impossible :", e); })
          .then(function () {
            return Promise.all(
              manquants.filter(function (id) { return !metaAtt[id]; }).map(function (id) {
                return fetch(acces.base + "/attachments/" + id + "?auth=" + encodeURIComponent(acces.token), { headers: { "X-Requested-With": "XMLHttpRequest" } })
                  .then(function (r) { return r.json(); })
                  .then(function (m) { metaAtt[id] = { n: m.fileName, t: m.fileType, s: m.fileSize }; })
                  .catch(function () {});
              })
            );
          });
      })
      .catch(function (e) { console.warn("[Feedback] Accès aux pièces jointes Grist impossible :", e); });
  }

  function piecesDe(val) {
    if (!val || typeof val !== "string") return [];
    try {
      var arr = JSON.parse(val);
      return Array.isArray(arr)
        ? arr.filter(function (p) { return p && typeof p.d === "string"; })
        : [];
    } catch (e) {
      return [];
    }
  }

  function tailleItem(p) {
    if (p.att) return p.size || 0;
    // Taille approximative du fichier d'origine à partir du base64.
    var i = p.d.indexOf(",");
    return Math.round(((p.d.length - (i + 1)) * 3) / 4);
  }

  function estImageType(type) {
    // SVG volontairement exclu (traité comme un fichier ordinaire).
    return /^image\/(png|jpe?g|gif|webp|bmp)$/i.test(type || "");
  }

  function formatTaille(octets) {
    if (!octets) return "";
    if (octets < 1024) return octets + " o";
    if (octets < 1024 * 1024) return Math.round(octets / 1024) + " Ko";
    return (octets / (1024 * 1024)).toFixed(1).replace(".", ",") + " Mo";
  }

  function lireFichier(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result)); };
      reader.onerror = function () { reject(new Error("lecture impossible : « " + file.name + " »")); };
      reader.readAsDataURL(file);
    });
  }

  // Réduit une image : redimensionnement + JPEG, en baissant la qualité
  // jusqu'à passer sous PJ_MAX_IMAGE_REDUITE.
  function reduireImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var essais = [[1600, 0.82], [1400, 0.7], [1200, 0.6], [1000, 0.5], [800, 0.45]];
        var resultat = null;
        for (var i = 0; i < essais.length; i++) {
          var echelle = Math.min(1, essais[i][0] / Math.max(img.naturalWidth, img.naturalHeight));
          var w = Math.max(1, Math.round(img.naturalWidth * echelle));
          var h = Math.max(1, Math.round(img.naturalHeight * echelle));
          var canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          var ctx = canvas.getContext("2d");
          ctx.fillStyle = "#ffffff"; // fond blanc pour les PNG transparents
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          resultat = canvas.toDataURL("image/jpeg", essais[i][1]);
          if ((resultat.length * 3) / 4 <= PJ_MAX_IMAGE_REDUITE) break;
        }
        resolve(resultat);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("image illisible : « " + file.name + " »"));
      };
      img.src = url;
    });
  }

  function dataUrlVersBlob(d) {
    var i = d.indexOf(",");
    var bin = atob(d.slice(i + 1));
    var u8 = new Uint8Array(bin.length);
    for (var k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k);
    return new Blob([u8], { type: d.slice(5, d.indexOf(";")) });
  }

  function blobVersItem(pf) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve({ n: pf.nom, t: pf.type, d: String(reader.result) }); };
      reader.onerror = function () { reject(new Error("lecture impossible : « " + pf.nom + " »")); };
      reader.readAsDataURL(pf.blob);
    });
  }

  // Fichier -> { nom, type, blob } (les images sont réduites en JPEG).
  function preparerFichier(file) {
    if (estImageType(file.type)) {
      return reduireImage(file).then(function (d) {
        return { nom: file.name.replace(/\.[^.]+$/, "") + ".jpg", type: "image/jpeg", blob: dataUrlVersBlob(d) };
      });
    }
    return Promise.resolve({ nom: file.name, type: file.type || "application/octet-stream", blob: file });
  }

  function televerserAtt(prep) {
    return obtenirAcces().then(function (acc) {
      var fd = new FormData();
      prep.forEach(function (f) { fd.append("upload", f.blob, f.nom); });
      return fetch(acc.base + "/attachments?auth=" + encodeURIComponent(acc.token), {
        method: "POST",
        body: fd,
        headers: { "X-Requested-With": "XMLHttpRequest" },
      }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      });
    }).then(function (ids) {
      ids.forEach(function (id, i) { metaAtt[id] = { n: prep[i].nom, t: prep[i].type, s: prep[i].blob.size }; });
      return ids;
    });
  }

  // Renvoie les champs à écrire pour les pièces jointes :
  // nouveaux fichiers -> colonne Pièces jointes Grist (repli : colonne texte).
  // modifier = true (édition) : réécrit aussi la colonne même si elle devient vide.
  function construirePJ(key, existants, files, cible, modifier) {
    var retires = retiresMap[key] || [];
    var gardes = existants.filter(function (p, i) { return retires.indexOf(i) === -1; });
    var gardesTxt = gardes.filter(function (p) { return p.src === "txt"; });
    var gardesAtt = gardes.filter(function (p) { return p.src === "att"; });
    var colAtt = cible === "reponses" ? attColReponses : attColFeedback;
    var txtDispo = cible === "reponses" ? txtReponsesDispo : txtFeedbackDispo;

    return Promise.all((files || []).map(preparerFichier))
      .then(function (prep) {
        if (colAtt && prep.length) {
          return televerserAtt(prep)
            .then(function (ids) { return { ids: ids, inline: [] }; })
            .catch(function (err) {
              console.warn("[Feedback] Envoi vers les pièces jointes Grist impossible, repli sur la colonne texte :", err);
              if (!txtDispo) throw new Error("envoi des fichiers impossible (" + err.message + ")");
              return { ids: [], inline: prep };
            });
        }
        return { ids: [], inline: prep };
      })
      .then(function (r) {
        return Promise.all(r.inline.map(blobVersItem)).then(function (nouveauxTxt) {
          var out = {};
          if (nouveauxTxt.length && !txtDispo) throw new Error("aucune colonne de stockage disponible pour ces fichiers");
          var txtList = gardesTxt.map(function (p) { return { n: p.n, t: p.t, d: p.d }; }).concat(nouveauxTxt);
          if (txtDispo && (modifier || txtList.length)) {
            var json = txtList.length ? JSON.stringify(txtList) : "";
            if (json.length > PJ_MAX_CELLULE) {
              throw new Error("pièces jointes trop volumineuses ensemble : retire un fichier ou réduis leur nombre");
            }
            out[PJ_COL] = json;
          }
          var attList = gardesAtt.map(function (p) { return p.att; }).concat(r.ids);
          if (colAtt && (modifier || attList.length)) out[colAtt] = ["L"].concat(attList);
          return out;
        });
      });
  }

  /* ==========================
     PIECES JOINTES : SELECTEUR (formulaires) ET AFFICHAGE
     ========================== */
  function previewUrl(file) {
    if (!file._pjUrl) file._pjUrl = URL.createObjectURL(file);
    return file._pjUrl;
  }

  function viderPending(key) {
    (pendingFiles[key] || []).forEach(function (f) {
      if (f._pjUrl) URL.revokeObjectURL(f._pjUrl);
    });
    delete pendingFiles[key];
    delete retiresMap[key];
    delete pickerExistants[key];
  }

  function renderPickerBody(key) {
    var existants = pickerExistants[key] || [];
    var retires = retiresMap[key] || [];
    var html = "";
    existants.forEach(function (p, i) {
      var retire = retires.indexOf(i) !== -1;
      var thumb = estImageType(p.t)
        ? '<img class="pj-pending-thumb" src="' + escapeHtml(srcItem(p)) + '" alt="" />'
        : '<span class="pj-pending-icon" aria-hidden="true">📄</span>';
      html +=
        '<li class="pj-pending-item' + (retire ? " pj-retired" : "") + '">' + thumb +
        '<span class="pj-name">' + escapeHtml(p.n || "Fichier") + "</span>" +
        '<span class="pj-size">' + formatTaille(tailleItem(p)) + "</span>" +
        '<button type="button" class="pj-remove pj-retire" data-key="' + escapeHtml(key) + '" data-index="' + i + '">' +
        (retire ? "Annuler le retrait" : "Retirer") + "</button>" +
        "</li>";
    });
    (pendingFiles[key] || []).forEach(function (f, i) {
      var thumb = estImageType(f.type)
        ? '<img class="pj-pending-thumb" src="' + previewUrl(f) + '" alt="" />'
        : '<span class="pj-pending-icon" aria-hidden="true">📄</span>';
      html +=
        '<li class="pj-pending-item">' + thumb +
        '<span class="pj-name">' + escapeHtml(f.name) + "</span>" +
        '<span class="pj-size">' + formatTaille(f.size) + "</span>" +
        '<button type="button" class="pj-remove pj-unpend" data-key="' + escapeHtml(key) + '" data-index="' + i + '" aria-label="Retirer ' + escapeHtml(f.name) + '">Retirer</button>' +
        "</li>";
    });
    return html;
  }

  function renderPicker(key, existants) {
    pickerExistants[key] = existants || [];
    return (
      '<div class="pj-picker" data-pj-key="' + escapeHtml(key) + '">' +
      '<div class="pj-row">' +
      '<button type="button" class="action-btn pj-add-btn">📎 Ajouter des fichiers</button>' +
      '<input type="file" class="pj-input" multiple tabindex="-1" aria-hidden="true" />' +
      "</div>" +
      '<ul class="pj-pending">' + renderPickerBody(key) + "</ul>" +
      '<p class="pj-msg" role="status" aria-live="polite"></p>' +
      '<p class="pj-hint">Captures d\'écran et images (réduites automatiquement), ou fichiers de ' +
      (attDispoPour(cibleDeKey(key)) ? "10 Mo" : "600 Ko") + " max. " +
      (attDispoPour(cibleDeKey(key)) ? PJ_MAX_FICHIERS_ATT : PJ_MAX_FICHIERS) + " fichiers max. Tu peux aussi coller une capture (Ctrl+V) dans le champ de texte.</p>" +
      "</div>"
    );
  }

  function pickersPour(key) {
    return Array.prototype.slice.call(document.querySelectorAll(".pj-picker")).filter(function (el) {
      return el.getAttribute("data-pj-key") === key;
    });
  }

  function refreshPickers(key) {
    pickersPour(key).forEach(function (picker) {
      picker.querySelector(".pj-pending").innerHTML = renderPickerBody(key);
    });
  }

  function addFiles(key, fileList, picker) {
    var msg = picker.querySelector(".pj-msg");
    var existants = pickerExistants[key] || [];
    var retires = retiresMap[key] || [];
    var gardes = existants.filter(function (p, i) { return retires.indexOf(i) === -1; }).length;
    var liste = pendingFiles[key] || (pendingFiles[key] = []);
    var erreurs = [];
    var att = attDispoPour(cibleDeKey(key));
    var maxFichiers = att ? PJ_MAX_FICHIERS_ATT : PJ_MAX_FICHIERS;
    var maxAutre = att ? PJ_MAX_AUTRE_ATT : PJ_MAX_AUTRE;

    Array.prototype.slice.call(fileList).forEach(function (f) {
      var image = estImageType(f.type);
      if (gardes + liste.length >= maxFichiers) {
        erreurs.push("Maximum " + maxFichiers + " fichiers : « " + f.name + " » ignoré.");
      } else if (image && f.size > PJ_MAX_SOURCE_IMAGE) {
        erreurs.push("« " + f.name + " » est trop lourd (25 Mo max avant réduction).");
      } else if (!image && f.size > maxAutre) {
        erreurs.push("« " + f.name + " » dépasse " + formatTaille(maxAutre) + " (seules les images sont réduites automatiquement).");
      } else {
        liste.push(f);
      }
    });
    msg.textContent = erreurs.join(" ");
    refreshPickers(key);
  }

  function renderPieces(items) {
    if (!items || !items.length) return "";
    return (
      '<ul class="pj-list" aria-label="Pièces jointes">' +
      items.map(function (p) {
        var nom = p.n || "Fichier";
        var taille = formatTaille(tailleItem(p));
        if (estImageType(p.t)) {
          return (
            '<li class="pj-item">' +
            '<a class="pj-thumb-link" href="' + escapeHtml(srcItem(p)) + '" data-nom="' + escapeHtml(nom) + '" aria-label="Agrandir l\'image ' + escapeHtml(nom) + '">' +
            '<img class="pj-thumb" src="' + escapeHtml(srcItem(p)) + '" alt="Pièce jointe : ' + escapeHtml(nom) + '" />' +
            "</a>" +
            '<span class="pj-caption">' + escapeHtml(nom) + (taille ? " — " + taille : "") + "</span>" +
            "</li>"
          );
        }
        return (
          '<li class="pj-item"><a class="pj-file" href="' + escapeHtml(srcItem(p)) + '" target="_blank" rel="noopener" download="' + escapeHtml(nom) + '">📄 ' +
          escapeHtml(nom) + (taille ? " (" + taille + ")" : "") + "</a></li>"
        );
      }).join("") +
      "</ul>"
    );
  }

  // Champ du formulaire "nouveau retour" : sélecteur, note admin, ou rien.
  function majChampNouveau() {
    var etat = pjFeedbackDispo ? "ok" : jeSuisAdmin() ? "admin" : "rien";
    if (etat === etatChampNouveau) return;
    etatChampNouveau = etat;
    if (etat === "ok") {
      champNouveau.hidden = false;
      champNouveau.innerHTML = '<span class="pj-label">Pièces jointes <span class="required-hint">(facultatif)</span></span>' + renderPicker("new-feedback", []);
    } else if (etat === "admin") {
      champNouveau.hidden = false;
      champNouveau.innerHTML = '<p class="pj-admin-note">Pièces jointes désactivées (visible admin uniquement) : ajoute une colonne <strong>Pieces_Jointes</strong> de type <strong>Pièces jointes</strong> dans la table <strong>Feedback</strong> (et dans <strong>FeedbackReponses</strong> pour les réponses).</p>';
    } else {
      champNouveau.hidden = true;
      champNouveau.innerHTML = "";
    }
  }

  /* Événements délégués : survivent aux re-rendus de render(). */
  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var thumb = t.closest(".pj-thumb-link");
    if (thumb) {
      e.preventDefault();
      ouvrirLightbox(thumb.getAttribute("href"), thumb.getAttribute("data-nom") || "image");
      return;
    }
    var add = t.closest(".pj-add-btn");
    if (add) {
      var input = add.parentNode.querySelector(".pj-input");
      if (input) input.click();
      return;
    }
    var unpend = t.closest(".pj-unpend");
    if (unpend) {
      var key = unpend.getAttribute("data-key");
      var f = (pendingFiles[key] || []).splice(Number(unpend.getAttribute("data-index")), 1)[0];
      if (f && f._pjUrl) URL.revokeObjectURL(f._pjUrl);
      refreshPickers(key);
      return;
    }
    var retire = t.closest(".pj-retire");
    if (retire) {
      var k = retire.getAttribute("data-key");
      var idx = Number(retire.getAttribute("data-index"));
      var liste = retiresMap[k] || (retiresMap[k] = []);
      var pos = liste.indexOf(idx);
      if (pos === -1) liste.push(idx); else liste.splice(pos, 1);
      refreshPickers(k);
    }
  });

  document.addEventListener("change", function (e) {
    var input = e.target;
    if (!input || !input.classList || !input.classList.contains("pj-input")) return;
    var picker = input.closest(".pj-picker");
    if (picker) addFiles(picker.getAttribute("data-pj-key"), input.files, picker);
    input.value = "";
  });

  // Coller une capture d'écran (Ctrl+V) dans un champ de texte du formulaire.
  document.addEventListener("paste", function (e) {
    var ta = e.target;
    if (!ta || ta.tagName !== "TEXTAREA" || !e.clipboardData) return;
    var form = ta.closest("form");
    var picker = form && form.querySelector(".pj-picker");
    if (!picker) return;
    var images = Array.prototype.slice.call(e.clipboardData.files || []).filter(function (f) {
      return /^image\//.test(f.type);
    });
    if (!images.length) return;
    e.preventDefault();
    var horo = Date.now();
    var renommes = images.map(function (f, i) {
      var ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
      return new File([f], "capture-" + horo + (images.length > 1 ? "-" + (i + 1) : "") + "." + ext, { type: f.type });
    });
    addFiles(picker.getAttribute("data-pj-key"), renommes, picker);
  });

  /* ==========================
     IDENTITE (table Utilisateurs, lecture seule)
     ========================== */
  // Renseigne l'auteur depuis Utilisateurs. Si la personne n'a pas pu être
  // identifiée, on N'ÉCRIT PAS de valeur vide : une formule d'initialisation
  // Grist sur ces colonnes (user.Email / user.Name) peut alors prendre le relais.
  function ajouterAuteur(champs) {
    if (monEmailActuel) champs.Auteur_email_ = monEmailActuel;
    if (monNomActuel) champs.Auteur_nom_ = monNomActuel;
    if (!monEmailActuel) {
      console.warn("[Feedback] Auteur non identifié (aucune ligne Utilisateurs avec ton email visible) : Auteur_email_ / Auteur_nom_ non renseignés par le widget.");
    }
    return champs;
  }

  // Une cellule masquée par une Règle d'accès n'est pas forcément vide dans
  // fetchTable : Grist peut renvoyer une valeur "censurée" (ex. ["C"]), qui est
  // "vraie" en JavaScript. On ne retient donc que de vraies chaînes d'email.
  function emailLisible(v) {
    return typeof v === "string" && v.indexOf("@") > 0;
  }

  function chargerMonUtilisateur() {
    return grist.docApi
      .fetchTable(UTILISATEURS_TABLE)
      .then(function (table) {
        monEmailActuel = "";
        monNomActuel = "";
        monAdminFlag = false;
        var colAdmin = table ? Object.keys(table).filter(function (c) { return normaliser(c) === "adminfeedback"; })[0] : null;
        adminColPresente = !!colAdmin;
        if (!table || !table.id || !table.Email) return;
        console.info("[Feedback] Diagnostic identité — valeurs brutes de Utilisateurs.Email :", table.Email.slice(0, 6));

        // La Regle d'acces ne restreint PAS la lecture des lignes : elle masque
        // uniquement la colonne Email ligne par ligne (rec.Email == user.Email).
        // Une seule ligne — la mienne — a donc un Email non vide.
        var indexTrouve = -1;
        var nbTrouves = 0;
        for (var i = 0; i < table.id.length; i++) {
          if (emailLisible(table.Email[i])) {
            nbTrouves++;
            indexTrouve = i;
          }
        }

        if (nbTrouves === 1) {
          monEmailActuel = String(table.Email[indexTrouve]).trim().toLowerCase();
          monNomActuel = String(table.Nom ? table.Nom[indexTrouve] || "" : "").trim();
          monAdminFlag = !!colAdmin && table[colAdmin][indexTrouve] === true;
          return;
        }
        if (nbTrouves > 1) {
          // Cas du Owner du document : il voit toutes les lignes en clair. On
          // identifie "ma" ligne via ADMIN_EMAIL (ne peut concerner que lui).
          var indexAdmin = -1;
          for (var j = 0; j < table.id.length; j++) {
            if (emailLisible(table.Email[j]) && String(table.Email[j]).trim().toLowerCase() === ADMIN_EMAIL.trim().toLowerCase()) {
              indexAdmin = j;
              break;
            }
          }
          if (indexAdmin !== -1) {
            monEmailActuel = String(table.Email[indexAdmin]).trim().toLowerCase();
            monNomActuel = String(table.Nom ? table.Nom[indexAdmin] || "" : "").trim();
            monAdminFlag = !!colAdmin && table[colAdmin][indexAdmin] === true;
            return;
          }
          console.error(
            "[Feedback] La colonne Email de la table Utilisateurs est visible sur " + nbTrouves + " lignes, et " +
            "aucune ne correspond à ADMIN_EMAIL : si tu n'es pas Owner du document, vérifie la Règle d'accès " +
            "(R+U refusés pour rec.Email != user.Email). Par sécurité, aucune commande réservée n'est affichée " +
            "tant que ce n'est pas corrigé."
          );
          return;
        }
        // Aucune ligne avec un Email visible : on reste non identifié (ce widget
        // ne crée jamais de ligne dans Utilisateurs).
        console.warn("[Feedback] Aucune ligne de la table Utilisateurs n'a d'Email visible pour toi : soit ta ligne n'existe pas, soit son Email diffère de ton email de connexion Grist (casse, alias), soit la Règle d'accès masque tout.");
      })
      .catch(function (err) {
        console.error("[Feedback] Table Utilisateurs introuvable ou inaccessible :", err);
        monEmailActuel = "";
        monNomActuel = "";
        monAdminFlag = false;
        adminColPresente = false;
      });
  }

  function monEmail() {
    return monEmailActuel;
  }

  function jeSuisAdmin() {
    // Colonne Utilisateurs.Admin_feedback présente : elle seule décide.
    // Sinon (colonne pas encore créée) : repli sur ADMIN_EMAIL.
    if (adminColPresente) return monAdminFlag;
    return !!monEmailActuel && monEmailActuel === ADMIN_EMAIL.trim().toLowerCase();
  }

  function estMonEmail(email) {
    var moi = monEmail();
    return !!moi && !!email && String(email).trim().toLowerCase() === moi;
  }

  function estMonFeedback(id) {
    var f = allFeedback.filter(function (r) { return r.id === id; })[0];
    return !!f && estMonEmail(f.fields.Auteur_email_);
  }

  function estMaReponse(id) {
    var r = allReponses.filter(function (r) { return r.id === id; })[0];
    return !!r && estMonEmail(r.fields.Auteur_email_);
  }

  function libelleAuteur(fields) {
    var nom = (fields.Auteur_nom_ || "").trim();
    var email = (fields.Auteur_email_ || "").trim();
    if (nom) return nom;
    if (email) return email;
    return null;
  }

  var ICONE_MODIFIER =
    '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M13.5 3.5l3 3-9 9-3.5.5.5-3.5 9-9z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  var ICONE_SUPPRIMER =
    '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 6h12M8 6V4.5a1 1 0 011-1h2a1 1 0 011 1V6m-7 0l.7 9.1a1 1 0 001 .9h4.6a1 1 0 001-.9L14 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /* ==========================
     ENVOI DU FORMULAIRE
     ========================== */
  function setStatus(text, state) {
    els.status.textContent = text;
    els.status.setAttribute("data-state", state || "");
  }

  els.form.addEventListener("submit", function (e) {
    e.preventDefault();

    var message = els.message.value.trim();
    if (!message) {
      setStatus("Merci d'écrire un message avant d'envoyer.", "error");
      els.message.focus();
      return;
    }

    var fichiers = pjFeedbackDispo ? pendingFiles["new-feedback"] || [] : [];

    els.submitBtn.disabled = true;
    setStatus(fichiers.length ? "Préparation des fichiers…" : "Envoi en cours…", "");

    (fichiers.length ? construirePJ("new-feedback", [], fichiers, "feedback", false) : Promise.resolve({}))
      .then(function (champsPJ) {
        var fields = {
          Type: typeCourant(),
          Message: message,
          Date_d_envoi: Math.floor(Date.now() / 1000),
          Statut: "Nouveau",
        };
        ajouterAuteur(fields);
        Object.assign(fields, champsPJ);
        setStatus("Envoi en cours…", "");
        return grist.docApi.applyUserActions([["AddRecord", FEEDBACK_TABLE, null, fields]]);
      })
      .then(function () {
        setStatus("Merci, ton retour a bien été enregistré !", "ok");
        els.form.reset();
        viderPending("new-feedback");
        pickerExistants["new-feedback"] = [];
        refreshPickers("new-feedback");
        return chargerFeedback().then(render);
      })
      .catch(function (err) {
        console.error("[Feedback] Échec de l'envoi :", err);
        setStatus("Erreur : " + (err && err.message ? err.message : "réessaie dans un instant."), "error");
      })
      .then(function () {
        els.submitBtn.disabled = false;
      });
  });

  /* ==========================
     EDITION D'UN FEEDBACK (par son auteur, tant que Statut = Nouveau)
     ========================== */
  function renderFeedbackEditForm(r) {
    var f = r.fields;
    var key = "edit-feedback-" + r.id;
    return (
      '<form class="feedback-edit-form" data-feedback-id="' + r.id + '">' +
      '<fieldset>' +
      '<legend class="field-hint" style="margin:0 0 8px;">Type de retour</legend>' +
      '<div class="type-options">' +
      ["Bug", "Suggestion"]
        .map(function (t) {
          var idAttr = "edit-type-" + r.id + "-" + t.replace(/[^a-zA-Z]/g, "");
          return (
            '<div class="type-option">' +
            '<input type="radio" name="edit-type-' + r.id + '" id="' + idAttr + '" value="' + escapeHtml(t) + '"' + (f.Type === t ? " checked" : "") + " />" +
            '<label for="' + idAttr + '">' + escapeHtml(t) + "</label>" +
            "</div>"
          );
        })
        .join("") +
      "</div>" +
      "</fieldset>" +
      '<div class="field" style="margin-top:12px;">' +
      '<textarea class="feedback-edit-message" required>' + escapeHtml(f.Message || "") + "</textarea>" +
      "</div>" +
      (pjFeedbackDispo ? '<div class="field">' + renderPicker(key, piecesRecord(f, "feedback")) + "</div>" : "") +
      '<div class="reply-form-actions" style="margin-top:12px;">' +
      '<button type="submit" class="reply-submit">Enregistrer</button>' +
      '<button type="button" class="feedback-edit-cancel replies-toggle">Annuler</button>' +
      '<span class="reply-status" role="status" aria-live="polite"></span>' +
      "</div>" +
      "</form>"
    );
  }

  function wireFeedbackEditForm(form) {
    var feedbackId = Number(form.getAttribute("data-feedback-id"));
    var key = "edit-feedback-" + feedbackId;

    form.querySelector(".feedback-edit-cancel").addEventListener("click", function () {
      viderPending(key);
      editingFeedbackId = null;
      render();
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var submitBtn = form.querySelector(".reply-submit");
      var statusEl = form.querySelector(".reply-status");
      var message = form.querySelector(".feedback-edit-message").value.trim();
      var typeChoisi = form.querySelector('input[name="edit-type-' + feedbackId + '"]:checked');
      var type = typeChoisi ? typeChoisi.value : "Suggestion";

      if (!message) {
        statusEl.textContent = "Le message ne peut pas être vide.";
        statusEl.setAttribute("data-state", "error");
        return;
      }

      var ancien = allFeedback.filter(function (r) { return r.id === feedbackId; })[0];
      var ancienMessage = ancien ? ancien.fields.Message || "" : "";
      var existants = ancien ? piecesRecord(ancien.fields, "feedback") : [];
      var retires = retiresMap[key] || [];
      var nouveaux = pendingFiles[key] || [];
      var modifPJ = pjFeedbackDispo && (nouveaux.length > 0 || retires.length > 0);

      submitBtn.disabled = true;
      statusEl.textContent = nouveaux.length ? "Préparation des fichiers…" : "Enregistrement…";
      statusEl.setAttribute("data-state", "");

      (modifPJ ? construirePJ(key, existants, nouveaux, "feedback", true) : Promise.resolve(null))
        .then(function (champsPJ) {
          var champs = { Type: type, Message: message };
          if (modifPJ) Object.assign(champs, champsPJ);
          var actions = [];
          if (feedbackHistoriqueDisponible) {
            actions.push(actionHistorique(FEEDBACK_HISTORIQUE_TABLE, feedbackHistoCols, feedbackId, ancienMessage));
          }
          actions.push(["UpdateRecord", FEEDBACK_TABLE, feedbackId, champs]);
          return grist.docApi.applyUserActions(actions);
        })
        .then(function () {
          viderPending(key);
          editingFeedbackId = null;
          return chargerFeedback();
        })
        .then(render)
        .catch(function (err) {
          console.error("[Feedback] Échec de la modification :", err);
          statusEl.textContent = "Erreur : " + (err && err.message ? err.message : "réessaie.");
          statusEl.setAttribute("data-state", "error");
          submitBtn.disabled = false;
        });
    });
  }

  // Champs à écrire pour "supprimer" (masquer) une ligne. Le drapeau est
  // Supprime_masque_du_widget_ ; la date de suppression n'est écrite que si
  // la colonne existe réellement dans la table (son identifiant peut différer
  // d'une table à l'autre : on la repère par son nom normalisé).
  function champsSuppression(cols) {
    var champs = { Supprime_masque_du_widget_: true };
    var colDate = null;
    (cols || []).forEach(function (c) {
      var n = normaliser(c);
      if (!colDate && n.indexOf("date") === 0 && n.indexOf("suppression") !== -1) colDate = c;
    });
    if (colDate) {
      champs[colDate] = Math.floor(Date.now() / 1000);
    } else {
      console.warn("[Feedback] Colonne de date de suppression introuvable (colonnes lues :", cols, ") — suppression sans date.");
    }
    return champs;
  }

  function supprimerFeedback(feedbackId) {
    if (!window.confirm("Supprimer définitivement ce retour de l'affichage ? (il reste conservé pour l'historique)")) {
      return;
    }
    var ancien = allFeedback.filter(function (r) { return r.id === feedbackId; })[0];
    var ancienMessage = ancien ? ancien.fields.Message || "" : "";

    var actions = [];
    if (feedbackHistoriqueDisponible) {
      actions.push(actionHistorique(FEEDBACK_HISTORIQUE_TABLE, feedbackHistoCols, feedbackId, ancienMessage));
    }
    actions.push(["UpdateRecord", FEEDBACK_TABLE, feedbackId, champsSuppression(feedbackCols)]);

    grist.docApi
      .applyUserActions(actions)
      .then(function () {
        return chargerFeedback();
      })
      .then(render)
      .catch(function (err) {
        console.error("[Feedback] Échec de la suppression du feedback :", err);
        window.alert("Erreur lors de la suppression : " + (err && err.message ? err.message : "réessaie."));
      });
  }

  /* ==========================
     FIL DE REPONSES PAR FEEDBACK
     ========================== */
  // La valeur de la colonne de liaison peut être un nombre (Référence), une
  // liste (Référence liste : ["L", id] ou [id]), un texte ("12") ou un objet.
  function lieAuFeedback(val, feedbackId) {
    if (val == null || val === "") return false;
    if (Array.isArray(val)) {
      return (val[0] === "L" ? val.slice(1) : val).some(function (v) { return lieAuFeedback(v, feedbackId); });
    }
    if (typeof val === "object") return Number(val.rowId != null ? val.rowId : val.id) === feedbackId;
    return Number(val) === feedbackId;
  }

  function reponsesPour(feedbackId) {
    return allReponses
      .filter(function (r) { return !!reponsesRefCol && lieAuFeedback(r.fields[reponsesRefCol], feedbackId) && r.fields.Supprime_masque_du_widget_ !== true; })
      .sort(function (a, b) { return (a.fields.Date_d_envoi || 0) - (b.fields.Date_d_envoi || 0); });
  }

  function renderRepliesList(feedbackId) {
    var liste = reponsesPour(feedbackId);
    return liste
      .map(function (r) {
        if (editingReponseId === r.id) {
          return renderReponseEditForm(r);
        }
        var auteur = libelleAuteur(r.fields) || "Quelqu'un de l'équipe";
        return (
          '<div class="reply">' +
          '<p class="reply-meta">' + escapeHtml(auteur) + " — " + formatDate(r.fields.Date_d_envoi) + "</p>" +
          '<p class="reply-message">' + escapeHtml(r.fields.Message || "") + "</p>" +
          (pjReponsesDispo ? renderPieces(piecesRecord(r.fields, "reponses")) : "") +
          (estMaReponse(r.id)
            ? '<div class="item-actions">' +
              '<button type="button" class="action-btn reponse-edit-btn" data-reponse-id="' + r.id + '">' + ICONE_MODIFIER + "Modifier</button>" +
              '<button type="button" class="action-btn action-danger reponse-delete-btn" data-reponse-id="' + r.id + '">' + ICONE_SUPPRIMER + "Supprimer</button>" +
              "</div>"
            : "") +
          "</div>"
        );
      })
      .join("");
  }

  function renderReponseEditForm(r) {
    var key = "edit-reponse-" + r.id;
    return (
      '<form class="reponse-edit-form" data-reponse-id="' + r.id + '">' +
      '<textarea class="reponse-edit-message" required>' + escapeHtml(r.fields.Message || "") + "</textarea>" +
      (pjReponsesDispo ? '<div class="field" style="margin-top:8px;">' + renderPicker(key, piecesRecord(r.fields, "reponses")) + "</div>" : "") +
      '<div class="reply-form-actions" style="margin-top:8px;">' +
      '<button type="submit" class="reply-submit">Enregistrer</button>' +
      '<button type="button" class="reponse-edit-cancel replies-toggle">Annuler</button>' +
      '<span class="reply-status" role="status" aria-live="polite"></span>' +
      "</div>" +
      "</form>"
    );
  }

  function wireReponseEditForm(form) {
    var reponseId = Number(form.getAttribute("data-reponse-id"));
    var key = "edit-reponse-" + reponseId;

    form.querySelector(".reponse-edit-cancel").addEventListener("click", function () {
      viderPending(key);
      editingReponseId = null;
      render();
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var submitBtn = form.querySelector(".reply-submit");
      var statusEl = form.querySelector(".reply-status");
      var message = form.querySelector(".reponse-edit-message").value.trim();
      if (!message) {
        statusEl.textContent = "Le message ne peut pas être vide.";
        statusEl.setAttribute("data-state", "error");
        return;
      }

      var ancien = allReponses.filter(function (r) { return r.id === reponseId; })[0];
      var ancienMessage = ancien ? ancien.fields.Message || "" : "";
      var existants = ancien ? piecesRecord(ancien.fields, "reponses") : [];
      var retires = retiresMap[key] || [];
      var nouveaux = pendingFiles[key] || [];
      var modifPJ = pjReponsesDispo && (nouveaux.length > 0 || retires.length > 0);

      submitBtn.disabled = true;
      statusEl.textContent = nouveaux.length ? "Préparation des fichiers…" : "Enregistrement…";
      statusEl.setAttribute("data-state", "");

      (modifPJ ? construirePJ(key, existants, nouveaux, "reponses", true) : Promise.resolve(null))
        .then(function (champsPJ) {
          var champs = { Message: message };
          if (modifPJ) Object.assign(champs, champsPJ);
          var actions = [];
          if (reponsesHistoriqueDisponible) {
            actions.push(actionHistorique(REPONSES_HISTORIQUE_TABLE, reponsesHistoCols, reponseId, ancienMessage));
          }
          actions.push(["UpdateRecord", REPONSES_TABLE, reponseId, champs]);
          return grist.docApi.applyUserActions(actions);
        })
        .then(function () {
          viderPending(key);
          editingReponseId = null;
          return chargerReponses();
        })
        .then(render)
        .catch(function (err) {
          console.error("[Feedback] Échec de la modification de la réponse :", err);
          statusEl.textContent = "Erreur : " + (err && err.message ? err.message : "réessaie.");
          statusEl.setAttribute("data-state", "error");
          submitBtn.disabled = false;
        });
    });
  }

  function supprimerReponse(reponseId) {
    if (!window.confirm("Supprimer définitivement cette réponse de l'affichage ? (elle reste conservée pour l'historique)")) {
      return;
    }
    grist.docApi
      .applyUserActions([["UpdateRecord", REPONSES_TABLE, reponseId, champsSuppression(reponsesCols)]])
      .then(function () {
        return chargerReponses();
      })
      .then(render)
      .catch(function (err) {
        console.error("[Feedback] Échec de la suppression de la réponse :", err);
        window.alert("Erreur lors de la suppression : " + (err && err.message ? err.message : "réessaie."));
      });
  }

  function renderReplyForm(feedbackId) {
    return (
      '<form class="reply-form" data-feedback-id="' + feedbackId + '">' +
      '<label for="reply-input-' + feedbackId + '" class="field-hint" style="margin:0;">Répondre à ce retour</label>' +
      '<textarea id="reply-input-' + feedbackId + '" placeholder="Écris ta réponse..." required></textarea>' +
      (pjReponsesDispo ? renderPicker("reply-" + feedbackId, []) : "") +
      '<div class="reply-form-actions">' +
      '<button type="submit" class="reply-submit">Envoyer la réponse</button>' +
      '<span class="reply-status" role="status" aria-live="polite"></span>' +
      "</div>" +
      "</form>"
    );
  }

  function wireReplyForm(form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var feedbackId = Number(form.getAttribute("data-feedback-id"));
      var key = "reply-" + feedbackId;
      var textarea = form.querySelector("textarea");
      var submitBtn = form.querySelector(".reply-submit");
      var statusEl = form.querySelector(".reply-status");
      var message = textarea.value.trim();
      if (!message) {
        statusEl.textContent = "Écris un message avant d'envoyer.";
        statusEl.setAttribute("data-state", "error");
        return;
      }
      if (!reponsesRefCol) {
        statusEl.textContent = "Colonne de liaison vers Feedback introuvable dans FeedbackReponses (voir la console).";
        statusEl.setAttribute("data-state", "error");
        return;
      }
      var fichiers = pjReponsesDispo ? pendingFiles[key] || [] : [];
      submitBtn.disabled = true;
      statusEl.textContent = fichiers.length ? "Préparation des fichiers…" : "Envoi en cours…";
      statusEl.setAttribute("data-state", "");

      (fichiers.length ? construirePJ(key, [], fichiers, "reponses", false) : Promise.resolve({}))
        .then(function (champsPJ) {
          var champs = {
            Message: message,
            Date_d_envoi: Math.floor(Date.now() / 1000),
          };
          ajouterAuteur(champs);
          champs[reponsesRefCol] = feedbackId;
          Object.assign(champs, champsPJ);
          return grist.docApi.applyUserActions([["AddRecord", REPONSES_TABLE, null, champs]]);
        })
        .then(function () {
          viderPending(key);
          openRepliesList[feedbackId] = true;
          openReplyForm[feedbackId] = false;
          return chargerReponses();
        })
        .then(render)
        .catch(function (err) {
          console.error("[Feedback] Échec de l'envoi de la réponse :", err);
          statusEl.textContent = "Erreur : " + (err && err.message ? err.message : "réessaie.");
          statusEl.setAttribute("data-state", "error");
          submitBtn.disabled = false;
        });
    });
  }

  /* ==========================
     FILTRES + LISTE DE TOUS LES RETOURS
     ========================== */
  function formatDate(epochSeconds) {
    if (!epochSeconds) return "";
    return new Date(epochSeconds * 1000).toLocaleDateString("fr-FR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function appliquerFiltres(records) {
    var type = els.fType.value;
    var q = els.fSearch.value.trim().toLowerCase();

    return records.filter(function (r) {
      var f = r.fields;
      if (f.Supprime_masque_du_widget_ === true) return false;
      if (type && f.Type !== type) return false;
      if (q && (f.Message || "").toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
  }

  function tagIcon(type) {
    if (type === "Bug") return "🐛 ";
    return "💡 ";
  }

  function renderItem(r) {
    var f = r.fields;
    var auteur = libelleAuteur(f);
    var nbReponses = reponsesPour(r.id).length;
    var listeOuverte = !!openRepliesList[r.id];
    var formOuvert = !!openReplyForm[r.id];
    var peutModifier = estMonFeedback(r.id) && (f.Statut || "Nouveau") === "Nouveau";

    if (editingFeedbackId === r.id) {
      return '<div class="item" data-id="' + r.id + '">' + renderFeedbackEditForm(r) + "</div>";
    }

    return (
      '<div class="item" data-id="' + r.id + '">' +
      '<div class="item-top">' +
      '<div class="item-tags">' +
      '<span class="tag" data-type="' + escapeHtml(f.Type || "") + '">' + tagIcon(f.Type) + escapeHtml(f.Type || "Retour") + "</span>" +
      "</div>" +
      '<span class="item-date">' + formatDate(f.Date_d_envoi) + (auteur ? " — " + escapeHtml(auteur) : "") + "</span>" +
      "</div>" +
      '<p class="item-message">' + escapeHtml(f.Message || "") + "</p>" +
      (pjFeedbackDispo ? renderPieces(piecesRecord(f, "feedback")) : "") +
      (peutModifier
        ? '<div class="item-actions">' +
          '<button type="button" class="action-btn feedback-edit-btn" data-feedback-id="' + r.id + '">' + ICONE_MODIFIER + "Modifier mon retour</button>" +
          '<button type="button" class="action-btn action-danger feedback-delete-btn" data-feedback-id="' + r.id + '">' + ICONE_SUPPRIMER + "Supprimer</button>" +
          "</div>"
        : "") +
      '<div class="item-bottom">' +
      '<div class="item-bottom-left">' +
      (jeSuisAdmin()
        ? '<div class="statut-group">' +
          '<label for="statut-' + r.id + '">Statut</label>' +
          '<select class="statut-select" id="statut-' + r.id + '" data-row-id="' + r.id + '" data-value="' + escapeHtml(f.Statut || "Nouveau") + '">' +
          STATUTS
            .map(function (s) {
              return '<option value="' + s + '"' + (f.Statut === s ? " selected" : "") + ">" + s + "</option>";
            })
            .join("") +
          "</select>" +
          "</div>" +
          '<span class="save-hint" id="save-hint-' + r.id + '">Enregistré ✓</span>'
        : '<span class="statut-readonly">Statut : <strong>' + escapeHtml(f.Statut || "Nouveau") + "</strong></span>") +
      "</div>" +
      '<div class="item-bottom-right">' +
      '<span class="replies-count-slot">' +
      (nbReponses
        ? '<button type="button" class="replies-toggle replies-list-toggle" data-feedback-id="' + r.id + '">' +
          nbReponses + (nbReponses > 1 ? " réponses" : " réponse") +
          "</button>"
        : "") +
      "</span>" +
      (jeSuisAdmin() || estMonFeedback(r.id)
        ? '<button type="button" class="reply-form-btn reply-form-toggle" data-feedback-id="' + r.id + '" aria-expanded="' + (formOuvert ? "true" : "false") + '" aria-controls="reply-form-' + r.id + '">Répondre</button>'
        : "") +
      "</div>" +
      "</div>" +
      (nbReponses
        ? '<div class="replies-panel" id="replies-list-' + r.id + '"' + (listeOuverte ? "" : " hidden") + ">" +
          renderRepliesList(r.id) +
          "</div>"
        : "") +
      (jeSuisAdmin() || estMonFeedback(r.id)
        ? '<div class="replies-panel" id="reply-form-' + r.id + '"' + (formOuvert ? "" : " hidden") + ">" +
          renderReplyForm(r.id) +
          "</div>"
        : "") +
      "</div>"
    );
  }

  function render() {
    var filtered = appliquerFiltres(allFeedback);

    els.countPill.textContent = filtered.length + (filtered.length > 1 ? " retours" : " retour");
    majChampNouveau();

    STATUTS.forEach(function (statut) {
      var group = filtered
        .filter(function (r) { return (r.fields.Statut || "Nouveau") === statut; })
        .sort(function (a, b) { return (b.fields.Date_d_envoi || 0) - (a.fields.Date_d_envoi || 0); });

      document.getElementById(STATUT_COUNT_ID[statut]).textContent = group.length;

      var listEl = document.getElementById(STATUT_LIST_ID[statut]);
      if (!group.length) {
        listEl.innerHTML = '<p class="empty-state">Aucun retour ' + (statut === "Nouveau" ? "nouveau" : statut.toLowerCase()) + " pour l'instant.</p>";
        return;
      }
      listEl.innerHTML = group.map(renderItem).join("");
    });

    document.querySelectorAll(".statut-select").forEach(function (select) {
      select.addEventListener("change", function () {
        var rowId = Number(select.getAttribute("data-row-id"));
        var nouveauStatut = select.value;
        select.setAttribute("data-value", nouveauStatut);
        grist.docApi
          .applyUserActions([["UpdateRecord", FEEDBACK_TABLE, rowId, { Statut: nouveauStatut }]])
          .then(function () {
            var item = allFeedback.filter(function (r) { return r.id === rowId; })[0];
            if (item) item.fields.Statut = nouveauStatut;
            render();
          })
          .catch(function (err) {
            console.error("[Feedback] Échec de la mise à jour du statut :", err);
            select.value = select.getAttribute("data-value");
          });
      });
    });

    document.querySelectorAll(".replies-list-toggle").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var feedbackId = Number(btn.getAttribute("data-feedback-id"));
        openRepliesList[feedbackId] = !openRepliesList[feedbackId];
        var panel = document.getElementById("replies-list-" + feedbackId);
        if (panel) panel.hidden = !openRepliesList[feedbackId];
      });
    });

    document.querySelectorAll(".reply-form-toggle").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var feedbackId = Number(btn.getAttribute("data-feedback-id"));
        openReplyForm[feedbackId] = !openReplyForm[feedbackId];
        var panel = document.getElementById("reply-form-" + feedbackId);
        if (panel) panel.hidden = !openReplyForm[feedbackId];
      });
    });

    document.querySelectorAll(".reply-form").forEach(wireReplyForm);

    document.querySelectorAll(".feedback-edit-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        editingFeedbackId = Number(btn.getAttribute("data-feedback-id"));
        render();
      });
    });
    document.querySelectorAll(".feedback-edit-form").forEach(wireFeedbackEditForm);

    document.querySelectorAll(".feedback-delete-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        supprimerFeedback(Number(btn.getAttribute("data-feedback-id")));
      });
    });

    document.querySelectorAll(".reponse-edit-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        editingReponseId = Number(btn.getAttribute("data-reponse-id"));
        render();
      });
    });
    document.querySelectorAll(".reponse-delete-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        supprimerReponse(Number(btn.getAttribute("data-reponse-id")));
      });
    });
    document.querySelectorAll(".reponse-edit-form").forEach(wireReponseEditForm);
  }

  els.fType.addEventListener("change", render);
  els.fSearch.addEventListener("input", render);
  els.fReset.addEventListener("click", function () {
    els.fType.value = "";
    els.fSearch.value = "";
    render();
  });

  /* ==========================
     CHARGEMENT DES DONNEES
     ========================== */
  function tableVersRecords(table) {
    return table.id.map(function (rowId, i) {
      var fields = {};
      Object.keys(table).forEach(function (col) {
        if (col === "id") return;
        fields[col] = table[col][i];
      });
      return { id: rowId, fields: fields };
    });
  }

  // Colonne de type "Pièces jointes" : "Pieces_Jointes" ou tout nom équivalent
  // (hors colonne texte Images_Jointes).
  function detecterColonneAtt(table) {
    if (!table) return null;
    var cols = Object.keys(table).filter(function (c) { return c !== PJ_COL; });
    if (cols.indexOf("Pieces_Jointes") !== -1) return "Pieces_Jointes";
    var c = cols.filter(function (x) { return normaliser(x) === "piecesjointes"; })[0];
    return c || null;
  }

  function chargerFeedback() {
    return grist.docApi
      .fetchTable(FEEDBACK_TABLE)
      .then(function (table) {
        txtFeedbackDispo = !!table && Object.prototype.hasOwnProperty.call(table, PJ_COL);
        attColFeedback = detecterColonneAtt(table);
        pjFeedbackDispo = txtFeedbackDispo || !!attColFeedback;
        feedbackCols = table ? Object.keys(table) : [];
        allFeedback = table && table.id ? tableVersRecords(table) : [];
      })
      .then(preparerPJ)
      .catch(function (err) {
        console.error("[Feedback] La table Feedback n'existe pas encore ou n'est pas accessible :", err);
        allFeedback = [];
        pjFeedbackDispo = false;
        txtFeedbackDispo = false;
        attColFeedback = null;
      });
  }

  // Repère la colonne Référence → Feedback de FeedbackReponses : "FeedbackId"
  // si elle existe, sinon la première colonne dont le nom commence par
  // "feedback" (ex. "Feedback concerné" → Feedback_concerne), comme pour les
  // tables d'historique.
  function detecterColonneLiaison(table) {
    if (!table) return null;
    var cols = Object.keys(table).filter(function (c) { return c !== "id" && c !== "manualSort"; });
    if (cols.indexOf("FeedbackId") !== -1) return "FeedbackId";
    var candidats = cols.filter(function (c) { return normaliser(c).indexOf("feedback") === 0; });
    if (candidats.length) {
      console.info("[Feedback] Colonne de liaison de FeedbackReponses détectée :", candidats[0]);
      return candidats[0];
    }
    console.error("[Feedback] Aucune colonne de liaison vers Feedback trouvée dans FeedbackReponses. Colonnes lues :", cols);
    return null;
  }

  function chargerReponses() {
    return grist.docApi
      .fetchTable(REPONSES_TABLE)
      .then(function (table) {
        txtReponsesDispo = !!table && Object.prototype.hasOwnProperty.call(table, PJ_COL);
        attColReponses = detecterColonneAtt(table);
        pjReponsesDispo = txtReponsesDispo || !!attColReponses;
        reponsesRefCol = detecterColonneLiaison(table);
        reponsesCols = table ? Object.keys(table) : [];
        allReponses = table && table.id ? tableVersRecords(table) : [];
        if (allReponses.length && reponsesRefCol) {
          var ex = allReponses[allReponses.length - 1];
          console.info("[Feedback] Diagnostic réponses — colonne de liaison :", reponsesRefCol,
            "| nb de lignes :", allReponses.length,
            "| valeur de liaison de la dernière ligne :", ex.fields[reponsesRefCol],
            "| colonnes :", Object.keys(ex.fields));
        }
        if (table && table.id) els.setupNote.hidden = true;
      })
      .then(preparerPJ)
      .catch(function (err) {
        console.error("[Feedback] Table FeedbackReponses indisponible :", err);
        allReponses = [];
        pjReponsesDispo = false;
        txtReponsesDispo = false;
        attColReponses = null;
        els.setupNote.hidden = false;
        els.setupNote.innerHTML =
          "Le fil de réponses n'est pas encore actif : la table <strong>FeedbackReponses</strong> " +
          "n'existe pas dans ce document Grist.";
      });
  }

  /* ==========================
     HISTORIQUE DES MODIFICATIONS
     ========================== */
  // Les colonnes des tables d'historique sont repérées par leur nom normalisé
  // (sans accents, ni espaces, ni ponctuation) plutôt que devinées. L'historique
  // n'est activé que si la colonne de liaison, "Ancien message" et "Date de
  // modification" sont trouvées.
  function normaliser(s) {
    return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function mapperColonnesHistorique(table, prefixeRef) {
    if (!table) return null;
    var map = {};
    Object.keys(table).forEach(function (col) {
      if (col === "id" || col === "manualSort") return;
      var n = normaliser(col);
      if (n.indexOf(prefixeRef) === 0) map.ref = col;
      else if (n === "ancienmessage") map.ancien = col;
      else if (n === "datedemodification") map.date = col;
      else if (n.indexOf("auteur") === 0 && /email$/.test(n)) map.email = col;
      else if (n.indexOf("auteur") === 0 && /nom$/.test(n)) map.nom = col;
    });
    return map.ref && map.ancien && map.date ? map : null;
  }

  function actionHistorique(tableName, map, refId, ancienMessage) {
    var f = {};
    f[map.ref] = refId;
    f[map.ancien] = ancienMessage;
    f[map.date] = Math.floor(Date.now() / 1000);
    if (map.email) f[map.email] = monEmailActuel;
    if (map.nom) f[map.nom] = monNomActuel;
    return ["AddRecord", tableName, null, f];
  }

  function sonderHistoriques() {
    function sonder(nom, prefixeRef) {
      return grist.docApi
        .fetchTable(nom)
        .then(function (table) {
          var map = mapperColonnesHistorique(table, prefixeRef);
          if (!map) {
            console.warn("[Feedback] " + nom + " : colonnes attendues introuvables, historique désactivé. Colonnes lues :", table ? Object.keys(table) : []);
          }
          return map;
        })
        .catch(function () {
          return null;
        });
    }
    return Promise.all([
      sonder(FEEDBACK_HISTORIQUE_TABLE, "feedbackconcern"),
      sonder(REPONSES_HISTORIQUE_TABLE, "reponseconcern"),
    ]).then(function (res) {
      feedbackHistoCols = res[0];
      reponsesHistoCols = res[1];
      feedbackHistoriqueDisponible = !!res[0];
      reponsesHistoriqueDisponible = !!res[1];
    });
  }

  /* ==========================
     INITIALISATION GRIST
     ========================== */
  grist.ready({ requiredAccess: "full" });

  Promise.all([chargerFeedback(), chargerReponses(), chargerMonUtilisateur(), sonderHistoriques()]).then(render);

  grist.onRecords(function () {
    Promise.all([chargerFeedback(), chargerReponses(), chargerMonUtilisateur()]).then(render);
  });
})();