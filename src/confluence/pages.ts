import { route } from '@forge/api';
import { confluence, type Principal } from '../atlassian/http';
import { CHARTER_LABEL } from './charter';

export interface Space {
  id: string;
  key: string;
  name: string;
  type: string;
  status?: string;
  homepageId?: string;
}

export interface Page {
  id: string;
  title: string;
  spaceId: string;
  version: { number: number };
  body?: { storage?: { value: string } };
  _links?: { webui?: string; base?: string };
}

interface MultiPage<T> {
  results: T[];
  _links?: { next?: string; base?: string };
}

export async function getSpaceByKey(key: string): Promise<Space | null> {
  const page = await confluence<MultiPage<Space>>(route`/wiki/api/v2/spaces?keys=${key}&limit=1`);
  return page.results[0] ?? null;
}

export async function listSpaces(limit = 25): Promise<Space[]> {
  const page = await confluence<MultiPage<Space>>(route`/wiki/api/v2/spaces?limit=${limit}`);
  return page.results;
}

export async function createSpace(key: string, name: string, as: Principal = 'app'): Promise<Space> {
  return confluence<Space>(route`/wiki/api/v2/spaces`, { method: 'POST', body: { key, name }, as });
}

export async function findPageByTitle(spaceId: string, title: string): Promise<Page | null> {
  const page = await confluence<MultiPage<Page>>(
    route`/wiki/api/v2/pages?space-id=${spaceId}&title=${title}&body-format=storage&limit=1`,
  );
  return page.results[0] ?? null;
}

export async function getPage(pageId: string, as: Principal = 'app'): Promise<Page> {
  return confluence<Page>(route`/wiki/api/v2/pages/${pageId}?body-format=storage`, { as });
}

export async function createPage(
  spaceId: string,
  title: string,
  storage: string,
  as: Principal = 'app',
): Promise<Page> {
  return confluence<Page>(route`/wiki/api/v2/pages`, {
    method: 'POST',
    as,
    body: { spaceId, status: 'current', title, body: { representation: 'storage', value: storage } },
  });
}

/** New version of an existing page (`version` = current version number). */
export async function updatePage(
  page: Pick<Page, 'id' | 'title'> & { version: { number: number } },
  storage: string,
  message: string,
  as: Principal = 'app',
): Promise<Page> {
  return confluence<Page>(route`/wiki/api/v2/pages/${page.id}`, {
    method: 'PUT',
    as,
    body: {
      id: page.id,
      status: 'current',
      title: page.title,
      body: { representation: 'storage', value: storage },
      version: { number: page.version.number + 1, message },
    },
  });
}

/** Labels are write-only in the v1 API. */
export async function addCharterLabel(pageId: string, as: Principal = 'app'): Promise<void> {
  await confluence<unknown>(route`/wiki/rest/api/content/${pageId}/label`, {
    method: 'POST',
    as,
    body: [{ prefix: 'global', name: CHARTER_LABEL }],
  });
}

export async function getPageLabels(pageId: string): Promise<string[]> {
  const page = await confluence<MultiPage<{ name: string }>>(route`/wiki/api/v2/pages/${pageId}/labels?limit=50`);
  return page.results.map((label) => label.name);
}

export function pageUrl(page: Page): string | undefined {
  const base = page._links?.base;
  const webui = page._links?.webui;
  return base && webui ? `${base}${webui}` : webui;
}
