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

import { TraceSourceAdapter } from './TraceSourceAdapter';
import { JaegerAdapter } from './JaegerAdapter';
import { ZipkinAdapter } from './ZipkinAdapter';

/**
 * Registry that maps backend type strings to TraceSourceAdapter instances.
 *
 * Built-in adapters are registered automatically. External teams can
 * register custom adapters for additional tracing backends.
 */
class AdapterRegistryImpl {
  private adapters = new Map<string, TraceSourceAdapter>();

  constructor() {
    // Register built-in adapters
    this.register(new JaegerAdapter());
    this.register(new ZipkinAdapter());
  }

  /** Register a custom adapter. Overwrites any existing adapter for the same type. */
  register(adapter: TraceSourceAdapter): void {
    this.adapters.set(adapter.type, adapter);
  }

  /** Get an adapter by backend type. Falls back to Jaeger if type is unknown. */
  get(type: string): TraceSourceAdapter {
    return this.adapters.get(type) || this.adapters.get('jaeger')!;
  }

  /** List all registered adapter types. */
  listTypes(): string[] {
    return Array.from(this.adapters.keys());
  }

  /** Clear caches on all registered adapters. */
  clearAllCaches(): void {
    for (const adapter of this.adapters.values()) {
      adapter.clearCache();
    }
  }
}

/** Singleton adapter registry. */
export const AdapterRegistry = new AdapterRegistryImpl();
