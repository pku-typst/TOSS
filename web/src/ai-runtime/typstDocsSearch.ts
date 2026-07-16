export const TYPST_DOCS_VERSION = "0.15.0" as const;
export const TYPST_DOCS_TOOL_NAME = "query_typst_docs" as const;

const DEFAULT_RESULT_LIMIT = 5;
const MAX_RESULT_LIMIT = 8;
const MAX_RESULT_CHARACTERS = 16_384;
const MAX_PARAMETERS_PER_RESULT = 32;

type TypstApiParameter = {
  name: string;
  types: string[];
  required: boolean;
  default?: string;
  strings?: string[];
};

type TypstApiEntry = {
  name: string;
  category: string;
  kind: "function" | "method" | "constructor" | "type" | "symbol";
  oneliner: string;
  params: TypstApiParameter[];
  returns: string[];
  route: string;
  weight: number;
  contextual?: boolean;
  element?: boolean;
  value?: string;
};

type TypstBm25Index = {
  meta: {
    num_docs: number;
    avg_dl: number;
    k1: number;
    b: number;
  };
  idf: Record<string, number>;
  postings: Record<string, Array<[number, number]>>;
  doc_lengths: Record<string, number>;
};

type TypstRecipe = {
  id: string;
  title: string;
  summary: string;
  keywords: string[];
  example: string;
  notes: string[];
  sourceRoute: string;
};

export type TypstDocsQueryResult = {
  version: typeof TYPST_DOCS_VERSION;
  query: string;
  results: Array<Record<string, unknown>>;
  truncated: boolean;
};

let dataPromise: Promise<{
  api: TypstApiEntry[];
  bm25: TypstBm25Index;
  recipes: TypstRecipe[];
}> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadData() {
  if (!dataPromise) {
    dataPromise = Promise.all([
      import("@/ai-runtime/typst-docs/api-0.15.0.json"),
      import("@/ai-runtime/typst-docs/api-0.15.0-bm25.json"),
      import("@/ai-runtime/typst-docs/recipes.json"),
      import("@/ai-runtime/typst-docs/manifest.json")
    ]).then(([apiModule, bm25Module, recipesModule, manifestModule]) => {
      const api: unknown = apiModule.default;
      const bm25: unknown = bm25Module.default;
      const recipes: unknown = recipesModule.default;
      const manifest: unknown = manifestModule.default;
      if (
        !Array.isArray(api) ||
        !Array.isArray(recipes) ||
        !isRecord(bm25) ||
        !isRecord(bm25.meta) ||
        !isRecord(manifest) ||
        manifest.typst_language_version !== TYPST_DOCS_VERSION ||
        bm25.meta.num_docs !== api.length
      ) throw new Error("typst_docs_index_invalid");
      return {
        api: api as TypstApiEntry[],
        bm25: bm25 as unknown as TypstBm25Index,
        recipes: recipes as TypstRecipe[]
      };
    });
  }
  return dataPromise;
}

