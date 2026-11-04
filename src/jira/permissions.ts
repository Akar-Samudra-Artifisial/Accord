import { route } from '@forge/api';
import { jira } from '../atlassian/http';

export type JiraPermission = 'ADMINISTER_PROJECTS' | 'BROWSE_PROJECTS' | 'ADD_COMMENTS';

interface MyPermissionsResponse {
  permissions: Record<string, { havePermission?: boolean } | undefined>;
}

/**
 * Permissions of the signed-in user (`asUser`) for one project or one issue
 * (`GET /rest/api/3/mypermissions`). Keys must be validated by the caller.
 */
export async function myPermissions(
  scope: { projectKey: string } | { issueKey: string },
  permissions: readonly JiraPermission[],
): Promise<Set<JiraPermission>> {
  const list = permissions.join(',');
  const path =
    'projectKey' in scope
      ? route`/rest/api/3/mypermissions?projectKey=${scope.projectKey}&permissions=${list}`
      : route`/rest/api/3/mypermissions?issueKey=${scope.issueKey}&permissions=${list}`;
  const response = await jira<MyPermissionsResponse>(path, { as: 'user' });
  return new Set(permissions.filter((permission) => response.permissions[permission]?.havePermission === true));
}
