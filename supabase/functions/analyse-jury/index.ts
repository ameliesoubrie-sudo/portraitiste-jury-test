import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const r2 = (n: number | null) => (n == null ? null : Math.round(n * 100) / 100);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { code } = await req.json();
    const c = String(code || "").trim().toUpperCase();
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Contrôle d'accès : administrateur ou président du jury
    const { data: estAdmin } = await db.rpc("_est_admin", { p_code: String(code || "") });
    let demandeur = "admin";
    if (!estAdmin) {
      const { data: j } = await db.from("juges").select("prenom,nom,est_president,actif").eq("code", c).maybeSingle();
      if (!j || !j.est_president || !j.actif) return json({ error: "Accès réservé au président du jury" }, 403);
      demandeur = `${j.prenom} ${j.nom}`;
    }

    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) return json({ error: "Clé API Claude non configurée (secret ANTHROPIC_API_KEY)" }, 500);

    const [{ data: juges }, { data: dossiers }, { data: photos }, { data: criteres }] = await Promise.all([
      db.from("juges").select("id,prenom,nom,est_president,actif").eq("actif", true),
      db.from("dossiers").select("id,numero,note_2025"),
      db.from("photos").select("id,dossier_id,numero").not("numero", "is", null),
      db.from("criteres").select("numero,nom").order("numero"),
    ]);
    // notes paginées (jusqu'à ~20 000 lignes)
    const notes: { juge_id: string; photo_id: string; critere: number; valeur: number }[] = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await db.from("notes").select("juge_id,photo_id,critere,valeur").range(from, from + 999);
      if (!data?.length) break;
      notes.push(...data.map((n) => ({ ...n, valeur: Number(n.valeur) })));
      if (data.length < 1000) break;
    }
    if (notes.length < 100) return json({ error: "Pas encore assez de notes pour une analyse utile" }, 400);

    const nomJ = (id: string) => { const j = juges!.find((x) => x.id === id)!; return `${j.prenom} ${j.nom}${j.est_president ? " (président)" : ""}`; };
    const photo = Object.fromEntries(photos!.map((p) => [p.id, p]));
    const dossierNum = Object.fromEntries(dossiers!.map((d) => [d.id, d.numero]));

    // tot[j][p] = total /20 ; crit[j][p][c]
    const crit: Record<string, Record<string, Record<number, number>>> = {};
    for (const n of notes) { if (!photo[n.photo_id]) continue; ((crit[n.juge_id] ||= {})[n.photo_id] ||= {})[n.critere] = n.valeur; }
    const tot: Record<string, Record<string, number>> = {};
    for (const j in crit) for (const p in crit[j]) { const v = Object.values(crit[j][p]); if (v.length === 5) (tot[j] ||= {})[p] = v.reduce((a, b) => a + b, 0); }

    // profil de chaque juge
    const profils = juges!.map((j) => {
      const devs: number[] = [], devCrit: Record<number, number[]> = {};
      for (const p in tot[j.id] || {}) {
        const autres = juges!.filter((o) => o.id !== j.id && tot[o.id]?.[p] != null);
        if (!autres.length) continue;
        devs.push(tot[j.id][p] - mean(autres.map((o) => tot[o.id][p]))!);
        for (let k = 1; k <= 5; k++) {
          const ac = autres.map((o) => crit[o.id][p][k]);
          (devCrit[k] ||= []).push(crit[j.id][p][k] - mean(ac)!);
        }
      }
      const mine = Object.values(tot[j.id] || {});
      const sd = mine.length > 1 ? Math.sqrt(mean(mine.map((x) => (x - mean(mine)!) ** 2))!) : null;
      return {
        juge: nomJ(j.id), photos_notees: mine.length, moyenne_sur_20: r2(mean(mine)), ecart_type: r2(sd),
        ecart_moyen_vs_autres: r2(mean(devs)), ecart_absolu_moyen: r2(mean(devs.map(Math.abs))),
        ecart_par_critere: Object.fromEntries(criteres!.map((c) => [c.nom, r2(mean(devCrit[c.numero] || []))])),
      };
    });

    // accord entre paires de juges (écart absolu moyen sur photos communes)
    const paires: Record<string, Record<string, number | null>> = {};
    for (const a of juges!) for (const b of juges!) {
      if (a.id >= b.id) continue;
      const com = Object.keys(tot[a.id] || {}).filter((p) => tot[b.id]?.[p] != null);
      if (com.length < 12) continue;
      (paires[nomJ(a.id)] ||= {})[nomJ(b.id)] = r2(mean(com.map((p) => Math.abs(tot[a.id][p] - tot[b.id][p]))));
    }

    // moyennes par dossier
    const parDossier = dossiers!.map((d) => {
      const ps = photos!.filter((p) => p.dossier_id === d.id);
      const parJuge: Record<string, number | null> = {};
      for (const j of juges!) { const v = ps.map((p) => tot[j.id]?.[p.id]); if (ps.length === 12 && v.every((x) => x != null)) parJuge[nomJ(j.id)] = r2(mean(v as number[])); }
      const vals = Object.values(parJuge).filter((x) => x != null) as number[];
      return { dossier: `D${String(d.numero).padStart(2, "0")}`, moyenne_jury: r2(mean(vals)), note_officielle_2025: d.note_2025 == null ? null : Number(d.note_2025), notes_par_juge: parJuge };
    }).sort((a, b) => a.dossier.localeCompare(b.dossier));

    // plus gros désaccords photo par photo
    const desaccords = photos!.map((p) => {
      const v = juges!.map((j) => ({ j: nomJ(j.id), t: tot[j.id]?.[p.id] })).filter((x) => x.t != null) as { j: string; t: number }[];
      if (v.length < 3) return null;
      const min = v.reduce((a, b) => (b.t < a.t ? b : a)), max = v.reduce((a, b) => (b.t > a.t ? b : a));
      return { dossier: `D${String(dossierNum[p.dossier_id]).padStart(2, "0")}`, photo: p.numero, ecart: r2(max.t - min.t), plus_haut: `${max.j} ${max.t}`, plus_bas: `${min.j} ${min.t}` };
    }).filter(Boolean).sort((a, b) => b!.ecart! - a!.ecart!).slice(0, 15);

    const donnees = { nb_juges_actifs: juges!.length, nb_notes: notes.length, criteres: criteres!.map((c) => c.nom), profils, accord_entre_paires: paires, par_dossier: parDossier, plus_gros_desaccords: desaccords };

    const prompt = `Tu es l'analyste du jury de la qualification "Portraitiste de France 2027" organisée par la FFPMI (Fédération Française de la Photographie et des Métiers de l'Image).
Contexte : session TEST. Les juges ont noté des dossiers anonymes de l'édition 2025. Chaque dossier = 12 photos, chaque photo notée sur 5 critères de 0 à 4 (par demi-point), soit /20. Titres 2027 : Portraitiste de France si moyenne >= 12 sans photo < 9 ; Honneur >= 14 sans photo < 12 ; Excellence >= 16 sans photo < 12. Pour le vrai concours, le jury sera réparti en 3 tables de 5 juges (16 juges au total, dont le président du jury).

Voici les statistiques calculées (JSON) :
${JSON.stringify(donnees)}

Rédige en français une analyse claire pour la présidente de la fédération et le président du jury, en Markdown, avec ces parties :
1. **En bref** : 4 à 6 constats clés.
2. **Profils des juges** : tableau (juge, moyenne, écart vs autres, profil : sévère / généreux / dans la moyenne / irrégulier) puis commentaire sur les cas notables, y compris sur quels critères chacun s'écarte.
3. **Critères qui divisent** : sur quels critères les juges divergent le plus, et ce que ça suggère pour le briefing du jury.
4. **Comparaison avec les résultats officiels 2025** : le jury test classe-t-il les dossiers comme le jury 2025 ? Écarts notables.
5. **Proposition de 3 tables** : 3 tables de 5 juges équilibrées (sévérité moyenne proche entre les tables, mélange de profils, éviter de regrouper les juges les plus extrêmes), avec la moyenne d'écart de chaque table. Indique où placer le 16e juge, en proposant que le président du jury reste hors table pour arbitrer, sauf si les données justifient autre chose. Explique la logique en quelques lignes.
6. **Points d'attention** pour le briefing des juges.
Sois factuel et nuancé : signale quand le nombre de notes est trop faible pour conclure. Pas de tiret cadratin, utilise des tirets simples. Pas de formule de politesse.`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 6000, messages: [{ role: "user", content: prompt }] }),
    });
    const out = await r.json();
    if (!r.ok) return json({ error: "Erreur API Claude : " + (out?.error?.message || r.status) }, 502);
    const texte = (out.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n").replace(/—/g, "-");

    await db.from("analyses").insert({ demandeur, contenu: texte });
    return json({ ok: true, contenu: texte });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
