import {
  createApiRef,
  DiscoveryApi,
  FetchApi,
  // 1. Import IdentityApi
  IdentityApi,
} from '@backstage/core-plugin-api';

// ... (AnalysisResult interface)
export interface AnalysisResult {
  issuesFound: number;
  summary: string;
  // Add other relevant fields as needed
}

export interface CodeAnalysisApi {
  analyzeEntity(entityRef: string): Promise<AnalysisResult>;
}

export const codeAnalysisApiRef = createApiRef<CodeAnalysisApi>({
  id: 'plugin.code-analysis.service',
});

export class CodeAnalysisApiClient implements CodeAnalysisApi {
  private readonly discoveryApi: DiscoveryApi;
  private readonly fetchApi: FetchApi;
  // 2. Add identityApi
  private readonly identityApi: IdentityApi;

  constructor(options: {
    discoveryApi: DiscoveryApi;
    fetchApi: FetchApi;
    // 3. Add identityApi to constructor
    identityApi: IdentityApi;
  }) {
    this.discoveryApi = options.discoveryApi;
    this.fetchApi = options.fetchApi;
    this.identityApi = options.identityApi;
  }

  async analyzeEntity(entityRef: string): Promise<AnalysisResult> {
    const baseUrl = "http://localhost:7007/api/code-analysis-backend";
    
    // 4. Get the user's token
    const { token } = await this.identityApi.getCredentials();

    console.log('Using token:', token);
    console.log('Analyzing entityRef:', entityRef);
    console.log('Requesting analysis from:', `${baseUrl}/analyze`);

    const response = await this.fetchApi.fetch(`${baseUrl}/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 5. Add the Authorization header
        ...(token && { Authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ entityRef }),
    });

    if (!response.ok) {
      const text = await response.text();
      // This is line 43, where your error is thrown
      throw new Error(`Failed to analyze entity: ${response.status} ${text}`);
    }

    return await response.json();
  }
}