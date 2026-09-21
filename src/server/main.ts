import { resolve } from 'node:path';
import { AppDatabase } from './database.js';
import { createAppServer } from './app.js';
import { seedDatabase } from './seed.js';

const hostArgIndex = process.argv.indexOf('--host');
const portArgIndex = process.argv.indexOf('--port');
const host = hostArgIndex >= 0 ? process.argv[hostArgIndex + 1] ?? '127.0.0.1' : '127.0.0.1';
const port = Number(portArgIndex >= 0 ? process.argv[portArgIndex + 1] ?? '5545' : process.env.PORT ?? '5545');
const databasePath = resolve(process.env.DEEMBED_DB ?? 'data/deembed.sqlite');
const publicDirectory = resolve('public');

const database = new AppDatabase(databasePath);
if (database.countNetworks() === 0) {
  await seedDatabase(database);
}

const server = createAppServer({ database, publicDirectory });
server.listen(port, host, () => {
  console.log(`参数面去嵌台: http://${host}:${port}`);
  console.log(`SQLite database: ${databasePath}`);
});
