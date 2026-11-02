import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Lit largeur / hauteur dans l'en-tête JPEG (marqueur SOF)
function dimensionsJpeg(b: Uint8Array): { w: number; h: number } | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i < b.length - 9) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
    }
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return null;
}

async function telecharger(id: string): Promise<Uint8Array> {
  const urls = [
    `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`,
    `https://drive.google.com/uc?export=download&id=${id}`,
    `https://lh3.googleusercontent.com/d/${id}=s0`,
  ];
  let derniere = "";
  for (const u of urls) {
    try {
      const r = await fetch(u, { redirect: "follow" });
      const ct = r.headers.get("content-type") || "";
      if (r.ok && ct.startsWith("image/")) return new Uint8Array(await r.arrayBuffer());
      derniere = `${r.status} ${ct}`;
    } catch (e) { derniere = String(e); }
  }
  throw new Error("Drive inaccessible (" + derniere + ") : le dossier est-il partagé avec « Tous les utilisateurs disposant du lien » ?");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { code, lot, relancer_erreurs } = await req.json();
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: estAdmin } = await db.rpc("_est_admin", { p_code: String(code || "") });
    if (!estAdmin) return json({ error: "Code administrateur invalide" }, 403);

    if (relancer_erreurs) await db.from("photos").update({ import_erreur: null }).not("import_erreur", "is", null);
    const taille = Math.min(Number(lot) || 12, 30);
    const { data: todo } = await db.from("photos")
      .select("id,drive_file_id,dossier_id,ordre_import,dossiers(numero)")
      .is("storage_path", null).is("import_erreur", null).order("ordre_import").limit(taille);

    const resultats = await Promise.all((todo || []).map(async (p) => {
      try {
        const bytes = await telecharger(p.drive_file_id);
        const dim = dimensionsJpeg(bytes);
        // chemin anonyme : numéro de dossier + identifiant interne, jamais le nom du candidat
        const num = String((p as unknown as { dossiers: { numero: number } }).dossiers.numero).padStart(2, "0");
        const chemin = `d${num}/${p.id}.jpg`;
        const up = await db.storage.from("photos").upload(chemin, bytes, { contentType: "image/jpeg", upsert: true, cacheControl: "31536000" });
        if (up.error) throw new Error(up.error.message);
        await db.from("photos").update({ storage_path: chemin, largeur: dim?.w ?? null, hauteur: dim?.h ?? null, import_erreur: null }).eq("id", p.id);
        return { id: p.id, ok: true };
      } catch (e) {
        await db.from("photos").update({ import_erreur: String((e as Error).message || e).slice(0, 300) }).eq("id", p.id);
        return { id: p.id, ok: false, erreur: String((e as Error).message || e) };
      }
    }));

    const { count: restant } = await db.from("photos").select("id", { count: "exact", head: true }).is("storage_path", null).is("import_erreur", null);
    const { count: erreurs } = await db.from("photos").select("id", { count: "exact", head: true }).not("import_erreur", "is", null);
    const { count: faits } = await db.from("photos").select("id", { count: "exact", head: true }).not("storage_path", "is", null);
    return json({ traites: resultats.length, reussis: resultats.filter((r) => r.ok).length, faits, restant, erreurs, detail: resultats.filter((r) => !r.ok).slice(0, 3) });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
