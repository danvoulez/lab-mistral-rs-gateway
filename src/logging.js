import fs from 'node:fs';
import { projectPath } from './config.js';

const requestLog = projectPath('logs/gateway-requests.jsonl');

export function writeRequestEvent(event) {
  fs.mkdirSync(projectPath('logs'), { recursive: true });
  fs.appendFile(
    requestLog,
    `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`,
    () => {}
  );
}
