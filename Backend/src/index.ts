// AnswerSense: Forms Backend
// Placeholder implementation

import { version } from './Shared/Version.js';
import { startBackendServer } from './Api/Server.js';

console.log(`Backend version: ${version}`);

export const backendReady = true;

startBackendServer();
