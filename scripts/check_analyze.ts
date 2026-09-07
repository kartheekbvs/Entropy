import { analyzeJd } from "../src/lib/profile";

const jd = `We are looking for a Machine Learning Intern to join our data science team in Hyderabad. Responsibilities: build and deploy machine learning models using Python and scikit-learn, clean and analyze large datasets with SQL and pandas, assist in NLP prototyping, present insights to stakeholders. Requirements: pursuing a degree in Computer Science, strong Python skills, familiarity with machine learning concepts, knowledge of SQL databases, basic understanding of AWS cloud services, excellent communication. Nice to have: TensorFlow, PyTorch, Docker, Tableau. 0-1 years experience. Stipend Rs 25000 per month.`;

const result = analyzeJd(jd);
console.log("score:", result.score, result.verdict);
console.log("matched:", result.matched.map((m) => m.name).join(", "));
console.log("missing:", result.missing.map((m) => m.name).join(", "));
console.log("exp:", JSON.stringify(result.experienceRequired));
