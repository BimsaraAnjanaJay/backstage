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

import { DiscoveredService } from '../discovery/ServiceDiscoveryEngine';

/**
 * Generates a PowerShell startup script for the given microservices.
 * Extracted verbatim from router.ts `generatePowerShellScript()`.
 */
export function generatePowerShellScript(
  repoName: string,
  services: DiscoveredService[],
): string {
  return `#!/usr/bin/env pwsh
Write-Host "🚀 Starting ${repoName} microservices with OpenTelemetry tracing" -ForegroundColor Cyan

# Start Docker Compose
Write-Host "📦 Starting services..." -ForegroundColor Yellow
docker-compose -f docker-compose.otel.yml up -d

# Wait for services
Write-Host "⏳ Waiting for services to start..." -ForegroundColor Yellow
Start-Sleep -Seconds 15

Write-Host "\\n✅ All services started!" -ForegroundColor Green
Write-Host "\\n📊 Access Points:" -ForegroundColor Cyan
Write-Host "  Jaeger UI: http://localhost:16686" -ForegroundColor White
${services
  .map(
    (s: DiscoveredService) =>
      `Write-Host "  ${s.name}: http://localhost:${s.port}" -ForegroundColor White`,
  )
  .join('\n')}
Write-Host "  Function Analytics: http://localhost:3000/function-analytics" -ForegroundColor White
`;
}

/**
 * Generates a Bash startup script for the given microservices.
 * Extracted verbatim from router.ts `generateBashScript()`.
 */
export function generateBashScript(
  repoName: string,
  services: DiscoveredService[],
): string {
  return `#!/bin/bash
echo "🚀 Starting ${repoName} microservices with OpenTelemetry tracing"

# Start Docker Compose
echo "📦 Starting services..."
docker-compose -f docker-compose.otel.yml up -d

# Wait for services
echo "⏳ Waiting for services to start..."
sleep 15

echo "✅ All services started!"
echo ""
echo "📊 Access Points:"
echo "  Jaeger UI: http://localhost:16686"
${services
  .map(
    (s: DiscoveredService) => `echo "  ${s.name}: http://localhost:${s.port}"`,
  )
  .join('\n')}
echo "  Function Analytics: http://localhost:3000/function-analytics"
`;
}
