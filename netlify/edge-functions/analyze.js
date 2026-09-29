// HazScan AI — proksi selamat ke Gemini.
// Kunci API disimpan sebagai environment variable GEMINI_API_KEY di Netlify, tidak pernah dihantar ke pelayar.
// Pilihan: GEMINI_MODEL (lalai gemini-3-flash-preview), RATE_LIMIT_PER_HOUR (lalai 30 imbasan sejam bagi setiap IP).

const hits = new Map(); // had kadar ringkas (per-instance, anggaran sahaja)

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

function buildPrompt(lokasi, konteks) {
  return `Anda ialah Pegawai Keselamatan dan Kesihatan (SHO) bertauliah JKKP di Malaysia. Lakukan HIRARC (Hazard Identification, Risk Assessment and Risk Control) ke atas gambar tempat kerja yang dilampirkan, mengikut Garis Panduan HIRARC JKKP 2008 dan Akta KKP 1994 (Pindaan 2022).

Maklumat daripada pengguna:
- Lokasi/jabatan: ${lokasi || "(tidak dinyatakan)"}
- Aktiviti/konteks: ${konteks || "(tidak dinyatakan)"}

Peraturan penting:
1. Kenal pasti HANYA hazard yang benar-benar kelihatan dalam gambar atau yang jelas tersirat daripadanya. Jangan reka hazard yang tiada. Jika gambar bukan tempat kerja, atau tiada hazard ketara, pulangkan senarai hazard kosong dan terangkan dalam "ringkasan".
2. Huraikan tempat sebenar yang kelihatan dalam gambar (jangan ikut label lokasi pengguna jika bercanggah; sebut percanggahan itu dalam ringkasan).
3. Kebarangkalian L (1-5): 1 hampir mustahil, 2 jarang berlaku, 3 mungkin berlaku, 4 berkemungkinan besar, 5 hampir pasti / sering.
   Keterukan S (1-5): 1 boleh diabaikan, 2 kecil (pertolongan cemas), 3 serius (cuti sakit/kecederaan tidak kekal), 4 maut/hilang upaya kekal seorang, 5 bencana (ramai kematian/kerosakan besar).
4. Beri kawalan mengikut hierarki: penghapusan, penggantian, kejuruteraan, pentadbiran, ppe. Isi null jika tidak praktikal. Cadangan khusus kepada situasi dalam gambar, maks 20 patah perkataan setiap satu.
5. "kotak" ialah kotak sempadan hazard sebagai [x, y, lebar, tinggi] dalam pecahan 0-1 dari kiri atas imej, atau null.
6. Maksimum 6 hazard, susun dari risiko tertinggi. Semua teks dalam Bahasa Melayu.

Balas dengan JSON SAHAJA, bentuk tepat:
{"tempat":"huraian ringkas tempat/aktiviti","ringkasan":"1-2 ayat penemuan utama","hazard":[{"nama":"...","kategori":"Fizikal|Kimia|Biologi|Ergonomik|Psikososial|Elektrikal|Mekanikal|Kebakaran|Persekitaran","lokasi":"...","kesan":"...","L":4,"S":4,"kawalan_sedia_ada":"...","kawalan":{"penghapusan":"...","penggantian":null,"kejuruteraan":"...","pentadbiran":"...","ppe":"..."},"kotak":[0.1,0.2,0.3,0.25]}]}`;
}

export default async (request, context) => {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // Hanya terima permintaan dari laman sendiri
  const origin = request.headers.get("origin");
  try { if (origin && new URL(origin).host !== new URL(request.url).host) return json({ error: "forbidden" }, 403); }
  catch { return json({ error: "forbidden" }, 403); }

  const key = Netlify.env.get("GEMINI_API_KEY");
  if (!key) return json({ error: "not_configured" }, 503);
  const model = Netlify.env.get("GEMINI_MODEL") || "gemini-3-flash-preview";
  const limit = Number(Netlify.env.get("RATE_LIMIT_PER_HOUR") || 30);

  // Had kadar per IP
  const ip = context.ip || "unknown", now = Date.now();
  const rec = (hits.get(ip) || []).filter(t => now - t < 3600_000);
  if (rec.length >= limit) return json({ error: "rate_limited" }, 429);
  rec.push(now); hits.set(ip, rec);
  if (hits.size > 5000) hits.clear();

  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_request" }, 400); }
  const image = typeof body?.image === "string" ? body.image : "";
  const mime = ["image/jpeg", "image/png", "image/webp"].includes(body?.mime) ? body.mime : "image/jpeg";
  if (!image || image.length > 6_000_000 || !/^[A-Za-z0-9+/=]+$/.test(image.slice(0, 200))) return json({ error: "bad_image" }, 400);
  const lokasi = String(body?.lokasi || "").slice(0, 300);
  const konteks = String(body?.konteks || "").slice(0, 600);

  let res;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ inline_data: { mime_type: mime, data: image } }, { text: buildPrompt(lokasi, konteks) }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
      })
    });
  } catch { return json({ error: "upstream_unreachable" }, 502); }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.log("Gemini error", res.status, data?.error?.message);
    return json({ error: res.status === 429 ? "rate_limited" : res.status === 404 ? "model_not_found" : "upstream_error" }, res.status === 429 ? 429 : 502);
  }
  const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("").replace(/```json|```/g, "").trim();
  if (!text) return json({ error: "refused" }, 422);
  let result;
  try { result = JSON.parse(text); }
  catch { const m = text.match(/\{[\s\S]*\}/); try { result = m ? JSON.parse(m[0]) : null; } catch { result = null; } }
  if (!result) return json({ error: "invalid_json" }, 502);
  return json({ result });
};

export const config = { path: "/api/analyze" };
