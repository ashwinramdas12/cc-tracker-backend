/**
 * Given a raw Plaid account name, an optional institution name, and an array
 * of card documents, returns the best-matching card or null if none match.
 *
 * Scoring:
 *  +1  for each `plaid_search_terms` entry that is a substring of the
 *      normalized account name (or vice-versa).
 *  +1  issuer bonus: if the card's `issuer_id` is a substring of the
 *      normalized institution name (or vice-versa), rewarding cards whose
 *      issuer aligns with the connected institution.
 *
 * The card with the highest total score wins; at least 1 point is required.
 */
function fuzzySearchCreditCards(plaidName, cards, institutionName = null) {
  if (!plaidName || !cards?.length) return null;
  console.log("plaidName: ", plaidName);
  console.log("cards: ", cards);
  console.log("institutionName: ", institutionName);
  const normalize = (str) => str.toLowerCase().replace(/[^a-z0-9]/g, "");
  const normalizedName = normalize(plaidName);
  const normalizedInstitution = institutionName ? normalize(institutionName) : null;
  console.log("normalizedName: ", normalizedName);
  console.log("normalizedInstitution: ", normalizedInstitution);
  let bestCard = null;
  let bestScore = 0;

  for (const card of cards) {
    const terms = card.plaid_search_terms;
    if (!Array.isArray(terms) || terms.length === 0) continue;
    console.log("terms: ", terms);
    let score = 0;

    for (const term of terms) {
      const normalizedTerm = normalize(term);
      if (normalizedName.includes(normalizedTerm) || normalizedTerm.includes(normalizedName)) {
        score++;
      }
    }
    console.log("score: ", score);
    if (normalizedInstitution && card.issuer_id) {
      const normalizedIssuer = normalize(card.issuer_id);
      if (
        normalizedInstitution.includes(normalizedIssuer) ||
        normalizedIssuer.includes(normalizedInstitution)
      ) {
        score++;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestCard = card;
    }
  }

  return bestScore > 0 ? bestCard : null;
}

module.exports = fuzzySearchCreditCards;
