import dotenv from "dotenv";
import { getRecoverModel } from "../src/lib/ai/model";
import { OpenRouterEmbeddings } from "../src/lib/ai/openrouter-embeddings";
import { DiagnosisOutputSchema, ProposalOutputSchema } from "../src/lib/ai/schemas";

dotenv.config();

async function runOpenRouterSmoke() {
  console.log("=== OpenRouter AI Smoke Test ===");

  if (!process.env.OPENROUTER_API_KEY) {
    console.error("❌ OPENROUTER_API_KEY is not set in environment.");
    process.exit(1);
  }

  // 1. Test Embeddings dimension
  console.log("1. Testing OpenRouter Embeddings generation...");
  const embeddings = new OpenRouterEmbeddings();
  const sampleVector = await embeddings.embedQuery("UPI payment failure authentication error");
  console.log(`✓ Generated embedding vector of length: ${sampleVector.length}`);

  if (sampleVector.length !== 1536) {
    console.warn(`[Notice] Embedding dimension is ${sampleVector.length} (schema expected 1536).`);
  }

  // 2. Test Structured Diagnosis Output
  console.log("\n2. Testing Structured AI Failure Diagnosis...");
  const model = getRecoverModel({ temperature: 0 });
  const structuredDiag = model.withStructuredOutput(DiagnosisOutputSchema);

  const diagResult = await structuredDiag.invoke(
    `Analyze payment failure:
Payment ID: pay_sample_123
Method: upi
Error Reason: payment_failed
Error Source: customer
Error Step: payment_authentication
Error Description: Bank server timed out during MPIN validation.
`,
  );

  console.log(`✓ Structured Diagnosis Generated:`);
  console.log(`  - Failure Class: ${diagResult.failureClass}`);
  console.log(`  - Confidence: ${diagResult.confidence}`);
  console.log(`  - Summary: ${diagResult.summary}`);

  // 3. Test Structured Recovery Proposal
  console.log("\n3. Testing Structured Recovery Proposal...");
  const structuredProp = model.withStructuredOutput(ProposalOutputSchema);

  const propResult = await structuredProp.invoke(
    `Propose safe recovery for failure class '${diagResult.failureClass}' and summary '${diagResult.summary}'. Allowed strategies: FRESH_CHECKOUT, WAIT_FOR_CANONICAL_UPDATE, MANUAL_REVIEW, STOP_ALREADY_PAID.`,
  );

  console.log(`✓ Structured Proposal Generated:`);
  console.log(`  - Strategy: ${propResult.strategy}`);
  console.log(`  - Explanation: ${propResult.explanation}`);

  console.log("\n=== OpenRouter AI Smoke Test Passed ===");
}

runOpenRouterSmoke().catch((err) => {
  console.error("OpenRouter smoke test failed:", err);
  process.exit(1);
});
