// ════════════════════════════════════════════════════════════════════
// Edge Function : sms-veille (v2 — 16/06/2026 — MIGRÉ Brevo → OVH)
// ════════════════════════════════════════════════════════════════════
// SMS veille (livraison demain) en scannant les tournées de demain.
// Legacy : le canal recommandé est sms-auto (phase veille) ; conservé
// pour compatibilité. v2 : envoi via OVH, credentials via env (plus de
// clé en dur), message aligné (plus de faux créneau "08:00-17:00").
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { envoyerSMSOVH } from "../_shared/ovh-sms.ts";

const SB_URL    = Deno.env.get("SUPABASE_URL") ?? "";
const SB_SR_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const supabase = createClient(SB_URL, SB_SR_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

    const demain = new Date();
    demain.setDate(demain.getDate() + 1);
    const demainStr = demain.toISOString().split("T")[0];
    const dateFr = demain.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });

    const { data: tournees, error } = await supabase
      .from("tournees")
      .select("*")
      .eq("date", demainStr);

    if (error) throw error;
    if (!tournees || tournees.length === 0) {
      return new Response(JSON.stringify({ message: "Aucune tournée demain", sent: 0 }), { headers: CORS });
    }

    let sent = 0;
    let fail = 0;

    for (const tournee of tournees) {
      const stops = Array.isArray(tournee.stops) ? tournee.stops : [];
      for (const s of stops) {
        if (!s.tel || s.tel.length < 8) { fail++; continue; }
        if (["livré", "annulé"].includes(s.statut)) continue;

        const prenom = (s.client || "").replace(/^(M\.|Mme|Mr\.?)\s*/i, "").split(" ")[0];
        const msg = `Bonjour ${prenom}, votre livraison Maxiconfort (${s.produit || "votre commande"}) est prevue demain ${dateFr}. Le livreur vous appellera environ 1h avant son passage. Merci de rester joignable.`;

        const ok = await envoyerSMSOVH(s.tel, msg);
        if (ok) sent++; else fail++;
      }
    }

    return new Response(JSON.stringify({ success: true, sent, fail, date: demainStr }), { headers: CORS });

  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
  }
});
