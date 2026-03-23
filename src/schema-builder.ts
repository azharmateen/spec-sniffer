import { CapturedRequest } from './interceptor';

export interface EndpointInfo {
  method: string;
  path: string;
  pathTemplate: string;
  requests: EndpointSample[];
  queryParams: Map<string, ParamInfo>;
  requestSchema: JsonSchema | null;
  responseSchemas: Map<number, JsonSchema>;
}

export interface EndpointSample {
  query: Record<string, string>;
  requestBody: any | null;
  responseBody: any | null;
  responseStatus: number;
  contentType: string;
}

export interface ParamInfo {
  name: string;
  required: boolean;
  examples: Set<string>;
  type: string;
}

export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  example?: any;
  enum?: any[];
  format?: string;
  nullable?: boolean;
}

// Detect path parameters: /users/123 -> /users/{id}
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_ID_PATTERN = /^\d+$/;
const MONGO_ID_PATTERN = /^[0-9a-f]{24}$/i;

function isPathParam(segment: string): boolean {
  return (
    UUID_PATTERN.test(segment) ||
    NUMERIC_ID_PATTERN.test(segment) ||
    MONGO_ID_PATTERN.test(segment)
  );
}

function paramNameFromContext(prevSegment: string | undefined): string {
  if (!prevSegment) return 'id';
  // /users/123 -> userId, /posts/abc -> postId
  const singular = prevSegment.endsWith('s') ? prevSegment.slice(0, -1) : prevSegment;
  return `${singular}Id`;
}

function templatizePath(path: string): string {
  const segments = path.split('/');
  return segments
    .map((seg, i) => {
      if (isPathParam(seg)) {
        return `{${paramNameFromContext(segments[i - 1])}}`;
      }
      return seg;
    })
    .join('/');
}

function inferType(value: any): string {
  if (value === null || value === undefined) return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return 'string'; // date-time format
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'string'; // date format
    if (/^[^@]+@[^@]+\.[^@]+$/.test(value)) return 'string'; // email format
    if (UUID_PATTERN.test(value)) return 'string'; // uuid format
    return 'string';
  }
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  return 'string';
}

function inferFormat(value: any): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return 'date-time';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'date';
  if (/^[^@]+@[^@]+\.[^@]+$/.test(value)) return 'email';
  if (UUID_PATTERN.test(value)) return 'uuid';
  if (/^https?:\/\//.test(value)) return 'uri';
  return undefined;
}

export function buildJsonSchema(value: any, depth: number = 0): JsonSchema {
  if (depth > 10) return { type: 'object' }; // Prevent infinite recursion

  if (value === null || value === undefined) {
    return { type: 'string', nullable: true };
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return { type: 'array', items: { type: 'object' } };
    }
    // Use first element as template
    return {
      type: 'array',
      items: buildJsonSchema(value[0], depth + 1),
    };
  }

  if (typeof value === 'object') {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];

    for (const [key, val] of Object.entries(value)) {
      properties[key] = buildJsonSchema(val, depth + 1);
      if (val !== null && val !== undefined) {
        required.push(key);
      }
    }

    const schema: JsonSchema = { type: 'object', properties };
    if (required.length > 0) {
      schema.required = required;
    }
    return schema;
  }

  const type = inferType(value);
  const format = inferFormat(value);
  const schema: JsonSchema = { type, example: value };
  if (format) schema.format = format;
  return schema;
}

function mergeSchemas(a: JsonSchema, b: JsonSchema): JsonSchema {
  if (a.type !== b.type) {
    // Types differ; use the non-null one or default to string
    if (a.type === 'string' && a.nullable) return b;
    if (b.type === 'string' && b.nullable) return a;
    return a; // Keep first
  }

  if (a.type === 'object' && b.type === 'object') {
    const merged: JsonSchema = { type: 'object', properties: {} };
    const allKeys = new Set([
      ...Object.keys(a.properties || {}),
      ...Object.keys(b.properties || {}),
    ]);

    for (const key of allKeys) {
      const aProp = a.properties?.[key];
      const bProp = b.properties?.[key];

      if (aProp && bProp) {
        merged.properties![key] = mergeSchemas(aProp, bProp);
      } else {
        merged.properties![key] = (aProp || bProp)!;
      }
    }

    // Required = intersection (present in both)
    const aReq = new Set(a.required || []);
    const bReq = new Set(b.required || []);
    const required = [...aReq].filter((k) => bReq.has(k));
    if (required.length > 0) merged.required = required;

    return merged;
  }

  if (a.type === 'array' && b.type === 'array' && a.items && b.items) {
    return { type: 'array', items: mergeSchemas(a.items, b.items) };
  }

  return a; // Keep first for primitives
}

export function buildEndpoints(requests: CapturedRequest[]): Map<string, EndpointInfo> {
  const endpoints = new Map<string, EndpointInfo>();

  for (const req of requests) {
    const pathTemplate = templatizePath(req.path);
    const key = `${req.method} ${pathTemplate}`;

    if (!endpoints.has(key)) {
      endpoints.set(key, {
        method: req.method,
        path: req.path,
        pathTemplate,
        requests: [],
        queryParams: new Map(),
        requestSchema: null,
        responseSchemas: new Map(),
      });
    }

    const endpoint = endpoints.get(key)!;

    // Collect sample
    endpoint.requests.push({
      query: req.query,
      requestBody: req.requestBody,
      responseBody: req.responseBody,
      responseStatus: req.responseStatus,
      contentType: req.contentType,
    });

    // Track query parameters
    for (const [name, value] of Object.entries(req.query)) {
      if (!endpoint.queryParams.has(name)) {
        endpoint.queryParams.set(name, {
          name,
          required: false,
          examples: new Set(),
          type: inferType(value),
        });
      }
      endpoint.queryParams.get(name)!.examples.add(value);
    }

    // Build/merge request schema
    if (req.requestBody && typeof req.requestBody === 'object') {
      const schema = buildJsonSchema(req.requestBody);
      endpoint.requestSchema = endpoint.requestSchema
        ? mergeSchemas(endpoint.requestSchema, schema)
        : schema;
    }

    // Build/merge response schema per status code
    if (req.responseBody && typeof req.responseBody === 'object') {
      const schema = buildJsonSchema(req.responseBody);
      const existing = endpoint.responseSchemas.get(req.responseStatus);
      endpoint.responseSchemas.set(
        req.responseStatus,
        existing ? mergeSchemas(existing, schema) : schema
      );
    }
  }

  // Determine required query params (present in all requests)
  for (const endpoint of endpoints.values()) {
    const totalRequests = endpoint.requests.length;
    for (const [name, param] of endpoint.queryParams) {
      const count = endpoint.requests.filter((r) => name in r.query).length;
      param.required = count === totalRequests && totalRequests > 1;
    }
  }

  return endpoints;
}
