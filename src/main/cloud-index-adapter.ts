






export interface CloudIndexHit {
  source: "cloud";
  docId: string;
  docName: string;

  snippet: string;

  url?: string;

  score: number;
}




export interface CloudIndexAdapter {



  search(query: string, topK: number): Promise<CloudIndexHit[]>;




  isAvailable(): Promise<boolean>;
}






export class MockCloudIndexAdapter implements CloudIndexAdapter {
  async search(_query: string, _topK: number): Promise<CloudIndexHit[]> {

    return [];
  }

  async isAvailable(): Promise<boolean> {
    return false;
  }
}
