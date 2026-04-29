export interface IncomingTask {
  externalId: string;
  source: string;
  title: string;
  body: string;
  url: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface TrackerProvider {
  readonly id: string;
  listIncomingTasks(filter?: Record<string, string>): AsyncIterable<IncomingTask>;
  getTask(externalId: string): Promise<IncomingTask>;
  postUpdate(externalId: string, body: string): Promise<void>;
  updateStatus(externalId: string, status: string): Promise<void>;
}
