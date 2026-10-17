const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]!)

/** Match plain text first, then escape every segment before adding our own markup. */
export function highlightText(text: string, terms: string[] = []): string {
  const escapedTerms = terms.filter(Boolean).map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!escapedTerms.length) return escapeHtml(text)
  const pattern = new RegExp(escapedTerms.join('|'), 'gi')
  let result = ''
  let offset = 0
  for (const match of text.matchAll(pattern)) {
    result += escapeHtml(text.slice(offset, match.index))
    result += `<mark class="search-highlight">${escapeHtml(match[0])}</mark>`
    offset = match.index! + match[0].length
  }
  return result + escapeHtml(text.slice(offset))
}
