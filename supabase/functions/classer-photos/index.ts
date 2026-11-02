import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const SUJETS = `1 : une femme enceinte seule
2 : deux enfants dont un de moins de 2 ans
3 : deux personnes de plus de 70 ans
4 : un groupe ou une famille de 5 personnes
5 : corporate, une personne dans son environnement professionnel, regard vers l'objectif
6, 7, 8 : portrait libre créatif (tous thèmes possibles)
9, 10 : un couple ou des mariés, libre
11, 12 : un couple ou des mariés en extérieur, debout, en pied (visibles de la tête aux pieds)`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { code, dossier_id, forcer } = await req.json();
    const url = Deno.env.get("SUPABASE_URL")!;
    const db = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: adm } = await db.from("parametres").select("valeur").eq("cle", "code_admin").single();
    if (!adm || adm.valeur !== String(code || "").trim().toUpperCase()) return json({ error: "Code administrateur invalide" }, 403);
    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) return json({ error: "Clé API Claude non configurée (secret ANTHROPIC_API_KEY)" }, 500);

    // dossier à traiter : celui demandé, sinon le prochain qui n'a pas ses 12 numéros
    let cible = dossier_id as string | undefined;
    const { data: ds } = await db.from("dossiers").select("id,numero").order("numero");
    const { data: ph } = await db.from("photos").select("id,dossier_id,numero,est_planche,storage_path,largeur,hauteur,ordre_import").order("ordre_import");
    const reste = ds!.filter((d) => ph!.filter((p) => p.dossier_id === d.id && p.numero).length < 12);
    if (!cible) cible = reste[0]?.id;
    if (!cible) return json({ ok: true, termine: true, restant: 0 });
    const d = ds!.find((x) => x.id === cible)!;
    const photos = ph!.filter((p) => p.dossier_id === cible && p.storage_path);
    if (!forcer && photos.filter((p) => p.numero).length === 12) return json({ ok: true, dossier: d.numero, deja: true, restant: reste.length });

    const lettres = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const contenu: unknown[] = [];
    photos.forEach((p, i) => {
      contenu.push({ type: "text", text: `Image ${lettres[i]} (${p.largeur}x${p.hauteur} px)` });
      contenu.push({ type: "image", source: { type: "url", url: `${url}/storage/v1/render/image/public/photos/${p.storage_path}?width=1100&resize=contain&quality=80` } });
    });
    contenu.push({ type: "text", text:
`Ces ${photos.length} images forment le dossier d'un candidat à la qualification photographique "Portraitiste de France". Le dossier contient 12 photos, une par sujet numéroté, et en général une planche-contact : une image paysage 1920x1080 sur fond blanc qui regroupe en vignettes les 12 photos du dossier, dans l'ordre de numérotation (lecture de gauche à droite, puis de haut en bas).

Les sujets :
${SUJETS}

Ta tâche : attribuer à chaque photo son numéro de sujet (1 à 12, chaque numéro une seule fois) et repérer la planche-contact.
- Si une planche-contact est présente, sers-t'en en priorité : retrouve chaque photo parmi les vignettes, sa position dans la planche donne son numéro.
- Sinon, déduis les numéros du contenu de chaque image. Pour les sujets en double ou en triple (6-8, 9-10, 11-12), l'ordre entre elles n'a pas d'importance.

Réponds UNIQUEMENT avec un objet JSON, sans texte autour, de la forme :
{"planche": "M" ou null, "attribution": {"A": 3, "B": 1, ...}, "confiance": "haute" | "moyenne" | "faible", "remarque": "une phrase courte si quelque chose est douteux, sinon chaîne vide"}` });

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 1500, messages: [{ role: "user", content: contenu }] }),
    });
    const out = await r.json();
    if (!r.ok) return json({ error: "Erreur API Claude : " + (out?.error?.message || r.status) }, 502);
    const texte = (out.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
    const m = texte.match(/\{[\s\S]*\}/);
    if (!m) return json({ error: "Réponse illisible de Claude", texte }, 502);
    const res = JSON.parse(m[0]);

    // validation : numéros 1-12 tous distincts
    const attrib: Record<string, number> = res.attribution || {};
    const nums = Object.values(attrib).map(Number);
    const valide = nums.length === 12 && new Set(nums).size === 12 && nums.every((n) => n >= 1 && n <= 12);
    if (!valide) return json({ ok: false, dossier: d.numero, error: "Attribution incomplète, à faire à la main", res });

    // application
    await db.from("photos").update({ numero: null, est_planche: false }).eq("dossier_id", cible);
    for (let i = 0; i < photos.length; i++) {
      const L = lettres[i];
      if (res.planche === L) await db.from("photos").update({ est_planche: true }).eq("id", photos[i].id);
      else if (attrib[L]) await db.from("photos").update({ numero: attrib[L] }).eq("id", photos[i].id);
    }
    await db.from("parametres").upsert({ cle: `classement_d${String(d.numero).padStart(2, "0")}`, valeur: JSON.stringify({ confiance: res.confiance, remarque: res.remarque }) });
    return json({ ok: true, dossier: d.numero, confiance: res.confiance, remarque: res.remarque, restant: reste.filter((x) => x.id !== cible).length });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
