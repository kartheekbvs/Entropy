// ─────────────────────────────────────────────────────────────
// Candidate profile — parsed from 24BCS80009_kartheek.pdf
// ─────────────────────────────────────────────────────────────

export const PROFILE = {
  name: "Bhamidipati Venkata Sai Kartheek",
  shortName: "Kartheek",
  title: "AI/ML & Python Developer · Computer Engineering",
  email: "bvskartheek83@gmail.com",
  phone: "+91 8639316512",
  linkedin: "linkedin.com/in/kartheek-bvs-2a82562b9",
  github: "github.com/kartheekbvs",
  baseLocation: "Mohali, Punjab (hometown: Andhra Pradesh)",
  education: {
    degree: "BE Computer Engineering",
    school: "Chandigarh University",
    cgpa: "8.3",
    period: "2023 – 2027",
    location: "Mohali, Punjab",
  },
  experience: [
    {
      role: "AI/ML Intern",
      company: "InternPro",
      period: "Jul 2025 – Sep 2025",
      location: "Remote",
      highlights: [
        "Python automation for 15+ teams (+20% efficiency)",
        "Resolved 40+ issues across Windows/Linux (−30% resolution time)",
        "99% uptime across 50+ IT operations",
      ],
    },
  ],
  projects: [
    {
      name: "Spam Mail Detection System",
      stack: "Python · Scikit-learn",
      highlight: "94% accuracy on 10,000+ emails, TF-IDF pipeline, precision 87%→94%",
    },
    {
      name: "TWSS Learning Platform",
      stack: "HTML · CSS · JS · Supabase",
      highlight: "10+ tech domains, deployed on Cloudflare Pages + Netlify",
    },
    {
      name: "Personal Portfolio",
      stack: "HTML · CSS · JS · EmailJS",
      highlight: "100% mobile-compatible, 200+ visitors, EmailJS contact form",
    },
  ],
  certifications: [
    "Columbia Engineering — Intro to ML & AI (2025)",
    "Big Data Analytics with AWS — Intellipaat (2025)",
    "AWS APAC Solutions Architecture — Forage (2025)",
    "BCG GenAI Job Simulation — Forage (2025)",
    "Databases & SQL for Data Science — IBM (2025)",
    "Introduction to Databases — Meta (2024)",
  ],
} as const;

// ─────────────────────────────────────────────────────────────
// Skill taxonomy for JD matching
// Each skill: canonical name, aliases for text detection,
// category, and whether the candidate claims it.
// ─────────────────────────────────────────────────────────────

export type SkillCategory =
  | "languages"
  | "ml_ai"
  | "data"
  | "cloud_devops"
  | "web"
  | "tools";

export interface SkillDef {
  name: string;
  aliases: string[];
  category: SkillCategory;
  has: boolean;
  weight: number; // importance when detected in a JD (1 = common, 2 = core)
}

const S = (
  name: string,
  category: SkillCategory,
  has: boolean,
  weight: number,
  aliases: string[] = []
): SkillDef => ({ name, category, has, weight, aliases: [name, ...aliases] });

