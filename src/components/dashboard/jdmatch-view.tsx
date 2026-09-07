"use client";

import { useMemo, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import {
  BrainCircuit,
  CheckCircle2,
  CircleAlert,
  ClipboardPaste,
  Copy,
  Loader2,
  Sparkles,
  Wand2,
  XCircle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { analyzeJd, CATEGORY_LABELS, JdMatchResult, SkillCategory } from "@/lib/profile";

interface AiAnalysis {
  fitSummary?: string;
  strengths?: string[];
  gaps?: string[];
  resumeTips?: string[];
  coverLetter?: string;
}

const CATEGORY_BAR: Record<SkillCategory, string> = {
  languages: "bg-sky-400",
  ml_ai: "bg-violet-400",
  data: "bg-emerald-400",
  cloud_devops: "bg-amber-400",
  web: "bg-rose-400",
  tools: "bg-cyan-400",
};

function ScoreRing({ score, verdict }: { score: number; verdict: JdMatchResult["verdict"] }) {
  const color =
    verdict === "strong" ? "text-emerald-300" : verdict === "moderate" ? "text-amber-300" : "text-red-300";
  const stroke =
    verdict === "strong" ? "#34d399" : verdict === "moderate" ? "#fbbf24" : "#f87171";
  const circumference = 2 * Math.PI * 42;
  const offset = circumference - (score / 100) * circumference;
  return (
    <div className="relative h-28 w-28 shrink-0" role="img" aria-label={`Match score ${score} out of 100`}>
      <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
        <circle cx="50" cy="50" r="42" fill="none" strokeWidth="8" className="stroke-border" />
        <circle
          cx="50"
          cy="50"
          r="42"
          fill="none"
          strokeWidth="8"
          stroke={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 0.6s ease" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={`stat-number font-mono text-3xl font-bold ${color}`}>{score}</span>
        <span className="microlabel text-muted-foreground">match</span>
      </div>
    </div>
  );
}

function SkillChip({
  name,
  label,
  category,
}: {
  name: string;
  label: string;
  category: SkillCategory;
}) {
  const tone =
    label === "matched"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
      : "border-red-500/30 bg-red-500/10 text-red-300";
  return (
    <Badge variant="outline" className={`gap-1 text-[11px] ${tone}`} title={CATEGORY_LABELS[category]}>
      {label === "matched" ? (
        <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
      ) : (
        <XCircle className="h-3 w-3" aria-hidden="true" />
      )}
      {name}
    </Badge>
  );
}

export function JdMatchView() {
  const { toast } = useToast();
  const [jobTitle, setJobTitle] = useState("");
  const [company, setCompany] = useState("");
  const [jdText, setJdText] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiAnalysis, setAiAnalysis] = useState<AiAnalysis | null>(null);

  const result: JdMatchResult | null = useMemo(
    () => (jdText.trim().length > 60 ? analyzeJd(jdText) : null),
    [jdText]
  );

  async function runAiAnalysis() {
    if (!result) return;
    setAiLoading(true);
    setAiAnalysis(null);
    try {
      const res = await fetch("/api/jd-analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobTitle,
          company,
          jdText,
          matchScore: result.score,
          matchedSkills: result.matched.map((m) => m.name),
          missingSkills: result.missing.map((m) => m.name),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "AI analysis failed");
      setAiAnalysis(data.analysis as AiAnalysis);
      toast({ title: "AI analysis ready", description: "Review the gap plan and cover letter below." });
    } catch (err) {
      toast({
        title: "AI analysis failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setAiLoading(false);
    }
  }

  function copyCoverLetter() {
    if (aiAnalysis?.coverLetter) {
      navigator.clipboard
        .writeText(aiAnalysis.coverLetter)
        .then(() => toast({ title: "Copied", description: "Cover letter is on your clipboard." }))
        .catch(() => toast({ title: "Copy failed", variant: "destructive" }));
    }
  }

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-lg font-semibold">JD match analyzer</h2>
        <p className="text-sm text-muted-foreground">
          Paste any job description. Instant skill-by-skill match against your resume, then get an
          AI gap plan and a ready-to-send cover letter. This is the 30-second replacement for
          auto-apply — aimed, not sprayed.
        </p>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Input panel */}
        <Card className="border-border/70 bg-card/80">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <ClipboardPaste className="h-4 w-4 text-primary/80" aria-hidden="true" />
              Paste the job description
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="jobTitle">Job title</Label>
                <Input
                  id="jobTitle"
                  value={jobTitle}
                  onChange={(e) => setJobTitle(e.target.value)}
                  placeholder="e.g. Machine Learning Intern"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="company">Company</Label>
                <Input
                  id="company"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  placeholder="e.g. Zoho"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="jd">Job description text *</Label>
              <Textarea
                id="jd"
                value={jdText}
                onChange={(e) => setJdText(e.target.value)}
                placeholder="Copy the full JD here — responsibilities, requirements, everything. The more complete, the sharper the match."
                rows={12}
                className="font-mono text-xs"
              />
              <p className="text-right text-xs text-muted-foreground">
                {jdText.trim().length} chars {result ? `· ${result.wordCount} words · ${result.detected.length} skills detected` : ""}
              </p>
            </div>
            <Button
              className="w-full gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
              disabled={!result || aiLoading}
              onClick={runAiAnalysis}
            >
              {aiLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  AI analyzing…
                </>
              ) : (
                <>
                  <Wand2 className="h-4 w-4" aria-hidden="true" />
                  Get AI gap plan + cover letter
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Instant result panel */}
        <Card className="border-border/70 bg-card/80">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <BrainCircuit className="h-4 w-4 text-primary/80" aria-hidden="true" />
              Instant match
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!result ? (
              <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-8 text-center">
                <Sparkles className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
                <p className="text-sm text-muted-foreground">
                  Paste a JD (60+ characters) and the match fires instantly — no button needed.
                </p>
              </div>
            ) : (
              <div className="space-y-5">
                <div className="flex items-center gap-4">
                  <ScoreRing score={result.score} verdict={result.verdict} />
                  <div className="min-w-0">
                    <p className="text-sm font-medium leading-snug">{result.verdictLabel}</p>
                    {result.experienceRequired && (
                      <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                        {result.experienceRequired.ok ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                        ) : (
                          <CircleAlert className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />
                        )}
                        JD asks{" "}
                        {result.experienceRequired.min === result.experienceRequired.max
                          ? `${result.experienceRequired.min} yr`
                          : `${result.experienceRequired.min}–${result.experienceRequired.max} yrs`}{" "}
                        experience · you have internship + fresher profile
                      </p>
                    )}
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      {result.matched.length} skills matched · {result.missing.length} gaps ·{" "}
                      {result.detected.length} total detected
                    </p>
                  </div>
                </div>

                {result.categoryCoverage.length > 0 && (
                  <div className="space-y-2" aria-label="Category coverage">
                    {result.categoryCoverage.map((c) => (
                      <div key={c.category} className="flex items-center gap-2">
                        <p className="w-32 shrink-0 truncate text-xs text-muted-foreground">{c.label}</p>
                        <Progress
                          value={c.total === 0 ? 0 : (c.matched / c.total) * 100}
                          className="h-1.5 flex-1"
                          indicatorClassName={CATEGORY_BAR[c.category]}
                        />
                        <p className="stat-number w-10 shrink-0 text-right font-mono text-xs text-muted-foreground">
                          {c.matched}/{c.total}
                        </p>
                      </div>
                    ))}
                  </div>
                )}

                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <p className="microlabel mb-2 text-emerald-300/90">You already have</p>
                    <div className="flex flex-wrap gap-1.5">
                      {result.matched.length === 0 ? (
                        <p className="text-xs text-muted-foreground">None detected in this JD.</p>
                      ) : (
                        result.matched.map((m) => (
                          <SkillChip key={m.name} name={m.name} label="matched" category={m.category} />
                        ))
                      )}
                    </div>
                  </div>
                  <div>
                    <p className="microlabel mb-2 text-red-300/90">Gaps to close</p>
                    <div className="flex flex-wrap gap-1.5">
                      {result.missing.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No missing skills — rare and excellent.</p>
                      ) : (
                        result.missing.slice(0, 14).map((m) => (
                          <SkillChip key={m.name} name={m.name} label="missing" category={m.category} />
                        ))
                      )}
                    </div>
                    {result.missing.length > 14 && (
                      <p className="mt-1.5 text-[11px] text-muted-foreground">
                        +{result.missing.length - 14} more
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* AI analysis output */}
      {aiAnalysis && (
        <section aria-label="AI analysis" className="grid gap-4 lg:grid-cols-2">
          <Card className="border-primary/25 bg-card/80">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
                Fit verdict
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <p className="leading-relaxed">{aiAnalysis.fitSummary}</p>
              {aiAnalysis.strengths?.length ? (
                <div>
                  <p className="microlabel mb-2 text-emerald-300/90">Selling points to lead with</p>
                  <ul className="space-y-1.5">
                    {aiAnalysis.strengths.map((s, i) => (
                      <li key={i} className="flex gap-2 text-muted-foreground">
                        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden="true" />
                        <span className="leading-relaxed">{s}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {aiAnalysis.gaps?.length ? (
                <div>
                  <p className="microlabel mb-2 text-red-300/90">Gap plan</p>
                  <ul className="space-y-1.5">
                    {aiAnalysis.gaps.map((g, i) => (
                      <li key={i} className="flex gap-2 text-muted-foreground">
                        <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden="true" />
                        <span className="leading-relaxed">{g}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {aiAnalysis.resumeTips?.length ? (
                <div>
                  <p className="microlabel mb-2 text-primary/80">Resume / ATS tweaks</p>
                  <ul className="space-y-1.5">
                    {aiAnalysis.resumeTips.map((t, i) => (
                      <li key={i} className="flex gap-2 text-muted-foreground">
                        <Wand2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary/70" aria-hidden="true" />
                        <span className="leading-relaxed">{t}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card className="border-primary/25 bg-card/80">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between gap-2 text-base">
                <span className="flex items-center gap-2">
                  <Wand2 className="h-4 w-4 text-primary" aria-hidden="true" />
                  Cover letter draft
                </span>
                <Button size="sm" variant="outline" className="gap-1.5" onClick={copyCoverLetter}>
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  Copy
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-wrap break-words rounded-lg bg-secondary/40 p-4 font-mono text-xs leading-relaxed text-foreground/90">
                {aiAnalysis.coverLetter}
              </p>
            </CardContent>
          </Card>
        </section>
      )}
    </div>
  );
}
