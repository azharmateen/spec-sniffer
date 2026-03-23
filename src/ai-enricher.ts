import OpenAI from 'openai';
import { EndpointInfo } from './schema-builder';

export interface EnrichmentResult {
  descriptions: Map<string, string>;
  tags: Map<string, string[]>;
}

const ENRICHMENT_PROMPT = `You are an API documentation expert. Given these discovered API endpoints, provide human-readable descriptions.

## Discovered Endpoints

{endpoints}

---

For each endpoint, provide a clear, concise description of what it does based on:
- The HTTP method and path
- Request body structure (if any)
- Response body structure (if any)
- Query parameters (if any)

Respond as a JSON object where keys are "METHOD /path" and values are description strings.
Example: {"GET /api/users": "List all users with optional pagination", "POST /api/users": "Create a new user account"}

Respond ONLY with the JSON object.`;

function summarizeEndpoint(endpoint: EndpointInfo): string {
  const lines: string[] = [];
  lines.push(`${endpoint.method} ${endpoint.pathTemplate}`);

  if (endpoint.queryParams.size > 0) {
    const params = Array.from(endpoint.queryParams.values())
      .map((p) => `${p.name}(${p.type})`)
      .join(', ');
    lines.push(`  Query: ${params}`);
  }

  if (endpoint.requestSchema) {
    const fields = endpoint.requestSchema.properties
      ? Object.keys(endpoint.requestSchema.properties).join(', ')
      : 'unknown';
    lines.push(`  Request body fields: ${fields}`);
  }

  for (const [status, schema] of endpoint.responseSchemas) {
    const fields = schema.properties
      ? Object.keys(schema.properties).join(', ')
      : schema.type;
    lines.push(`  Response ${status}: ${fields}`);
  }

  lines.push(`  Samples: ${endpoint.requests.length}`);
  return lines.join('\n');
}

export async function enrichEndpoints(
  apiKey: string,
  endpoints: Map<string, EndpointInfo>,
  model: string = 'gpt-4o-mini'
): Promise<EnrichmentResult> {
  const openai = new OpenAI({ apiKey });

  // Build endpoint summaries
  const summaries = Array.from(endpoints.values())
    .map(summarizeEndpoint)
    .join('\n\n');

  const prompt = ENRICHMENT_PROMPT.replace('{endpoints}', summaries);

  const response = await openai.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 4096,
    temperature: 0.2,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return { descriptions: new Map(), tags: new Map() };
  }

  // Parse JSON response
  let jsonStr = content.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  const descriptions = new Map<string, string>();
  const tags = new Map<string, string[]>();

  try {
    const parsed = JSON.parse(jsonStr);
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') {
        descriptions.set(key, value);
      } else if (typeof value === 'object' && value !== null) {
        const obj = value as any;
        if (obj.description) descriptions.set(key, obj.description);
        if (obj.tags) tags.set(key, obj.tags);
      }
    }
  } catch {
    // If parsing fails, use raw text as description for all endpoints
    console.warn('Warning: Failed to parse AI enrichment response');
  }

  return { descriptions, tags };
}