export async function preloadTypstDocs(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  await loadData();
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function tokens(value: string) {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function apiScores(query: string, api: TypstApiEntry[], bm25: TypstBm25Index) {
  const scores = new Map<number, number>();
  for (const token of tokens(query)) {
    const idf = bm25.idf[token] ?? 0;
    if (idf === 0) continue;
    for (const [docId, frequency] of bm25.postings[token] ?? []) {
      if (!Number.isSafeInteger(docId) || docId < 0 || docId >= api.length) continue;
      const rawLength = bm25.doc_lengths[String(docId)] ?? bm25.meta.avg_dl;
      const documentLength = Math.min(rawLength, bm25.meta.avg_dl * 3);
      const numerator = frequency * (bm25.meta.k1 + 1);
      const denominator = frequency + bm25.meta.k1 * (
        1 - bm25.meta.b + bm25.meta.b * documentLength / bm25.meta.avg_dl
      );
      scores.set(docId, (scores.get(docId) ?? 0) + idf * numerator / denominator);
    }
  }

  const normalizedQuery = query.trim().toLowerCase();
  for (let index = 0; index < api.length; index += 1) {
    const name = api[index].name.toLowerCase();
    const exactBoost = name === normalizedQuery
      ? 100
      : name.startsWith(normalizedQuery)
        ? 20
        : name.includes(normalizedQuery)
          ? 8
          : 0;
    if (exactBoost > 0) scores.set(index, (scores.get(index) ?? 0) + exactBoost);
  }
  return Array.from(scores, ([index, score]) => ({
    source: "api" as const,
    index,
    score: score * (api[index].weight || 1)
  }));
}

function recipeScores(query: string, recipes: TypstRecipe[]) {
  const queryTokens = tokens(query);
  const normalizedQuery = query.trim().toLowerCase();
  return recipes.flatMap((recipe, index) => {
    const title = recipe.title.toLowerCase();
    const fields = [
      recipe.id,
      recipe.title,
      recipe.summary,
      recipe.keywords.join(" "),
      recipe.notes.join(" ")
    ].join(" ").toLowerCase();
    const matches = queryTokens.filter((token) => fields.includes(token)).length;
    if (matches === 0) return [];
    const exactBoost = recipe.id === normalizedQuery || title === normalizedQuery ? 100 : 0;
    return [{
      source: "recipe" as const,
      index,
      score: exactBoost + 12 + matches * 12 + (matches === queryTokens.length ? 12 : 0)
    }];
  });
}

function bounded(value: string, maximum: number) {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function apiResult(entry: TypstApiEntry) {
  const parameters = entry.params.slice(0, MAX_PARAMETERS_PER_RESULT).map((parameter) => ({
    name: bounded(parameter.name, 64),
    types: parameter.types.slice(0, 12).map((type) => bounded(type, 64)),
    required: parameter.required,
    ...(parameter.default === undefined ? {} : { default: bounded(parameter.default, 128) }),
    ...(parameter.strings?.length ? {
      values: parameter.strings.slice(0, 16).map((value) => bounded(value, 128)),
      values_truncated: parameter.strings.length > 16
    } : {})
  }));
  return {
    kind: entry.kind,
    name: entry.name,
    category: entry.category,
    summary: bounded(entry.oneliner, 512),
    parameters,
    parameters_truncated: entry.params.length > parameters.length,
    returns: entry.returns.slice(0, 12),
    contextual: entry.contextual ?? false,
    element: entry.element ?? false,
    ...(entry.value === undefined ? {} : { value: bounded(entry.value, 128) }),
    source_url: `https://typst.app/docs${entry.route}`
  };
}

function recipeResult(recipe: TypstRecipe) {
  return {
    kind: "recipe",
    name: recipe.id,
    title: recipe.title,
    summary: recipe.summary,
    example: recipe.example,
    notes: recipe.notes,
    source_url: `https://typst.app/docs${recipe.sourceRoute}`
  };
}

export async function queryTypstDocs(
  query: string,
  limit = DEFAULT_RESULT_LIMIT,
  signal?: AbortSignal
): Promise<TypstDocsQueryResult> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const normalizedQuery = query.trim().slice(0, 256);
  const boundedLimit = Math.max(1, Math.min(MAX_RESULT_LIMIT, Math.trunc(limit)));
  if (!normalizedQuery || tokens(normalizedQuery).length === 0) {
    return { version: TYPST_DOCS_VERSION, query: normalizedQuery, results: [], truncated: false };
  }
  const { api, bm25, recipes } = await loadData();
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const candidates = [
    ...recipeScores(normalizedQuery, recipes),
    ...apiScores(normalizedQuery, api, bm25)
  ].sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = candidates.slice(0, boundedLimit).map((candidate) => candidate.source === "recipe"
    ? recipeResult(recipes[candidate.index])
    : apiResult(api[candidate.index]));
  let truncated = candidates.length > selected.length;
  const response: TypstDocsQueryResult = {
    version: TYPST_DOCS_VERSION,
    query: normalizedQuery,
    results: selected,
    truncated
  };
  while (response.results.length > 0 && JSON.stringify(response).length > MAX_RESULT_CHARACTERS) {
    response.results.pop();
    truncated = true;
    response.truncated = true;
  }
  return response;
}
