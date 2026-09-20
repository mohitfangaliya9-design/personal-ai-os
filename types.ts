export type Risk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type TaskStatus = 'QUEUED' | 'PLANNING' | 'RUNNING' | 'WAITING_APPROVAL' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface Plan {
  summary: string;
  steps: { id: string; action: string; risk: Risk; requiresApproval: boolean }[];
  needsAI: boolean;
}
