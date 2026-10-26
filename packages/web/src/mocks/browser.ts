import { setupWorker } from 'msw/browser';
import { handlers, mockDb } from './handlers';
import { createMockLiveSource } from './live';

export const worker = setupWorker(...handlers);
export const mockLiveSource = createMockLiveSource(mockDb);
