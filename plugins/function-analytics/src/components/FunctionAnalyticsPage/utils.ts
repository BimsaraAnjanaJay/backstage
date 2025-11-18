/*
 * Copyright 2025 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Extracts a clean function name from Jaeger operation names
 * Handles various microservice patterns (REST, gRPC, message queues, etc.)
 */
export const extractGeneralFunctionName = (operationName: string, spanTags: any[]): string => {
  const patterns = [
    // Node.js Express microservice routes
    /^(GET|POST|PUT|DELETE|PATCH) \/api\/([^\/]+)\/([^\/\?]+)/i,
    /^(GET|POST|PUT|DELETE|PATCH) \/([^\/]+)\/([^\/\?]+)/i,
    // Java Spring Boot microservices
    /^([A-Za-z0-9]+Controller)\.([A-Za-z0-9]+)/,
    /^([A-Za-z0-9]+Service)\.([A-Za-z0-9]+)/,
    // Python Flask/FastAPI microservices
    /^([a-z_]+)\.([a-z_]+)/,
    /^([a-z_]+)_([a-z_]+)/,
    // gRPC microservice methods
    /^\/([A-Za-z0-9.]+)\/([A-Za-z0-9]+)/,
    /^([A-Za-z0-9]+)\.([A-Za-z0-9]+)/,
    // Database operations in microservices
    /^(SELECT|INSERT|UPDATE|DELETE)\s+([A-Za-z0-9_]+)/i,
    // Microservice internal function calls
    /^([A-Za-z0-9]+)::([A-Za-z0-9]+)/,
    // REST client calls between microservices
    /^(GET|POST|PUT|DELETE|PATCH)\s+([A-Za-z0-9]+)\/([A-Za-z0-9]+)/i,
    // Message queue operations
    /^(publish|consume|process)\s+([A-Za-z0-9_]+)/i,
    // Event handling
    /^(handle|process|on)\s+([A-Za-z0-9_]+)/i,
  ];

  for (const pattern of patterns) {
    const match = operationName.match(pattern);
    if (match) {
      return match[match.length - 1] || match[0];
    }
  }

  const functionTag = spanTags.find(tag => 
    tag.key === 'function.name' || 
    tag.key === 'code.function' || 
    tag.key === 'method.name' ||
    tag.key === 'handler.name' ||
    tag.key === 'endpoint.name' ||
    tag.key === 'operation.name'
  );
  
  if (functionTag) {
    return String(functionTag.value);
  }

  const httpPattern = /^(GET|POST|PUT|DELETE|PATCH)\s+(.+)/i;
  const httpMatch = operationName.match(httpPattern);
  if (httpMatch) {
    const path = httpMatch[2];
    const pathParts = path.split('/').filter(part => part && part !== 'api');
    if (pathParts.length > 0) {
      return pathParts[pathParts.length - 1];
    }
  }

  return operationName
    .replace(/^(GET|POST|PUT|DELETE|PATCH)\s+/i, '')
    .replace(/^[A-Za-z0-9]+\s+/, '')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '') || 'unknown_function';
};
