const normalize = (str) => (str || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function scoreCard(card, normalizedQuery) {
  if (!normalizedQuery) return 0;

  let score = 0;

  const normalizedName = normalize(card.name);
  if (
    normalizedName.includes(normalizedQuery) ||
    normalizedQuery.includes(normalizedName)
  ) {
    score += 3;
  }

  const normalizedIssuer = normalize(card.issuer_id);
  if (
    normalizedIssuer.includes(normalizedQuery) ||
    normalizedQuery.includes(normalizedIssuer)
  ) {
    score += 2;
  }

  const terms = card.plaid_search_terms;
  if (Array.isArray(terms)) {
    for (const term of terms) {
      const normalizedTerm = normalize(term);
      if (
        normalizedTerm.includes(normalizedQuery) ||
        normalizedQuery.includes(normalizedTerm)
      ) {
        score += 1;
      }
    }
  }

  return score;
}

function searchCards(query, cards, limit = 5) {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery || !cards?.length) return [];

  return cards
    .map((card) => ({ card, score: scoreCard(card, normalizedQuery) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ card }) => card);
}

module.exports = { searchCards };
