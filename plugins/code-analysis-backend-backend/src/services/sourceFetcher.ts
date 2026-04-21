import {
  ANNOTATION_LOCATION,
  ANNOTATION_SOURCE_LOCATION,
  Entity,
} from '@backstage/catalog-model';
import { CatalogApi } from '@backstage/catalog-client';
import { CatalogClient } from '@backstage/catalog-client';
import { UrlReaderService } from '@backstage/backend-plugin-api';
import { Logger } from 'winston';
// Removed unused frontend imports: catalogApiRef, parseEntityRef, createApiRef, DiscoveryApi, FetchApi, IdentityApi

/**
 * Defines the services needed to fetch source code.
 * These are injected by your plugin's init function.
 */
export interface SourceCodeFetcherServices {
  catalog: CatalogApi;
  reader: UrlReaderService;
  logger: Logger;
  discovery: any;
  tokenManager: any;
}

/**
 * Defines the shape of a single source file.
 */
export interface SourceFile {
  path: string;
  content: string;
}

/**
 * Fetches all source code files for a given entity.
 *
 * @param entityRef - The entity reference, e.g., 'component:default/my-service'
 * @param services - The Catalog, Reader, and Logger services
 * @param token - Optional Backstage token for authentication
 * @returns A promise that resolves to an array of SourceFile objects
 */
export async function fetchSourceCodeForEntity(
  entityRef: string,
  services: SourceCodeFetcherServices,
  token?: string,
): Promise<SourceFile[]> {
  const { catalog, reader, logger, discovery, tokenManager } = services;

  // 1. Get Entity
  let entity: Entity | undefined;
  try {
    //
    // THIS IS THE FIX:
    // Use the CatalogApi client directly instead of manually fetching.
    // It's already authenticated and knows where the catalog backend is.
    //

    const catalogClient = new CatalogClient({
      discoveryApi: discovery,
      tokenManager,
    });

    console.log('Fetching entity for ref:', entityRef);
    console.log('Using token:', token);
    entity = await catalogClient.getEntityByRef(entityRef, { token });

  } catch (error) {
    logger.error(`Error fetching entity ${entityRef}: ${error}`);
    throw new Error(`Error fetching entity ${entityRef}: ${error.message}`);
  }

  if (!entity) {
    logger.warn(`Entity not found: ${entityRef}`);
    throw new Error(`Entity not found: ${entityRef}`);
  }

  // 2. Find Location
  const location =
    entity.metadata.annotations?.[ANNOTATION_SOURCE_LOCATION]
    entity.metadata.annotations?.[ANNOTATION_LOCATION];

  if (!location) {
    logger.warn(`Entity ${entityRef} has no source location annotation.`);
    throw new Error(`Entity ${entityRef} has no '${ANNOTATION_SOURCE_LOCATION}' or '${ANNOTATION_LOCATION}' annotation.`);
  }

  logger.info(`Found source location for ${entityRef}: ${location}`);

  // 3. Read Tree
  let tree;
  try {
    // Use the UrlReaderService to read the tree [cite: 46]
    tree = await reader.readTree(location); 
  } catch (error) {
    logger.error(`Failed to read tree from ${location}: ${error}`);
    throw new Error(`Failed to read tree from ${location}: ${error.message}`);
  }

  // 4. Get Content
  const files = await tree.files();
  const fileContents: SourceFile[] = [];

  for (const file of files) {
    try {
      const contentBuffer = await file.content();
      fileContents.push({
        path: file.path,
        content: contentBuffer.toString('utf-8'),
      });
    } catch (error) {
      logger.warn(`Failed to read content for file ${file.path}: ${error.message}`);
      // Skip this file and continue
    }
  }

  logger.info(`Fetched ${fileContents.length} files for ${entityRef}.`);
  
  // 5. Return Files
  return fileContents;
}