export const SKILLS: SkillDef[] = [
  // ── Languages ──────────────────────────────────────────────
  S("Python", "languages", true, 2, ["python3"]),
  S("SQL", "languages", true, 2),
  S("Java", "languages", true, 1),
  S("C++", "languages", true, 1, ["c plus plus"]),
  S("C", "languages", true, 1),
  S("JavaScript", "languages", true, 1, ["js", "es6"]),
  S("TypeScript", "languages", false, 1, ["ts"]),
  S("PHP", "languages", true, 1),
  S("R", "languages", false, 1),
  S("Scala", "languages", false, 1),
  S("Go", "languages", false, 1, ["golang"]),
  S("Rust", "languages", false, 1),

  // ── ML / AI ────────────────────────────────────────────────
  S("Machine Learning", "ml_ai", true, 2, ["ml", "machine-learning"]),
  S("Deep Learning", "ml_ai", false, 2, ["dl", "neural net", "neural networks"]),
  S("Scikit-learn", "ml_ai", true, 2, ["sklearn", "scikit learn"]),
  S("TensorFlow", "ml_ai", false, 2),
  S("PyTorch", "ml_ai", false, 2, ["torch"]),
  S("Keras", "ml_ai", false, 1),
  S("XGBoost", "ml_ai", false, 1),
  S("NLP", "ml_ai", false, 2, ["natural language processing"]),
  S("Computer Vision", "ml_ai", false, 2, ["cv", "opencv"]),
  S("OpenCV", "ml_ai", false, 1),
  S("LLMs", "ml_ai", false, 2, ["llm", "large language model", "gpt", "chatgpt", "claude"]),
  S("Generative AI", "ml_ai", false, 2, ["genai", "gen ai", "generative artificial intelligence"]),
  S("LangChain", "ml_ai", false, 1),
  S("RAG", "ml_ai", false, 1, ["retrieval augmented generation"]),
  S("Hugging Face", "ml_ai", false, 1, ["huggingface", "transformers library"]),
  S("Prompt Engineering", "ml_ai", false, 1),
  S("MLOps", "ml_ai", false, 2, ["ml ops", "model deployment", "model serving"]),
  S("Neural Networks", "ml_ai", false, 1, ["ann", "cnn", "rnn", "lstm"]),
  S("Supervised Learning", "ml_ai", true, 1, ["unsupervised learning", "classification models", "regression models"]),
  S("Feature Engineering", "ml_ai", true, 1),
  S("Logistic Regression", "ml_ai", true, 1),
  S("Random Forest", "ml_ai", false, 1),
  S("Model Evaluation", "ml_ai", true, 1, ["roc", "a/b testing models", "confusion matrix", "cross validation", "hyperparameter tuning", "hyperparameter optimization"]),
  S("Reinforcement Learning", "ml_ai", false, 1),
  S("Data Mining", "ml_ai", true, 1),

  // ── Data ───────────────────────────────────────────────────
  S("Data Analysis", "data", true, 2, ["data analytics", "analysing data", "analyzing data"]),
  S("Data Science", "data", true, 2, ["data scientist"]),
  S("Data Engineering", "data", false, 2, ["data engineer", "etl pipelines"]),
  S("Pandas", "data", false, 2, ["panda library", "python pandas"]),
  S("NumPy", "data", false, 2, ["numpy array"]),
  S("MySQL", "data", true, 1, ["my sql", "mariadb"]),
  S("PostgreSQL", "data", false, 1, ["postgres"]),
  S("MongoDB", "data", false, 1, ["mongo"]),
  S("Oracle", "data", true, 1, ["oracle db", "oracle database"]),
  S("Data Visualization", "data", true, 1, ["matplotlib", "seaborn", "plotly", "charts"]),
  S("Tableau", "data", false, 1),
  S("Power BI", "data", false, 1, ["powerbi", "power-bi"]),
  S("Excel", "data", true, 1, ["microsoft excel", "advanced excel", "spreadsheet"]),
  S("Statistics", "data", true, 2, ["statistical analysis", "statistical modeling", "hypothesis testing"]),
  S("Big Data", "data", true, 1, ["big data analytics"]),
  S("Spark", "data", false, 2, ["apache spark", "pyspark"]),
  S("Hadoop", "data", false, 1, ["apache hadoop"]),
  S("Kafka", "data", false, 1, ["apache kafka"]),
  S("Airflow", "data", false, 1, ["apache airflow"]),
  S("Snowflake", "data", false, 1),
  S("ETL", "data", true, 1, ["data pipelines", "data pipeline", "data warehousing", "data warehouse"]),
  S("A/B Testing", "data", true, 1, ["ab testing", "experimentation"]),

  // ── Cloud & DevOps ─────────────────────────────────────────
  S("AWS", "cloud_devops", true, 2, ["amazon web services", "ec2", "s3", "lambda", "amazon sagemaker"]),
  S("Azure", "cloud_devops", false, 1, ["microsoft azure"]),
  S("GCP", "cloud_devops", false, 1, ["google cloud", "google cloud platform"]),
  S("Docker", "cloud_devops", false, 2, ["containerization", "containers"]),
  S("Kubernetes", "cloud_devops", false, 2, ["k8s", "eks"]),
  S("CI/CD", "cloud_devops", false, 1, ["cicd", "ci cd", "continuous integration", "continuous deployment"]),
  S("Jenkins", "cloud_devops", false, 1),
  S("Terraform", "cloud_devops", false, 1, ["infrastructure as code", "iac"]),
  S("Linux", "cloud_devops", true, 1, ["unix", "bash", "shell scripting", "ubuntu"]),
  S("Git", "cloud_devops", true, 1, ["version control", "github", "gitlab", "bitbucket"]),
  S("DevOps", "cloud_devops", false, 1),
  S("Cloud Computing", "cloud_devops", true, 1, ["cloud infrastructure", "cloud services"]),

  // ── Web ────────────────────────────────────────────────────
  S("HTML", "web", true, 1, ["html5", "hypertext markup"]),
  S("CSS", "web", true, 1, ["css3", "tailwind", "bootstrap"]),
  S("React", "web", false, 2, ["reactjs", "react.js", "react js"]),
  S("Next.js", "web", false, 1, ["nextjs", "next js"]),
  S("Node.js", "web", false, 2, ["nodejs", "node js", "express.js", "expressjs", "express js"]),
  S("Django", "web", false, 2, ["python django"]),
  S("Flask", "web", false, 2, ["python flask"]),
  S("FastAPI", "web", false, 2, ["fast api", "fast-api"]),
  S("REST API", "web", true, 1, ["restful", "rest apis", "api development", "api integration", "webservices", "web services"]),
  S("GraphQL", "web", false, 1, ["apollo"]),
  S("Microservices", "web", false, 1, ["micro services", "micro-services"]),
  S("Supabase", "web", true, 1),
  S("Full Stack", "web", true, 1, ["fullstack", "full-stack", "full stack development"]),
  S("Responsive Design", "web", true, 1, ["mobile friendly", "mobile-first"]),

  // ── Tools & platforms ──────────────────────────────────────
  S("Jupyter", "tools", true, 1, ["google colab", "jupyter notebook", "colab", "anaconda", "ipython"]),
  S("Splunk", "tools", true, 1),
  S("SIEM", "tools", true, 1, ["security information and event management"]),
  S("DBeaver", "tools", true, 1),
  S("Agile", "tools", true, 1, ["scrum", "sprint planning", "kanban"]),
  S("Data Storytelling", "tools", true, 1, ["stakeholder communication", "business insights", "reporting"]),
];

