// AnswerSense: Forms Backend
// Placeholder implementation

import { version } from './Shared/Version';
import { startBackendServer } from './Api/Server';

console.log(`Backend version: ${version}`);

export const backendReady = true;

startBackendServer();
