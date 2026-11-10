import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { env, pipeline } from "@huggingface/transformers";

// Real packaged model, with all remote loading disabled; separate from fast synthetic tests.
env.allowRemoteModels = false;
env.localModelPath = fileURLToPath(
  new URL("../public/models/", import.meta.url),
);
const model = await pipeline("feature-extraction", "all-MiniLM-L6-v2", {
  dtype: "q8",
  device: "cpu",
});
try {
  const output = await model(
    [
      "Electric vehicles produce fewer emissions than gasoline cars.",
      "Battery powered transport reduces pollution compared with petrol engines.",
      "The bakery sells fresh croissants every morning.",
    ],
    { pooling: "mean", normalize: true },
  );
  assert.deepEqual(output.dims, [3, 384]);
  const rows = output.tolist();
  const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
  rows.forEach((row) => assert.ok(Math.abs(dot(row, row) - 1) < 0.02));
  const related = dot(rows[0], rows[1]),
    unrelated = dot(rows[0], rows[2]);
  assert.ok(related >= 0.45 && related > unrelated);
  console.log("Packaged model smoke test passed:", { related, unrelated });
  // A political claim should not retrieve unrelated academic announcements.
  // Generic fixtures, rather than a user's personal saved posts.
  const political = (
    await model(
      [
        "Putin will not stop at eastern Ukraine. Attacks on Kyiv and drones entering NATO countries show that European nations must resist Russian aggression.",
        "Russia can prolong the war in Ukraine when divided EU governments block action against Putin.",
        "Our university group will present its full machine learning conference program in Naples.",
        "An LLM-based comparison of political neutrality in online encyclopedias.",
      ],
      { pooling: "mean", normalize: true },
    )
  ).tolist();
  const scores = political.slice(1).map((row) => dot(political[0], row));
  assert.ok(scores[0] > 0.4);
  assert.ok(scores[0] > scores[1] + 0.2 && scores[0] > scores[2] + 0.2);
  assert.ok(scores[1] < 0.4 && scores[2] < 0.4);
  console.log("Political relevance regression passed:", scores);
} finally {
  await model.dispose();
}
