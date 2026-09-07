import { analyzeJd } from "../src/lib/profile";
// JD that explicitly mentions C, R and Excel
const jd2 = `Required: Python, C, R, SQL, Excel, Pandas. Build ML models with scikit-learn. Excellent communication skills. AWS cloud services. TensorFlow nice to have. 0-1 years experience.`;
const r2 = analyzeJd(jd2);
console.log("--- JD with explicit C, R, Excel ---");
console.log("matched:", r2.matched.map(m => m.name).join(", "));
console.log("missing:", r2.missing.map(m => m.name).join(", "));