export const CATEGORY_LABELS: Record<SkillCategory, string> = {
  languages: "Programming Languages",
  ml_ai: "ML / AI",
  data: "Data",
  cloud_devops: "Cloud & DevOps",
  web: "Web & Frameworks",
  tools: "Tools & Practices",
};

export const CANDIDATE_SKILL_NAMES = SKILLS.filter((s) => s.has).map((s) => s.name);

// ─────────────────────────────────────────────────────────────
// Deterministic JD ↔ resume match analyzer
// ─────────────────────────────────────────────────────────────

export interface JdMatchResult {
  score: number;
  verdict: "strong" | "moderate" | "stretch";
  verdictLabel: string;
  detected: Array<{ name: string; category: SkillCategory; has: boolean; weight: number }>;
  matched: Array<{ name: string; category: SkillCategory }>;
  missing: Array<{ name: string; category: SkillCategory }>;
  bonus: Array<{ name: string; category: SkillCategory }>;
  categoryCoverage: Array<{ category: SkillCategory; label: string; matched: number; total: number }>;
  experienceRequired: { min: number; max: number; ok: boolean } | null;
  wordCount: number;
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectExperience(text: string): { min: number; max: number; ok: boolean } | null {
  // "3+ years", "2-4 years", "0-2 years", "minimum 3 yrs"
  const plus = text.match(/(\d{1,2})\s*\+?\s*(?:to|-|–)\s*(\d{1,2})\s*(?:years?|yrs?)/i);
  if (plus) {
    const min = parseInt(plus[1], 10);
    const max = parseInt(plus[2], 10);
    return { min, max, ok: min <= 1 };
  }
  const single = text.match(/(\d{1,2})\s*\+?\s*(?:years?|yrs?)(?:\s*(?:of| relevant)?\s*(?:experience|exp))?/i);
  if (single) {
    const min = parseInt(single[1], 10);
    return { min, max: min, ok: min <= 1 };
  }
  return null;
}

export function analyzeJd(jdText: string): JdMatchResult {
  const rawText = " " + jdText.replace(/[\n\r]+/g, " ") + " ";
  const text = rawText.toLowerCase();
  const wordCount = jdText.trim().split(/\s+/).filter(Boolean).length;

  const detected: JdMatchResult["detected"] = [];
  for (const skill of SKILLS) {
    for (const alias of skill.aliases) {
      const esc = escapeRegex(alias);
      let matched = false;
      if (alias.length === 1) {
        // Single-letter skills (C, R): require the capital letter as a standalone token
        // (case-sensitive on the original text) to avoid matching stray letters.
        matched = new RegExp(`(^|[^A-Za-z0-9+#])${alias.toUpperCase()}([^A-Za-z0-9+#]|$)`).test(rawText);
      } else if (/^[A-Za-z0-9.+#/-]+$/.test(alias)) {
        // Single-token aliases: word-boundary, case-insensitive
        matched = new RegExp(`(^|[^a-z0-9+#])${esc}([^a-z0-9+#]|$)`, "i").test(rawText);
      } else {
        // Multi-word aliases: substring match
        matched = text.includes(alias.toLowerCase());
      }
      if (matched) {
        detected.push({
          name: skill.name,
          category: skill.category,
          has: skill.has,
          weight: skill.weight,
        });
        break;
      }
    }
  }

  // Deduplicate: prefer matched over unmatched for same canonical name
  const byName = new Map<string, JdMatchResult["detected"][number]>();
  for (const d of detected) {
    const existing = byName.get(d.name);
    if (!existing || (d.has && !existing.has)) byName.set(d.name, d);
  }
  const finalDetected = Array.from(byName.values()).sort(
    (a, b) => b.weight - a.weight || a.name.localeCompare(b.name)
  );

  const matched = finalDetected.filter((d) => d.has).map(({ name, category }) => ({ name, category }));
  const missing = finalDetected.filter((d) => !d.has).map(({ name, category }) => ({ name, category }));
  const missingNames = new Set(missing.map((m) => m.name));
  const bonus = SKILLS.filter((s) => s.has && !finalDetected.some((d) => d.name === s.name))
    .filter((s) => s.weight >= 1)
    .map(({ name, category }) => ({ name, category }));

  // Weighted coverage
  const totalWeight = finalDetected.reduce((sum, d) => sum + d.weight, 0);
  const matchedWeight = finalDetected.filter((d) => d.has).reduce((sum, d) => sum + d.weight, 0);
  let score = totalWeight === 0 ? 0 : Math.round((matchedWeight / totalWeight) * 100);

  // Experience adjustment: heavy penalty if JD clearly wants senior talent
  const experienceRequired = detectExperience(text);
  if (experienceRequired) {
    if (experienceRequired.min >= 4) score = Math.round(score * 0.55);
    else if (experienceRequired.min === 2 || experienceRequired.min === 3) score = Math.round(score * 0.82);
    else if (experienceRequired.min <= 1) score = Math.min(100, score + 4);
  }

  // Small floor bonus when the JD is sparse
  if (totalWeight > 0 && totalWeight < 6) score = Math.min(100, score + 3);

  const verdict: JdMatchResult["verdict"] =
    score >= 70 ? "strong" : score >= 45 ? "moderate" : "stretch";
  const verdictLabel =
    verdict === "strong"
      ? "Strong match — apply today"
      : verdict === "moderate"
        ? "Moderate match — apply with a tailored pitch"
        : "Stretch — needs upskilling or strong story";

  const categories: SkillCategory[] = ["languages", "ml_ai", "data", "cloud_devops", "web", "tools"];
  const categoryCoverage = categories
    .map((category) => {
      const items = finalDetected.filter((d) => d.category === category);
      return {
        category,
        label: CATEGORY_LABELS[category],
        matched: items.filter((d) => d.has).length,
        total: items.length,
      };
    })
    .filter((c) => c.total > 0);

  return {
    score,
    verdict,
    verdictLabel,
    detected: finalDetected,
    matched,
    missing,
    bonus: bonus.slice(0, 12),
    categoryCoverage,
    experienceRequired,
    wordCount,
    // missing keeps original order; expose primary (high weight) first
  };
}
