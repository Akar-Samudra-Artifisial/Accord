/**
 * Absolute links for Rovo action outputs. Agents may only link URLs that appear in an action output,
 * so every issue, contract and request in an output carries a `url` built from the site base URL.
 */
export interface SiteLinks {
  issue(issueKey: string): string;
  page(pageId: string): string;
}

/** Accepts only an absolute https origin (with an optional path prefix); anything else is refused. */
export function parseBaseUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Jira serverInfo has no baseUrl');
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error(`Jira baseUrl must use https, got ${url.protocol}`);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function siteLinks(baseUrl: string): SiteLinks {
  const base = parseBaseUrl(baseUrl);
  return {
    issue: (issueKey) => `${base}/browse/${encodeURIComponent(issueKey)}`,
    page: (pageId) => `${base}/wiki/pages/viewpage.action?pageId=${encodeURIComponent(pageId)}`,
  };
}

/** A contract links to its deliverable issue (or the source issue while there is none). */
export function contractLinks(
  links: SiteLinks,
  contract: { sourceIssueKey: string; deliverableIssueKey: string | null },
): { url: string; sourceIssueUrl: string; deliverableIssueUrl: string | null } {
  const deliverableIssueUrl = contract.deliverableIssueKey ? links.issue(contract.deliverableIssueKey) : null;
  return { url: deliverableIssueUrl ?? links.issue(contract.sourceIssueKey), sourceIssueUrl: links.issue(contract.sourceIssueKey), deliverableIssueUrl };
}

/** A request lives in the deal sheet on its source issue. */
export function requestLinks(links: SiteLinks, sourceIssueKey: string): { url: string; sourceIssueUrl: string } {
  const url = links.issue(sourceIssueKey);
  return { url, sourceIssueUrl: url };
}
