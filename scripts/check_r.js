// Quick check: which alias triggers a false "R" match in this JD text
const jd = `We are looking for a Machine Learning Intern to join our data science team in Hyderabad. Responsibilities: build and deploy machine learning models using Python and scikit-learn, clean and analyze large datasets with SQL and pandas, assist in NLP prototyping, present insights to stakeholders. Requirements: pursuing a degree in Computer Science, strong Python skills, familiarity with machine learning concepts, knowledge of SQL databases, basic understanding of AWS cloud services, excellent communication. Nice to have: TensorFlow, PyTorch, Docker, Tableau. 0-1 years experience. Stipend Rs 25000 per month.`;

const text = " " + jd.toLowerCase().replace(/[\n\r]+/g, " ") + " ";
const alias = "R";
const pattern = new RegExp(`(^|[^a-z0-9+#])${alias}([^a-z0-9+#]|$)`, "i");
const m = text.match(pattern);
console.log("match:", m ? JSON.stringify(m[0]) : "none");
if (m) {
  const idx = text.indexOf(m[0]);
  console.log("context:", JSON.stringify(text.slice(Math.max(0, idx - 30), idx + 40)));
}
