import { route } from '@forge/api';
import { jira, type Principal } from '../atlassian/http';

export type JiraPermission =
  | 'ADMINISTER'
  | 'ADMINISTER_PROJECTS'
  | 'BROWSE_PROJECTS'
  | 'ADD_COMMENTS'
  | 'SCHEDULE_ISSUES'
  | 'CREATE_ISSUES'
  | 'LINK_ISSUES';

interface MyPermissionsResponse {
  permissions: Record<string, { havePermission?: boolean } | undefined>;
}

/**
 * Permissions of the signed-in user (`asUser`; the app itself for `as: 'app'`) for one project or
 * one issue (`GET /rest/api/3/mypermissions`). Keys must be validated by the caller.
 */
export async function myPermissions(
  scope: { projectKey: string } | { issueKey: string } | { global: true },
  permissions: readonly JiraPermission[],
  as: Principal = 'user',
): Promise<Set<JiraPermission>> {
  const list = permissions.join(',');
  const path =
    'projectKey' in scope
      ? route`/rest/api/3/mypermissions?projectKey=${scope.projectKey}&permissions=${list}`
      : 'issueKey' in scope
        ? route`/rest/api/3/mypermissions?issueKey=${scope.issueKey}&permissions=${list}`
        : route`/rest/api/3/mypermissions?permissions=${list}`;
  const response = await jira<MyPermissionsResponse>(path, { as });
  return new Set(permissions.filter((permission) => response.permissions[permission]?.havePermission === true));
}

interface BulkPermissionsResponse {
  projectPermissions?: Array<{ permission: string; projects?: number[] }>;
}

/**
 * Project permissions another account holds (`POST /rest/api/3/permissions/check` with `accountId`,
 * called as the app). Returns the permissions held on the project with id `projectId`.
 */
export async function accountProjectPermissions(
  accountId: string,
  projectId: string,
  permissions: readonly JiraPermission[],
): Promise<Set<JiraPermission>> {
  const id = Number(projectId);
  const response = await jira<BulkPermissionsResponse>(route`/rest/api/3/permissions/check`, {
    method: 'POST',
    as: 'app',
    body: { accountId, projectPermissions: [{ permissions, projects: [id] }] },
  });
  const held = new Set<JiraPermission>();
  for (const entry of response.projectPermissions ?? []) {
    const permission = permissions.find((candidate) => candidate === entry.permission);
    if (permission && (entry.projects ?? []).includes(id)) held.add(permission);
  }
  return held;
}
