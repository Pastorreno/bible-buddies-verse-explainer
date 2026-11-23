// Bible Buddies Verse Explainer API
// POST /api/explain { reference, translation }
// 1. Pulls the verse text live: NLT from Tyndale's NLT API (api.nlt.to, free
//    non-commercial anonymous use, 500 requests/day), KJV or WEB from bible-api.com.
// 2. Asks Gemini for a plain-words explanation in a fixed structure.
// The verse text is never quoted from memory. The translation used is always stated.

const GEMINI_MODEL = "gemini-3.6-flash";
const ALLOWED_TRANSLATIONS = { nlt: "nlt", kjv: "kjv", web: "web" };

function json(res, status, obj) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

function cleanReference(raw) {
  return String(raw || "").trim().replace(/\s+/g, " ").slice(0, 80);
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// Tyndale's NLT API returns HTML. Pull the verse text out of its
// <verse_export> blocks and the reference out of its header.
function parseNltHtml(html) {
  const text = String(html || "");
  const refMatch = text.match(/<h2 class="bk_ch_vs_header">([^<]+)<\/h2>/);
  const reference = refMatch ? refMatch[1].replace(/,\s*NLT\s*$/i, "").trim() : "";
  const parts = [];
  const re = /<verse_export[^>]*>([\s\S]*?)<\/verse_export>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const clean = decodeEntities(m[1])
      .replace(/<span class="vn">[^<]*<\/span>/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (clean) parts.push(clean);
  }
  return { reference, text: parts.join(" ") };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return json(res, 405, { error: "Use POST." });

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const reference = cleanReference(body.reference);
  const translation = ALLOWED_TRANSLATIONS[String(body.translation || "nlt").toLowerCase()] || "nlt";
  if (!reference) return json(res, 400, { error: "Give a verse reference, like Romans 9:22." });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return json(res, 500, { error: "The explainer is not connected yet. The site owner needs to add the Gemini API key." });
  }

  // 1. Verified verse text, live.
  let verseText;
  let verseReference = reference;
  let translationName;
  if (translation === "nlt") {
    translationName = "New Living Translation (NLT)";
    let html;
    try {
      const url = "https://api.nlt.to/api/passages?ref=" + encodeURIComponent(reference) + "&version=NLT";
      const r = await fetch(url);
      if (!r.ok) return json(res, 404, { error: "Could not find that verse. Check the reference and try again." });
      html = await r.text();
    } catch (e) {
      return json(res, 502, { error: "Could not reach the NLT text service. Try again in a moment." });
    }
    const parsed = parseNltHtml(html);
    if (!parsed || !parsed.text) {
      return json(res, 404, { error: "Could not find that verse. Check the reference and try again." });
    }
    verseText = parsed.text;
    if (parsed.reference) verseReference = parsed.reference;
  } else {
    let verse;
    try {
      const url = "https://bible-api.com/" + encodeURIComponent(reference) + "?translation=" + translation;
      const r = await fetch(url);
      if (!r.ok) return json(res, 404, { error: "Could not find that verse. Check the reference and try again." });
      verse = await r.json();
    } catch (e) {
      return json(res, 502, { error: "Could not reach the Bible text service. Try again in a moment." });
    }
    if (!verse || !verse.text) {
      return json(res, 404, { error: "Could not find that verse. Check the reference and try again." });
    }
    verseText = String(verse.text).replace(/\n/g, " ").trim();
    verseReference = verse.reference || reference;
    translationName = verse.translation_name || (translation === "kjv" ? "King James Version" : "World English Bible");
  }

  // 2. Plain-words explanation from Gemini, grounded only in the verse text.
  const prompt =
    "Explain this Bible verse in plain, direct words. Use only the verse text below and well-established Bible context. " +
    "Do not invent stories, quotes, or historical claims you are not sure of. If something is uncertain, say so plainly. " +
    "Keep each answer to 1 to 3 short sentences. Plain language, no religious filler, no em-dashes, no markdown. " +
    "Return JSON only, with exactly these keys: whoWroteIt, whoItWasWrittenTo, whyItWasWritten, whatItMeans, oneLine.\n\n" +
    "Reference: " + verseReference + "\n" +
    "Translation: " + translationName + "\n" +
    "Verse text: " + verseText;

  let explanation;
  try {
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent?key=" + apiKey,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 900, responseMimeType: "application/json" },
        }),
      }
    );
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      console.error("Gemini error", r.status, detail.slice(0, 300));
      return json(res, 502, { error: "The explanation service had a problem. Try again in a moment." });
    }
    const data = await r.json();
    const raw = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts
      ? data.candidates[0].content.parts.map((p) => p.text || "").join("")
      : "";
    explanation = JSON.parse(raw);
  } catch (e) {
    console.error("Explain failed", e);
    return json(res, 502, { error: "Could not build the explanation. Try again in a moment." });
  }

  return json(res, 200, {
    reference: verseReference,
    verseText,
    translation,
    translationName,
    explanation: {
      whoWroteIt: explanation.whoWroteIt || "",
      whoItWasWrittenTo: explanation.whoItWasWrittenTo || "",
      whyItWasWritten: explanation.whyItWasWritten || "",
      whatItMeans: explanation.whatItMeans || "",
      oneLine: explanation.oneLine || "",
    },
  });
};
