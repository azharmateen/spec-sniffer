import YAML from 'yaml';
import { EndpointInfo, JsonSchema } from './schema-builder';

export interface OpenAPISpec {
  openapi: string;
  info: {
    title: string;
    version: string;
    description: string;
  };
  servers: Array<{ url: string; description: string }>;
  paths: Record<string, any>;
  components: {
    schemas: Record<string, any>;
  };
}

function schemaToOpenAPI(schema: JsonSchema): any {
  const result: any = { type: schema.type };

  if (schema.format) result.format = schema.format;
  if (schema.nullable) result.nullable = true;
  if (schema.example !== undefined) result.example = schema.example;
  if (schema.enum) result.enum = schema.enum;

  if (schema.type === 'object' && schema.properties) {
    result.properties = {};
    for (const [key, prop] of Object.entries(schema.properties)) {
      result.properties[key] = schemaToOpenAPI(prop);
    }
    if (schema.required && schema.required.length > 0) {
      result.required = schema.required;
    }
  }

  if (schema.type === 'array' && schema.items) {
    result.items = schemaToOpenAPI(schema.items);
  }

  return result;
}

function sanitizeSchemaName(method: string, path: string): string {
  const segments = path.split('/').filter((s) => s && !s.startsWith('{'));
  const name = segments
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
  return `${method.charAt(0).toUpperCase() + method.slice(1).toLowerCase()}${name || 'Root'}`;
}

function statusCodeDescription(status: number): string {
  const descriptions: Record<number, string> = {
    200: 'Successful response',
    201: 'Created',
    204: 'No content',
    400: 'Bad request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not found',
    409: 'Conflict',
    422: 'Validation error',
    500: 'Internal server error',
  };
  return descriptions[status] || `Response ${status}`;
}

export function generateOpenAPISpec(
  endpoints: Map<string, EndpointInfo>,
  baseUrl: string,
  title?: string,
  descriptions?: Map<string, string>
): OpenAPISpec {
  const parsedUrl = new URL(baseUrl);
  const spec: OpenAPISpec = {
    openapi: '3.0.3',
    info: {
      title: title || `${parsedUrl.hostname} API`,
      version: '1.0.0',
      description: `API specification reverse-engineered from ${baseUrl} by spec-sniffer`,
    },
    servers: [
      {
        url: `${parsedUrl.protocol}//${parsedUrl.host}`,
        description: 'Discovered server',
      },
    ],
    paths: {},
    components: {
      schemas: {},
    },
  };

  // Group endpoints by path
  const pathGroups = new Map<string, EndpointInfo[]>();
  for (const endpoint of endpoints.values()) {
    const path = endpoint.pathTemplate;
    if (!pathGroups.has(path)) {
      pathGroups.set(path, []);
    }
    pathGroups.get(path)!.push(endpoint);
  }

  // Build paths
  for (const [path, pathEndpoints] of pathGroups) {
    const pathItem: any = {};

    for (const endpoint of pathEndpoints) {
      const method = endpoint.method.toLowerCase();
      const operation: any = {
        summary: descriptions?.get(`${endpoint.method} ${endpoint.pathTemplate}`) || `${endpoint.method} ${endpoint.pathTemplate}`,
        operationId: `${method}${sanitizeSchemaName(method, path)}`,
        responses: {},
      };

      // Add tags from first path segment
      const firstSegment = path.split('/').filter((s) => s && !s.startsWith('{'))[0];
      if (firstSegment) {
        operation.tags = [firstSegment];
      }

      // Path parameters
      const pathParams = (path.match(/\{(\w+)\}/g) || []).map((p) => p.slice(1, -1));
      if (pathParams.length > 0) {
        operation.parameters = operation.parameters || [];
        for (const param of pathParams) {
          operation.parameters.push({
            name: param,
            in: 'path',
            required: true,
            schema: { type: 'string' },
          });
        }
      }

      // Query parameters
      if (endpoint.queryParams.size > 0) {
        operation.parameters = operation.parameters || [];
        for (const [, param] of endpoint.queryParams) {
          const examples = Array.from(param.examples);
          operation.parameters.push({
            name: param.name,
            in: 'query',
            required: param.required,
            schema: {
              type: param.type,
              ...(examples.length === 1 ? { example: examples[0] } : {}),
            },
          });
        }
      }

      // Request body
      if (endpoint.requestSchema && ['POST', 'PUT', 'PATCH'].includes(endpoint.method)) {
        const schemaName = `${sanitizeSchemaName(method, path)}Request`;
        spec.components.schemas[schemaName] = schemaToOpenAPI(endpoint.requestSchema);

        operation.requestBody = {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: `#/components/schemas/${schemaName}` },
            },
          },
        };
      }

      // Responses
      if (endpoint.responseSchemas.size > 0) {
        for (const [status, schema] of endpoint.responseSchemas) {
          const schemaName = `${sanitizeSchemaName(method, path)}Response${status}`;
          spec.components.schemas[schemaName] = schemaToOpenAPI(schema);

          operation.responses[String(status)] = {
            description: statusCodeDescription(status),
            content: {
              'application/json': {
                schema: { $ref: `#/components/schemas/${schemaName}` },
              },
            },
          };
        }
      } else {
        // Default response
        operation.responses['200'] = {
          description: 'Successful response',
        };
      }

      pathItem[method] = operation;
    }

    spec.paths[path] = pathItem;
  }

  return spec;
}

export function specToYAML(spec: OpenAPISpec): string {
  return YAML.stringify(spec, {
    indent: 2,
    lineWidth: 0,
    minContentWidth: 0,
  });
}

export function specToJSON(spec: OpenAPISpec): string {
  return JSON.stringify(spec, null, 2);
}
