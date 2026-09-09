export type BlenderStatus = {
  recoverable?: {
    id: string;
    projectId: string;
    baseRevisionId: string;
    disconnectedAt: string;
  }[];
  installed: boolean;
  connected: boolean;
  state: "closed" | "opening" | "connected" | "disconnected" | "uncertain";
  projectId?: string;
  baseRevisionId?: string;
  sessionId?: string;
  error?: string;
};
