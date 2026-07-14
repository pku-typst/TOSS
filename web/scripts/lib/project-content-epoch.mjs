export async function projectContentEpochHeader(baseUrl, method, route, token) {
  if (method.toUpperCase() !== "PUT" || !token) return {};
  const match = route.match(/^\/v1\/projects\/([^/]+)\/documents\/by-path\//);
  if (!match) return {};
  const projectId = match[1];
  const response = await fetch(`${baseUrl}/v1/projects/${projectId}/tree`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GET project tree failed (${response.status}): ${text}`);
  }
  const tree = text.trim() ? JSON.parse(text) : null;
  if (!Number.isInteger(tree?.content_epoch)) {
    throw new Error("Project tree response is missing content_epoch");
  }
  return { "x-project-content-epoch": String(tree.content_epoch) };
}
