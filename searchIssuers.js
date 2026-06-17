const normalize = (str) => (str || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function scoreIssuer(doc, normalizedQuery) {
  if (!normalizedQuery) return 0;

  let score = 0;
  const fields = [doc.issuer_id, doc.point_currency];

  for (const field of fields) {
    const normalizedField = normalize(field);
    if (
      normalizedField &&
      (normalizedField.includes(normalizedQuery) ||
        normalizedQuery.includes(normalizedField))
    ) {
      score += 2;
    }
  }

  return score;
}

function searchIssuers(query, issuers, limit = 5) {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery || !issuers?.length) return [];

  return issuers
    .map((doc) => ({ doc, score: scoreIssuer(doc, normalizedQuery) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ doc }) => doc);
}

module.exports = { searchIssuers };
