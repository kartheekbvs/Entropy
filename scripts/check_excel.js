const jd = `We are looking for a Machine Learning Intern to join our data science team in Hyderabad. Responsibilities: build and deploy machine learning models using Python and scikit-learn, clean and analyze large datasets with SQL and pandas, assist in NLP prototyping, present insights to stakeholders. Requirements: pursuing a degree in Computer Science, strong Python skills, familiarity with machine learning concepts, knowledge of SQL databases, basic understanding of AWS cloud services, excellent communication. Nice to have: TensorFlow, PyTorch, Docker, Tableau. 0-1 years experience. Stipend Rs 25000 per month.`;

const text = " " + jd.toLowerCase().replace(/[\n\r]+/g, " ") + " ";
for (const alias of ["excel", "microsoft excel"]) {
  const isSimple = /^[a-z0-9.+#-]+$/.test(alias);
  const esc = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = isSimple
    ? new RegExp(`(^|[^a-z0-9+#])${esc}([^a-z0-9+#]|$)`, "i")
    : new RegExp(esc, "i");
  const m = text.match(pattern);
  console.log(`alias "${alias}" →`, m ? JSON.stringify(m[0]) : "no match");
}
