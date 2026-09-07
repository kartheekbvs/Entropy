import { NextRequest, NextResponse } from "next/server";
import { PROFILE, CANDIDATE_SKILL_NAMES } from "@/lib/profile";
import { zaiConfigPath } from "@/lib/agent/llm";

export const maxDuration = 60;

interface AnalysisBody {
  jobTitle?: string;
  company?: string;
  jdText?: string;
  matchScore?: number;
  matchedSkills?: string[];
  missingSkills?: string[];
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as AnalysisBody;
    const jdText = (body.jdText ?? "").toString().slice(0, 12000);
    const jobTitle = (body.jobTitle ?? "").toString().slice(0, 200);
    const company = (body.company ?? "").toString().slice(0, 200);

    if (!jdText.trim() || jdText.trim().length < 80) {
      return NextResponse.json(
        { error: "Paste the full job description (at least ~80 characters) for a useful analysis." },
        { status: 400 }
      );
    }

    // LLM call: Gemini-direct when a key is present (works on any user's
    // machine), z-ai only where its config actually exists. Never an
    // unguarded ZAI.create() — that throws the cryptic "create .z-ai-config"
    // error on personal installs.
    const systemPrompt = `You are a sharp, encouraging technical career coach for Indian tech job seekers.
You analyze job descriptions against a candidate's resume and give honest, specific, actionable advice.
You always reply with STRICT JSON only (no markdown fences, no commentary outside JSON).`;

    const userPrompt = `CANDIDATE PROFILE (resume):
- Name: ${PROFILE.name}
- Education: ${PROFILE.education.degree} at ${PROFILE.education.school}, CGPA ${PROFILE.education.cgpa} (${PROFILE.education.period})
- Experience: AI/ML Intern at InternPro (Remote, Jul-Sep 2025): Python automation for 15+ teams, resolved 40+ Windows/Linux issues, 99% uptime on 50+ operations
- Projects: Spam Mail Detection (Python, scikit-learn, TF-IDF, logistic regression, 94% accuracy on 10k+ emails); TWSS learning platform (HTML/CSS/JS/Supabase, deployed Cloudflare+Netlify); portfolio site (EmailJS)
- Skills claimed: ${CANDIDATE_SKILL_NAMES.join(", ")}
- Certifications: ${PROFILE.certifications.join("; ")}
- Situation: final-year student (2027 batch), targeting ML/AI + Python developer internships and entry roles

JOB DESCRIPTION${jobTitle ? ` (title: ${jobTitle})` : ""}${company ? ` (company: ${company})` : ""}:
"""
${jdText}
"""

DETERMINISTIC PRE-ANALYSIS (keyword matching):
- Match score: ${body.matchScore ?? "n/a"}/100
- Skills he already has that the JD asks for: ${(body.matchedSkills ?? []).join(", ") || "none detected"}
- Skills the JD asks for that he does NOT list: ${(body.missingSkills ?? []).join(", ") || "none detected"}

Reply with STRICT JSON of exactly this shape:
{
  "fitSummary": "2-3 sentence honest verdict: is this worth applying to for this candidate?",
  "strengths": ["3 specific selling points connecting HIS actual projects/certs to THIS JD"],
  "gaps": ["up to 4 missing skills, each with one practical mitigation (project to build / cert to cite / how to frame existing experience)"],
  "resumeTips": ["2-3 concrete bullet-line rewrites or keyword additions for his resume/ATS"],
  "coverLetter": "a ready-to-send 150-220 word application note in first person, referencing his InternPro internship and spam-classifier project, enthusiastic but not desperate, no placeholders like [Company] — use the real company name if provided otherwise write generically"
}`;

    const messages = [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: userPrompt },
    ];

    let content = "";
    const geminiKey = process.env.GEMINI_API_KEY || "";
    if (geminiKey) {
      const gem = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODEL || "gemini-flash-latest"}:generateContent`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": geminiKey },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: "user", parts: [{ text: userPrompt }] }],
            generationConfig: { temperature: 0.4, maxOutputTokens: 2048, responseMimeType: "application/json" },
          }),
          signal: AbortSignal.timeout(55_000),
        }
      ).catch(() => null);
      if (gem && gem.ok) {
        const data = (await gem.json().catch(() => null)) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        } | null;
        content = (data?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
      }
    }
    if (!content && (await zaiConfigPath())) {
      try {
        const { default: ZAI } = await import("z-ai-web-dev-sdk");
        const zai = await ZAI.create();
        const completion = await zai.chat.completions.create({ messages, thinking: { type: "disabled" } });
        content = completion.choices[0]?.message?.content ?? "";
      } catch {
        content = "";
      }
    }
    if (!content.trim()) {
      return NextResponse.json(
        { error: "AI analysis needs an LLM key: add GEMINI_API_KEY=… (free at aistudio.google.com/apikey) to the .env file in the project folder, then retry. The keyword-match panel above still works without it." },
        { status: 503 }
      );
    }

    // Robust JSON extraction (handles accidental fences)
    let parsed: Record<string, unknown> | null = null;
    const cleaned = content
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const first = cleaned.indexOf("{");
      const last = cleaned.lastIndexOf("}");
      if (first !== -1 && last > first) {
        try {
          parsed = JSON.parse(cleaned.slice(first, last + 1));
        } catch {
          parsed = null;
        }
      }
    }

    if (!parsed || typeof parsed !== "object") {
      return NextResponse.json(
        { error: "AI analysis returned an unreadable response. Try again." },
        { status: 502 }
      );
    }

    return NextResponse.json({ analysis: parsed });
  } catch (error) {
    console.error("POST /api/jd-analysis failed:", error);
    return NextResponse.json(
      { error: "AI analysis failed. The keyword-match panel above still works — retry AI analysis in a moment." },
      { status: 500 }
    );
  }
}
