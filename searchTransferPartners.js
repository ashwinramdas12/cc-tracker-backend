const normalize = (str) => (str || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function scoreTransferPartner(doc, normalizedQuery) {
  if (!normalizedQuery) return 0;

  let score = 0;
  const fields = [doc.transfer_partner_id, doc.program];

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

function searchTransferPartners(query, partners, limit = 5) {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery || !partners?.length) return [];

  return partners
    .map((doc) => ({ doc, score: scoreTransferPartner(doc, normalizedQuery) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ doc }) => doc);
}

module.exports = { searchTransferPartners };
